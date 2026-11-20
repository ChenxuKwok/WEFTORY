import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { type Asset, FashionError, FeishuPhotoVideoSeconds, type Run,ShotDuration, ShotSource } from '../../shared/fashion/contracts';
import { fail } from './errors';
import type { FashionStore } from './store';

const exec = promisify(execFile);
const extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'video/mp4': 'mp4' };
const maxImageBytes = 10 * 1024 * 1024;
const maxClipBytes = 160 * 1024 * 1024;
const colors = ['0x252C42', '0x413953', '0x24433E', '0x503743', '0x37465C', '0x29344F'];
const normalization = 'scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p';

function imageMime(bytes: Buffer): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  return fail(FashionError.Media);
}

async function digest(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

type VideoProbe = { codec_type: string; codec_name: string; width: number; height: number; r_frame_rate: string };

export class FashionMedia {
  constructor(
    private readonly store: FashionStore,
    private readonly root: string,
    private readonly bundledTools?: string,
  ) {}

  private async tool(name: 'ffmpeg' | 'ffprobe'): Promise<string> {
    const candidates = this.bundledTools
      ? [path.join(this.bundledTools, name)]
      : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'].map(directory => path.join(directory, name));
    for (const candidate of candidates) {
      if (await access(candidate, constants.X_OK).then(() => true, () => false)) return candidate;
    }
    return fail(FashionError.Setup);
  }

  async check(): Promise<boolean> {
    try {
      const tools = await Promise.all([this.tool('ffmpeg'), this.tool('ffprobe')]);
      const [filters, encoders] = await Promise.all([
        exec(tools[0], ['-hide_banner', '-filters'], { timeout: 5000 }),
        exec(tools[0], ['-hide_banner', '-encoders'], { timeout: 5000 }),
        exec(tools[1], ['-version'], { timeout: 5000 }),
      ]);
      return /\bsubtitles\b/.test(filters.stdout) && /\blibx264\b/.test(encoders.stdout);
    } catch {
      return false;
    }
  }

  getPath(asset: Asset): string {
    const extension = extensions[asset.mime];
    if (!extension || !/^[a-f0-9]{64}$/.test(asset.sha256)) fail(FashionError.Media);
    return path.join(this.root, 'assets', `${asset.sha256}.${extension}`);
  }

  async verify(asset: Asset): Promise<string> {
    const file = this.getPath(asset);
    const stat = await lstat(file).catch((): null => null);
    if (!stat?.isFile() || await digest(file) !== asset.sha256) fail(FashionError.Media);
    return file;
  }

  async importImage(file: string, signal?: AbortSignal): Promise<Asset> {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > maxImageBytes || !stat.size) fail(FashionError.Media);
    const bytes = await readFile(file, { signal });
    return this.saveImage(bytes, signal);
  }

  async saveImage(bytes: Buffer, signal?: AbortSignal): Promise<Asset> {
    if (!bytes.length || bytes.length > maxImageBytes) fail(FashionError.Media);
    const mime = imageMime(bytes);
    return this.temporary(async cwd => {
      const file = path.join(cwd, `image.${extensions[mime]}`);
      await writeFile(file, bytes);
      const video = (await this.probe(file, signal)).streams[0];
      if (!video?.width || !video.height || video.width * video.height > 48_000_000
        || video.codec_name !== (mime === 'image/png' ? 'png' : 'mjpeg')) fail(FashionError.Media);
      return this.persist(file, mime, signal);
    });
  }

  async saveClip(bytes: Buffer, signal: AbortSignal): Promise<Asset> {
    if (bytes.length > maxClipBytes || bytes.toString('ascii', 4, 8) !== 'ftyp') fail(FashionError.Media);
    return this.temporary(async cwd => {
      const file = path.join(cwd, 'clip.mp4');
      await writeFile(file, bytes);
      const clip = await this.probe(file, signal);
      if (!clip.streams.some(stream => stream.codec_type === 'video' && stream.width > 0 && stream.height > 0)
        || !(Number(clip.format.duration) > 0)) fail(FashionError.Media);
      return this.persist(file, 'video/mp4', signal);
    });
  }

  async assemble(run: Run, signal: AbortSignal): Promise<Asset> {
    const binary = await this.tool('ffmpeg');
    return this.temporary(async cwd => {
      const parts: string[] = [];
      const subtitles: string[] = [];
      let start = 0;
      for (const [index, shot] of run.shots.entries()) {
        const duration = ShotDuration[index];
        const output = `segment-${index}.mp4`;
        const input = shot.source === ShotSource.Demo
          ? ['-f', 'lavfi', '-i', `color=c=${colors[(index + shot.attempt) % colors.length]}:s=1080x1920:r=30`]
          : shot.clip ? ['-i', await this.verify(shot.clip)]
            : ['-loop', '1', '-i', await this.verify(shot.frame ?? fail(FashionError.Media))];
        await this.run(binary, cwd, [...input, '-t', String(duration), '-vf',
          `${normalization},tpad=stop_mode=clone:stop_duration=${duration}`, '-map', '0:v:0',
          ...this.encoding(), output], signal);
        parts.push(`file '${output}'`);
        const caption = run.plan?.shots[index].caption.replace(/[<>\r\n{}\\]/g, ' ').trim();
        if (caption) {
          const timestamp = (seconds: number) => new Date(seconds * 1000).toISOString().slice(11, 23).replace('.', ',');
          subtitles.push(`${index + 1}\n${timestamp(start)} --> ${timestamp(start + duration)}\n${caption}\n`);
        }
        start += duration;
      }
      await writeFile(path.join(cwd, 'segments.txt'), parts.join('\n'));
      const args = ['-f', 'concat', '-safe', '1', '-i', 'segments.txt'];
      if (subtitles.length) {
        await writeFile(path.join(cwd, 'captions.srt'), subtitles.join('\n'));
        args.push('-vf', "subtitles=captions.srt:force_style='Fontname=PingFang SC,Fontsize=16,Outline=2,MarginV=38'");
        args.push(...this.encoding());
      } else {
        args.push('-c:v', 'copy');
      }
      await this.run(binary, cwd, [...args, '-movflags', '+faststart', 'final.mp4'], signal);
      const target = path.join(cwd, 'final.mp4');
      const { streams, format } = await this.probe(target, signal);
      const [video] = streams;
      if (streams.length !== 1 || !video || video.codec_name !== 'h264' || video.width !== 1080 || video.height !== 1920
        || video.r_frame_rate !== '30/1' || Math.abs(Number(format.duration) - start) > 0.1) fail(FashionError.Media);
      return this.persist(target, 'video/mp4', signal);
    });
  }

  async verifyPhotoVideo(asset: Asset, signal: AbortSignal): Promise<void> {
    const { streams, format } = await this.probe(await this.verify(asset), signal);
    const video = streams.find(stream => stream.codec_type === 'video');
    const duration = Number(format.duration);
    if (!video || !(video.width < video.height) || !Number.isFinite(duration)
      || Math.abs(duration - FeishuPhotoVideoSeconds) > 0.1) fail(FashionError.Media);
  }

  private encoding(): string[] {
    return ['-an', '-sn', '-dn', '-c:v', 'libx264', '-preset', 'veryfast',
      '-b:v', '5M', '-pix_fmt', 'yuv420p'];
  }

  private async probe(file: string, signal?: AbortSignal): Promise<{
    streams: VideoProbe[]; format: { duration?: string };
  }> {
    const binary = await this.tool('ffprobe');
    const result = await exec(binary, ['-v', 'error', '-protocol_whitelist', 'file',
      '-show_streams', '-show_format', '-of', 'json', file], { signal, timeout: 20_000 })
      .catch(() => fail(FashionError.Media));
    return JSON.parse(result.stdout) as { streams: VideoProbe[]; format: { duration?: string } };
  }

  private async run(binary: string, cwd: string, args: string[], signal: AbortSignal): Promise<void> {
    await exec(binary, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file',
      ...args], { cwd, signal, timeout: 180_000 }).catch(() => fail(FashionError.Media));
  }

  private async temporary<T>(fn: (directory: string) => Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const cwd = await mkdtemp(path.join(this.root, 'work-'));
    try {
      return await fn(cwd);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }

  private async persist(file: string, mime: string, signal?: AbortSignal): Promise<Asset> {
    const asset = { id: randomUUID(), sha256: await digest(file), mime };
    const target = this.getPath(asset);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${asset.id}.tmp`;
    try {
      await copyFile(file, temporary, constants.COPYFILE_EXCL);
      await rename(temporary, target);
      signal?.throwIfAborted();
      this.store.saveAsset(asset);
      return asset;
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
