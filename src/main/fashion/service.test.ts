import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { type Asset, Decision, FashionError, type Run,RunMode, RunState } from '../../shared/fashion/contracts';
import type { FeishuInstanceConfig } from '../im/types';
import { FashionFeishu } from './feishu';
import { FashionMedia } from './media';
import type { FashionProviders } from './providers';
import { FashionService } from './service';
import { FashionStore, TaskState } from './store';

vi.mock('../libs/oneShotModelClient', () => ({}));

const cleanup: Array<() => void | Promise<void>> = [];
const asset = (mime: string): Asset => ({ id: randomUUID(), sha256: 'f'.repeat(64), mime });
const validPlan = { schemaVersion: 1, shots: Array.from({ length: 6 }, () => ({
  direction: 'Shot direction', caption: 'Subtitle',
})) };

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  vi.unstubAllGlobals();
});

function fixture(media?: FashionMedia) {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE legacy (value TEXT); INSERT INTO legacy VALUES ('keep');");
  const store = new FashionStore(db);
  const settings = { imageModel: 'image', videoModel: 'video', textCents: 1, frameCents: 2, clipCents: 3,
    feishuInstance: '', feishuOwner: '' };
  store.saveSettings(settings);
  const providers = {
    textConfigured: vi.fn(() => true),
    text: vi.fn(async () => JSON.stringify(validPlan)),
    frameRequest: vi.fn(async () => ({ model: 'image' })),
    generateFrame: vi.fn(async () => asset('image/png')),
    videoRequest: vi.fn(async () => ({ model: 'video' })),
    submitVideo: vi.fn(async () => randomUUID()),
    getVideo: vi.fn(async (_id: string, _signal: AbortSignal) => asset('video/mp4')),
    cancelVideo: vi.fn(async () => {}),
  };
  const neutralMedia = { assemble: vi.fn(async (_run: Run, _signal: AbortSignal) => asset('video/mp4')) };
  const instantiate = () => new FashionService(new FashionStore(db), media ?? neutralMedia as unknown as FashionMedia,
    providers as unknown as FashionProviders, () => {}, () => true);
  const service = instantiate();
  const image = asset('image/png');
  store.saveAsset(image);
  const product = service.saveProduct({ sku: 'TEST-001', title: 'Coat', rights: 'Fixture', facts: '', forbidden: '', images: [image.id] });
  const character = service.saveCharacter({ name: 'Fixture', persona: '', arkAsset: '', allowFirstFrame: true, image: image.id });
  const create = (maxCents = 25) => service.create({ mode: RunMode.Live, productId: product.id, characterId: character.id, maxCents });
  const until = async (id: string, state: RunState): Promise<Run> => {
    await vi.waitFor(() => expect(store.getRun(id)?.state).toBe(state));
    return store.getRun(id)!;
  };
  cleanup.push(() => db.close(), () => service.stop());
  return { db, store, service, instantiate, create, until, providers, neutralMedia, settings };
}

