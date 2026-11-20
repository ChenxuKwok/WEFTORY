import { fileURLToPath } from 'node:url';

import { describe, expect, test, vi } from 'vitest';

import { DefaultSeedanceModel, FashionError, type Run, ShotSource } from '../../shared/fashion/contracts';
import type { FashionMedia } from './media';
import { FashionProviders } from './providers';

vi.mock('../libs/oneShotModelClient', () => ({}));

describe('Ark video adapter', () => {
  test('submits the asynchronous provider request and cancels the same task', async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: 'cgt-example-1' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const providers = new FashionProviders({} as FashionMedia, () => 'fixture-key', () => null, vi.fn(), request);
    const id = await providers.submitVideo({ model: 'seedance-fixture', ratio: '9:16' }, new AbortController().signal);
    expect(id).toBe('cgt-example-1');
    await providers.cancelVideo(id);
    expect(request.mock.calls[0]).toEqual([
      'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks',
      expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer fixture-key' }) }),
    ]);
    expect(request.mock.calls[1][0]).toBe('https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/cgt-example-1');
    expect(request.mock.calls[1][1]?.method).toBe('DELETE');
  });

  test('translates a virtual portrait into reference-image mode, separate from first-frame mode', async () => {
    const media = { verify: vi.fn(async () => fileURLToPath(import.meta.url)) } as unknown as FashionMedia;
    const file = { id: 'reference', sha256: 'a'.repeat(64), mime: 'image/png' };
    const providers = new FashionProviders(media, () => 'fixture-key', () => null, vi.fn());
    const run = { character: { arkAsset: 'asset://avatar-fixture' }, plan: { shots: [{ direction: 'Show the outfit.' }] } } as unknown as Run;
    const shot = { number: 1, source: ShotSource.Generated, attempt: 0 };
    const avatar = await providers.videoRequest(DefaultSeedanceModel, run, shot, file, file);
    expect(avatar).toMatchObject({ model: DefaultSeedanceModel, ratio: '9:16' });
    expect(avatar.content.slice(1)).toEqual([
      { type: 'image_url', image_url: { url: 'asset://avatar-fixture' }, role: 'reference_image' },
      { type: 'image_url', image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) }, role: 'reference_image' },
    ]);
    run.character.arkAsset = '';
    const first = await providers.videoRequest(DefaultSeedanceModel, run, shot, file, file);
    expect(first).toMatchObject({ model: DefaultSeedanceModel, ratio: 'adaptive' });
    expect(first.content.slice(1)).toEqual([
      { type: 'image_url', image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) }, role: 'first_frame' },
    ]);
  });

  test('rejects an unexpected result URL without sending another request', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({
      status: 'succeeded', content: { video_url: 'http://127.0.0.1:1234/video' },
    }));
    const providers = new FashionProviders({} as FashionMedia, () => 'fixture-key', () => null, vi.fn(), request);
    await expect(providers.getVideo('cgt-example-1', new AbortController().signal)).rejects.toThrow(FashionError.Provider);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
