'use strict';

const { execFileSync } = require('node:child_process');
const { accessSync, constants, readFileSync, statSync } = require('node:fs');
const { isAbsolute, join } = require('node:path');

function validateWeftoryMediaDirectory(directory) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || !directory || !isAbsolute(directory)) {
    throw new Error('WEFTORY macOS packaging requires Apple Silicon and an absolute WEFTORY_MEDIA_DIR.');
  }
  const ffmpeg = join(directory, 'ffmpeg');
  for (const executable of [ffmpeg, join(directory, 'ffprobe')]) {
    accessSync(executable, constants.X_OK);
    const architectures = execFileSync('/usr/bin/lipo', ['-archs', executable], { encoding: 'utf8', timeout: 5000 });
    if (!architectures.trim().split(/\s+/).includes('arm64')) throw new Error(`Missing arm64 slice in ${executable}`);
    const dylibs = execFileSync('/usr/bin/otool', ['-L', executable], { encoding: 'utf8', timeout: 5000 });
    if (dylibs.split('\n').slice(1).some(line => line.trim() && !/^\s*\/(usr\/lib|System\/Library)\//.test(line))) {
      throw new Error(`WEFTORY requires a standalone media binary: ${executable}`);
    }
  }

  const notice = join(directory, 'THIRD-PARTY-NOTICES.txt');
  if (!statSync(notice).isFile() || !readFileSync(notice, 'utf8').trim()) {
    throw new Error('WEFTORY requires the media build’s distribution notices.');
  }
  const version = execFileSync(ffmpeg, ['-version'], { encoding: 'utf8', timeout: 5000 });
  if (/\s--enable-nonfree(?:\s|$)/.test(version)) throw new Error('WEFTORY requires a redistributable media build.');
  const filters = execFileSync(ffmpeg, ['-hide_banner', '-filters'], { encoding: 'utf8', timeout: 5000 });
  const encoders = execFileSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 5000 });
  if (!/\bsubtitles\b/.test(filters) || !/\blibx264\b/.test(encoders)) {
    throw new Error('WEFTORY requires FFmpeg with libass subtitles and libx264 encoding.');
  }
}

module.exports = { validateWeftoryMediaDirectory };

if (require.main === module) validateWeftoryMediaDirectory(process.env.WEFTORY_MEDIA_DIR);