describe('WEFTORY durable production', () => {
  test('migrates repeatedly, completes mock generation, and invalidates stale review after rework', async () => {
    const { db, service, store, until, neutralMedia } = fixture();
    expect(db.prepare('SELECT value FROM legacy').pluck().get()).toBe('keep');
    service.start();
    const id = service.create({ mode: RunMode.Demo, maxCents: 0 });
    const plan = await until(id, RunState.Plan);
    expect(() => service.approvePlan({ id, version: 7 })).toThrow(FashionError.State);
    service.approvePlan({ id, version: plan.version });
    const edited = await until(id, RunState.Review);
    const review = { id, version: edited.version, assetId: edited.final!.id, sha256: edited.final!.sha256,
      comment: '', decision: Decision.Approve };
    service.review(review);
    expect(service.approved(id, edited.version)).toEqual(edited.final);
    service.rework({ id, version: edited.version, shot: 4, comment: 'Change angle' });
    const next = await until(id, RunState.Review);
    expect(next.shots.map(shot => shot.attempt)).toEqual([0, 0, 0, 1, 0, 0]);
    expect(neutralMedia.assemble).toHaveBeenCalledTimes(2);
    expect(() => service.review(review)).toThrow(FashionError.State);
    expect(store.getRun(id)?.version).toBe(edited.version + 1);
  });

  test('pauses before exceeding reserved budget and restores a submitted remote task after shutdown', async () => {
    const { service, store, instantiate, until, create, providers } = fixture();
    providers.getVideo.mockImplementationOnce((_id, signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    service.start();
    const id = create(1);
    const plan = await until(id, RunState.Plan);
    service.approvePlan({ id, version: plan.version });
    await until(id, RunState.Budget);
    expect(providers.generateFrame).not.toHaveBeenCalled();
    service.retry({ id, maxCents: 25 });
    await vi.waitFor(() => expect(providers.getVideo).toHaveBeenCalledTimes(1));
    const remoteId = store.tasks(id).find(task => task.state === TaskState.Submitted)?.remoteId;
    expect(remoteId).toBeTruthy();
    await service.stop();
    const recovered = instantiate();
    cleanup.push(() => recovered.stop());
    recovered.start();
    await until(id, RunState.Review);
    expect(providers.submitVideo).toHaveBeenCalledTimes(4);
    expect(providers.getVideo.mock.calls[1][0]).toBe(remoteId);
    expect(store.getRun(id)?.reservedCents).toBe(21);
  });

  test('holds an ambiguous paid request across restart and requires explicit reconciliation', async () => {
    const { service, store, instantiate, until, create, providers } = fixture();
    providers.submitVideo.mockRejectedValueOnce(new Error('Unknown delivery outcome'));
    service.start();
    const id = create();
    const plan = await until(id, RunState.Plan);
    service.approvePlan({ id, version: plan.version });
    await until(id, RunState.Reconcile);
    await service.stop();
    const recovered = instantiate();
    cleanup.push(() => recovered.stop());
    recovered.start();
    expect(() => recovered.retry({ id })).toThrow(FashionError.Reconcile);
    expect(providers.submitVideo).toHaveBeenCalledTimes(1);
    expect(store.getRun(id)?.reservedCents).toBe(6);
    recovered.retry({ id, maxCents: 30, reconcile: true });
    await until(id, RunState.Review);
    expect(store.tasks(id).filter(task => task.state === TaskState.Abandoned)).toHaveLength(1);
    expect(store.getRun(id)?.reservedCents).toBe(24);
  });

  test('cancellation wins over an in-flight provider completion', async () => {
    const { service, store, until, create, providers } = fixture();
    let complete: (value: Asset) => void = () => {};
    providers.getVideo.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    service.start();
    const id = create();
    const plan = await until(id, RunState.Plan);
    service.approvePlan({ id, version: plan.version });
    await vi.waitFor(() => expect(providers.getVideo).toHaveBeenCalledTimes(1));
    service.cancel(id);
    service.cancel(id);
    complete(asset('video/mp4'));
    await service.stop();
    expect(providers.cancelVideo).toHaveBeenCalledTimes(1);
    expect(store.getRun(id)?.state).toBe(RunState.Cancelled);
    expect(store.getRun(id)?.final).toBeUndefined();
  });

  test('rejects unknown Feishu users and processes each message once', () => {
    const { service, store, settings } = fixture();
    const account = { instanceId: 'abc12345-bot', instanceName: 'Fixture Bot', enabled: true, domain: 'feishu', appId: 'app', appSecret: 'secret' };
    const bot = new FashionFeishu(service, () => [account as FeishuInstanceConfig]);
    store.saveSettings({ ...settings, feishuInstance: account.instanceId, feishuOwner: 'ou_owner' });
    const event = { accountId: 'abc12345', senderId: 'ou_owner', conversationId: 'chat', messageId: 'message', command: '/wft create TEST-001' };
    bot.handle({ ...event, senderId: 'ou_other' });
    expect(store.runs()).toHaveLength(0);
    expect(bot.handle(event)).toEqual(bot.handle(event));
    expect(store.runs()).toHaveLength(1);
  });

  test('uses real FFmpeg to produce a verified 21-second subtitle-burned demo where available', async context => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'WEFTORY 路径 空格-'));
    const db = new Database(':memory:');
    cleanup.push(() => rm(root, { recursive: true, force: true }), () => db.close());
    const store = new FashionStore(db);
    const media = new FashionMedia(store, root);
    context.skip(!await media.check(), 'FFmpeg with libx264 and subtitles is not installed');
    const providers = {} as FashionProviders;
    const service = new FashionService(store, media, providers, () => {}, () => false);
    cleanup.push(() => service.stop());
    service.start();
    const id = service.create({ mode: RunMode.Demo, maxCents: 0 });
    await vi.waitFor(() => expect(store.getRun(id)?.state).toBe(RunState.Plan));
    service.approvePlan({ id, version: 1 });
    await vi.waitFor(() => expect(store.getRun(id)?.state).toBe(RunState.Review), { timeout: 20_000 });
    const final = store.getRun(id)!.final!;
    const file = await media.verify(final);
    expect(file).toContain(final.sha256);
    await writeFile(file, 'tampered');
    await expect(media.verify(final)).rejects.toThrow(FashionError.Media);
  }, 25_000);
});
