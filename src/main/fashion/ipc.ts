import { randomUUID } from 'node:crypto';
import { constants, renameSync } from 'node:fs';
import { copyFile, rm } from 'node:fs/promises';

import { app, type BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent,protocol, safeStorage } from 'electron';
import { z } from 'zod';

import { ArtifactPreviewHost, ArtifactPreviewProtocol } from '../../shared/artifactPreview/constants';
import {
  characterSchema, createSchema, FashionError, FashionIpc, FashionMediaScheme, type FashionResult,
idSchema, productSchema, retrySchema, reviewSchema,
  reworkSchema, savePlanSchema, saveSettingsSchema, versionSchema, } from '../../shared/fashion/contracts';
import { createLocalFileProtocolResponse } from '../artifactLocalFileProtocol';
import { fail,FashionFailure } from './errors';
import type { FashionFeishu } from './feishu';
import type { FashionService } from './service';

export function registerFashionIpc(
  service: FashionService,
  feishu: FashionFeishu,
  window: () => BrowserWindow | null,
  expectedUrl: string,
): void {
  const handle = <Schema extends z.ZodType, Result>(
    channel: string,
    schema: Schema,
    callback: (input: z.output<Schema>, owner: BrowserWindow) => Result | Promise<Result>,
  ) => {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, raw: unknown): Promise<FashionResult<Result>> => {
      const owner = window();
      if (!owner || owner.isDestroyed() || event.sender !== owner.webContents
        || event.senderFrame !== owner.webContents.mainFrame || event.senderFrame.url !== expectedUrl) {
        return { ok: false, error: FashionError.Invalid };
      }
      const input = schema.safeParse(raw);
      if (!input.success) return { ok: false, error: FashionError.Invalid };
      try {
        return { ok: true, value: await callback(input.data, owner) };
      } catch (error) {
        const code = error instanceof FashionFailure ? error.code : FashionError.Storage;
        console.warn('[WEFTORY] Desktop request failed', channel, code);
        return { ok: false, error: code };
      }
    });
  };
  handle(FashionIpc.Snapshot, z.undefined(), () => ({ ...service.snapshot(), feishuAccounts: feishu.accounts() }));
  handle(FashionIpc.Import, z.undefined(), async (_input, owner) => {
    const selected = await dialog.showOpenDialog(owner, {
      properties: ['openFile'], filters: [{ name: 'PNG / JPEG', extensions: ['png', 'jpg', 'jpeg'] }],
    });
    return selected.canceled || !selected.filePaths[0] ? null : service.media.importImage(selected.filePaths[0]);
  });
  handle(FashionIpc.SaveProduct, productSchema, input => service.saveProduct(input));
  handle(FashionIpc.SaveCharacter, characterSchema, input => service.saveCharacter(input));
  handle(FashionIpc.SaveSettings, saveSettingsSchema, ({ arkKey, ...settings }) => {
    if (arkKey && !safeStorage.isEncryptionAvailable()) fail(FashionError.Setup);
    if (settings.feishuInstance && !feishu.accounts().some(account => account.id === settings.feishuInstance)) fail(FashionError.Invalid);
    if (Boolean(settings.feishuInstance) !== Boolean(settings.feishuOwner)) fail(FashionError.Invalid);
    service.store.saveSettings(settings, arkKey ? safeStorage.encryptString(arkKey) : undefined);
  });
  handle(FashionIpc.TestSetup, z.undefined(), async () => ({
    ffmpeg: await service.media.check(), text: service.providers.textConfigured(),
    ark: await service.providers.testArk(), feishu: await feishu.check(),
  }));
  handle(FashionIpc.Create, createSchema, input => service.create(input));
  handle(FashionIpc.SavePlan, savePlanSchema, input => service.savePlan(input));
  handle(FashionIpc.ApprovePlan, versionSchema, input => service.approvePlan(input));
  handle(FashionIpc.Review, reviewSchema, input => service.review(input));
  handle(FashionIpc.Rework, reworkSchema, input => service.rework(input));
  handle(FashionIpc.Retry, retrySchema, input => service.retry(input));
  handle(FashionIpc.Cancel, idSchema, id => service.cancel(id));
  handle(FashionIpc.Export, versionSchema, async ({ id, version }, owner) => {
    const asset = service.approved(id, version);
    const picked = await dialog.showSaveDialog(owner, { defaultPath: `WEFTORY-${id.slice(0, 8)}-v${version}.mp4`,
      filters: [{ name: 'MP4', extensions: ['mp4'] }] });
    if (picked.canceled || !picked.filePath) return false;
    const temporary = `${picked.filePath}.${randomUUID()}.tmp`;
    try {
      await copyFile(await service.media.verify(asset), temporary, constants.COPYFILE_EXCL);
      service.approved(id, version);
      renameSync(temporary, picked.filePath);
      return true;
    } finally {
      await rm(temporary, { force: true });
    }
  });

  protocol.handle(FashionMediaScheme, async request => {
    const url = new URL(request.url);
    const id = idSchema.safeParse(url.pathname.slice(1));
    const asset = url.hostname === 'asset' && id.success && service.store.getAsset(id.data);
    if (!asset || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 404 });
    const source = service.media.getPath(asset);
    const encodedPath = source.split('/').map(encodeURIComponent).join('/');
    const local = new Request(`${ArtifactPreviewProtocol.LocalFile}://${ArtifactPreviewHost.LocalFile}${encodedPath}`, {
      method: request.method, headers: request.headers,
    });
    const response = await createLocalFileProtocolResponse(local);
    response.headers.delete('Access-Control-Allow-Origin');
    return response;
  });
  app.once('will-quit', () => protocol.unhandle(FashionMediaScheme));
}
