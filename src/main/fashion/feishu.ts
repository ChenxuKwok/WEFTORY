import { createHash, randomBytes } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { stat } from 'node:fs/promises';

import { z } from 'zod';

import { bridgeSchema, Decision, FashionError, type Run,RunMode, RunState } from '../../shared/fashion/contracts';
import { t } from '../i18n';
import type { FeishuInstanceConfig } from '../im/types';
import { fail,FashionFailure } from './errors';
import { FeishuVideoDraft, type FeishuVideoRecipient } from './feishuVideoDraft';
import { FeishuPhotoVideoQueue } from './photoVideo';
import type { FashionService } from './service';
import type { PhotoVideoJob } from './store';

const base = 'https://open.feishu.cn/open-apis';
const maxAttachment = 30_000_000;
const videoMessageType = 'media';
const command = {
  Create: 'create', Status: 'status', Pending: 'pending', ApprovePlan: 'approve-plan',
  Review: 'review', Cancel: 'cancel', Deliver: 'deliver', Video: 'video',
} as const;
const decisionByText: Record<string, typeof Decision[keyof typeof Decision]> = {
  approve: Decision.Approve, return: Decision.Return, reject: Decision.Reject,
  通过: Decision.Approve, 退回: Decision.Return, 拒绝: Decision.Reject,
};
const apiEnvelope = z.object({ code: z.number(), data: z.unknown().optional(), tenant_access_token: z.string().optional() });
type Delivery = { state: 'ready' | 'sending' | 'sent' | 'failed' | 'uncertain'; fileKey?: string };
type Code = { nonce: string; conversation: string; version: number; assetId: string; sha256: string; expiresAt: number };

class SendRejected extends Error {
  constructor(code: number) {
    super(`Feishu API rejected request (${code})`);
    this.name = 'SendRejected';
  }
}

export class FashionFeishu {
  private active = new Set<string>();
  private jobs = new Set<Promise<void>>();
  private stopped = false;
  private readonly photoVideos: FeishuPhotoVideoQueue;
  private readonly videoDrafts: FeishuVideoDraft;

  constructor(
    private readonly service: FashionService,
    private readonly instances: () => FeishuInstanceConfig[],
    inboundDirectory: () => string = () => fail(FashionError.Setup),
  ) {
    this.photoVideos = new FeishuPhotoVideoQueue(service,
      job => Boolean(this.photoAccount(job)), (job, text) => this.deliverPhotoVideo(job, text));
    this.videoDrafts = new FeishuVideoDraft(service, inboundDirectory,
      (recipient, card) => this.sendVideoCard(recipient, card), () => this.photoVideos.wake());
  }

  accounts() {
    return this.instances().filter(instance => instance.enabled && instance.appId && instance.appSecret
      && (!instance.domain || instance.domain === 'feishu')).map(instance => ({ id: instance.instanceId, name: instance.instanceName }));
  }

  async check(): Promise<boolean> {
    const account = this.account(this.service.store.getSettings().feishuInstance);
    if (!account) return false;
    return this.token(account).then(() => true, () => false);
  }

  recover(): void {
    this.service.store.runs().forEach(run => this.changed(run));
    this.photoVideos.wake();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all([this.videoDrafts.stop(), this.photoVideos.stop(), Promise.allSettled(this.jobs)]);
  }

  changed(run: Run): void {
    if (this.stopped || !this.destination(run)) return;
    if (run.state === RunState.Plan || run.state === RunState.Review || run.state === RunState.Approved) {
      this.queue(run);
    }
  }

  handle(raw: unknown): string {
    const parsed = bridgeSchema.safeParse(raw);
    if (!parsed.success || this.stopped) return t('fashionBotDenied');
    const input = parsed.data;
    const settings = this.service.store.getSettings();
    const account = this.account(settings.feishuInstance);
    if (!account || account.instanceId.slice(0, 8) !== input.accountId || input.senderId !== settings.feishuOwner) {
      return input.imageFile || input.imageUnavailable ? '' : t('fashionBotDenied');
    }
    const key = `${account.instanceId}/${input.messageId}`;
    const recipient = { instance: account.instanceId, owner: input.senderId, groupChatId: input.groupChatId };
    const conversation = input.groupChatId ?? input.conversationId;
    if (input.card) return this.videoDrafts.action(recipient, input.messageId, input.card, input.conversationId);
    if (input.imageUnavailable) return this.videoDrafts.photoUnavailable(recipient, conversation);
    if (input.imageFile) {
      return this.videoDrafts.receive(recipient, conversation, key, input.imageFile);
    }
    return this.service.store.atomic(() => {
      const duplicate = this.service.store.getMessage(key);
      if (duplicate !== undefined) return duplicate;
      let reply: string;
      try {
        reply = this.service.store.atomic(() => this.execute(input, account, settings.feishuOwner));
      } catch (error) {
        const code = error instanceof FashionFailure ? error.code : FashionError.Storage;
        reply = t(`fashionError.${code}`);
      }
      this.service.store.saveMessage(key, reply);
      return reply;
    });
  }

  private execute(input: z.infer<typeof bridgeSchema>, account: FeishuInstanceConfig, owner: string): string {
    const [prefix, action, id, value, choice, ...notes] = (input.command ?? '').trim().split(/\s+/);
    if (prefix !== '/wft') return t('fashionBotUsage');
    if (action === command.Video) {
      return this.videoDrafts.open({ instance: account.instanceId, owner, groupChatId: input.groupChatId },
        input.groupChatId ?? input.conversationId, id === 'new');
    }
    if (input.groupChatId) return t('fashionBotDenied');
    const owned = (run: Run) => run.recipient?.instance === account.instanceId && run.recipient.owner === owner;
    if (action === command.Create) {
      const product = this.service.store.products().find(item => item.sku === id);
      const character = this.service.store.characters()[0];
      const { frameCents, textCents, clipCents } = this.service.store.getSettings();
      if (!product || !character || value || !frameCents || !textCents || !clipCents) fail(FashionError.Invalid);
      const runId = this.service.create({
        productId: product.id, characterId: character.id, maxCents: 3 * textCents + 4 * (frameCents + clipCents), mode: RunMode.Live,
      });
      return t('fashionBotCreated', { id: this.shortId(runId) });
    }
    if (action === command.Pending) {
      return this.service.store.runs().filter(owned).filter(run => run.state === RunState.Plan || run.state === RunState.Review)
        .slice(0, 10).map(run => this.summary(run)).join('\n') || t('fashionBotEmpty');
    }
    if (!id) return t('fashionBotUsage');
    const matches = this.service.store.runs().filter(owned).filter(run => run.id === id || this.shortId(run.id) === id.toUpperCase());
    if (matches.length !== 1) fail(FashionError.Invalid);
    const [run] = matches;
    if (action === command.Status) {
      if (run.state !== RunState.Review || !run.final) return this.summary(run);
      const nonce = randomBytes(8).toString('hex');
      this.service.store.saveCode(run.id, {
        nonce, conversation: input.conversationId, version: run.version, assetId: run.final.id,
        sha256: run.final.sha256, expiresAt: Date.now() + 10 * 60_000,
      } satisfies Code);
      return `${this.summary(run)}\n/wft review ${this.shortId(run.id)} ${nonce} <approve|return|reject>`;
    }
    if (action === command.ApprovePlan) {
      if (!/^\d+$/.test(value ?? '')) fail(FashionError.Invalid);
      this.service.approvePlan({ id: run.id, version: Number(value) });
      return t('fashionBotUpdated');
    }
    if (action === command.Review) {
      const token = this.service.store.getCode<Code>(run.id);
      const decision = Object.prototype.hasOwnProperty.call(decisionByText, choice ?? '') ? decisionByText[choice] : undefined;
      if (!token || token.nonce !== value || token.conversation !== input.conversationId
        || token.expiresAt <= Date.now() || !decision) fail(FashionError.State);
      this.service.review({ id: run.id, version: token.version, assetId: token.assetId, sha256: token.sha256,
        decision, comment: notes.join(' ') }, owner);
      this.service.store.consumeCode(run.id);
      return t('fashionBotUpdated');
    }
    if (action === command.Cancel) {
      this.service.cancel(run.id);
      return t('fashionBotUpdated');
    }
    if (action === command.Deliver) {
      if (run.state !== RunState.Approved || !run.final || this.active.has(this.deliveryId(run))) fail(FashionError.State);
      if (run.delivery === 'sent') return t('fashionBotUpdated');
      if (run.delivery === 'uncertain' && value !== 'confirm') return t('fashionBotRetryConfirm');
      const key = this.deliveryId(run);
      const saved = this.service.store.getDelivery<Delivery>(key);
      this.service.store.saveDelivery(key, { ...saved, state: 'ready' });
      this.service.updateDelivery(run.id, run.version, 'pending');
      this.queue(run);
      return t('fashionBotUpdated');
    }
    return t('fashionBotUsage');
  }

  private queue(run: Run): void {
    const id = this.deliveryId(run);
    if (this.stopped || this.active.has(id)) return;
    this.active.add(id);
    const job = Promise.resolve().then(() => this.deliver(run, id)).catch(() => {
      console.warn('[WEFTORY] Could not persist Feishu delivery for run', run.id);
    }).finally(() => {
      this.active.delete(id);
      this.jobs.delete(job);
    });
    this.jobs.add(job);
  }

  private async deliver(run: Run, id: string): Promise<void> {
    const destination = this.destination(run);
    if (!destination || this.stopped) return;
    const { account, owner } = destination;
    let saved = this.service.store.getDelivery<Delivery>(id) ?? { state: 'ready' };
    if (saved.state === 'sending') {
      this.service.store.saveDelivery(id, { ...saved, state: 'uncertain' });
      if (run.state === RunState.Approved) this.service.updateDelivery(run.id, run.version, 'uncertain');
      return;
    }
    if (saved.state !== 'ready') return;
    let sending = false;
    try {
      const token = await this.token(account);
      let content: Record<string, string> = { text: this.summary(run) };
      let type = 'text';
      if (run.state === RunState.Approved) {
        const asset = this.service.approved(run.id, run.version);
        const path = await this.service.media.verify(asset);
        if (!saved.fileKey) {
          const name = `WEFTORY-${this.shortId(run.id)}-v${run.version}.mp4`;
          saved = { ...saved, fileKey: await this.uploadVideo(path, account, token, name) };
          this.service.store.saveDelivery(id, saved);
        }
        this.service.approved(run.id, run.version);
        type = videoMessageType;
        content = { file_key: saved.fileKey ?? fail(FashionError.Provider) };
      }
      if (this.stopped || !this.destination(run)) return;
      const latest = this.service.store.getRun(run.id);
      if (latest?.state !== run.state || latest.version !== run.version) return;
      this.service.store.saveDelivery(id, { ...saved, state: 'sending' });
      sending = true;
      await this.api('/im/v1/messages?receive_id_type=open_id', {
        method: 'POST', body: JSON.stringify({
          receive_id: owner, msg_type: type, content: JSON.stringify(content),
          uuid: createHash('sha256').update(id).digest('hex').slice(0, 40),
        }),
      }, token);
      this.service.store.saveDelivery(id, { ...saved, state: 'sent' });
      if (run.state === RunState.Approved) this.service.updateDelivery(run.id, run.version, 'sent');
    } catch (error) {
      const state = sending && !(error instanceof SendRejected) ? 'uncertain' : 'failed';
      this.service.store.saveDelivery(id, { ...saved, state });
      if (run.state === RunState.Approved) this.service.updateDelivery(run.id, run.version, state);
    }
  }

  private async token(account: FeishuInstanceConfig): Promise<string> {
    const result = await this.api('/auth/v3/tenant_access_token/internal', {
      method: 'POST', body: JSON.stringify({ app_id: account.appId, app_secret: account.appSecret }),
    });
    return result.tenant_access_token ?? fail(FashionError.Setup);
  }

  private photoAccount(job: PhotoVideoJob): FeishuInstanceConfig | undefined {
    const settings = this.service.store.getSettings();
    if (this.stopped || !job.plan || job.instance !== settings.feishuInstance
      || job.owner !== settings.feishuOwner) return undefined;
    return this.account(job.instance);
  }

  private async sendVideoCard(recipient: FeishuVideoRecipient, card: object): Promise<string | undefined> {
    const settings = this.service.store.getSettings();
    const account = this.account(recipient.instance);
    if (!account || this.stopped || settings.feishuInstance !== recipient.instance || settings.feishuOwner !== recipient.owner) return;
    const token = await this.token(account);
    const latest = this.service.store.getSettings();
    if (this.stopped || latest.feishuInstance !== recipient.instance || latest.feishuOwner !== recipient.owner) return;
    const response = await this.sendVideoMessage(recipient, {
      msg_type: 'interactive', content: JSON.stringify(card),
    }, token).catch(error => {
      if (error instanceof SendRejected) console.warn('[WEFTORY] Feishu card send rejected:', error.message);
      throw error;
    });
    return z.object({ message_id: z.string().min(1) }).parse(response.data).message_id;
  }

  private async deliverPhotoVideo(job: PhotoVideoJob, text?: string): Promise<void> {
    const account = this.photoAccount(job) ?? fail(FashionError.Setup);
    const token = await this.token(account);
    let content: Record<string, string> = { text: text ?? '' };
    if (text === undefined) {
      const asset = job.video ?? fail(FashionError.Media);
      if (!job.fileKey) {
        job.fileKey = await this.uploadVideo(await this.service.media.verify(asset), account, token, 'WEFTORY-10s.mp4');
        this.service.store.savePhotoVideo(job);
      }
      content = { file_key: job.fileKey };
    }
    if (!this.photoAccount(job)) fail(FashionError.Setup);
    await this.sendVideoMessage(job, {
      msg_type: text === undefined ? videoMessageType : 'text', content: JSON.stringify(content),
      uuid: createHash('sha256').update(job.id).update(text ?? 'mp4').digest('hex').slice(0, 40),
    }, token).catch(error => {
      if (error instanceof SendRejected) console.warn('[WEFTORY] Feishu video message rejected:', error.message);
      throw error;
    });
  }

  private sendVideoMessage(recipient: FeishuVideoRecipient, body: Record<string, string>, token: string) {
    const receiveIdType = recipient.groupChatId ? 'chat_id' : 'open_id';
    return this.api(`/im/v1/messages?receive_id_type=${receiveIdType}`, {
      method: 'POST', body: JSON.stringify({ ...body, receive_id: recipient.groupChatId ?? recipient.owner }),
    }, token);
  }

  private async uploadVideo(path: string, account: FeishuInstanceConfig, token: string, name: string): Promise<string> {
    const size = (await stat(path)).size;
    if (size > Math.min(maxAttachment, (account.mediaMaxMb || 30) * 1_000_000)) fail(FashionError.Media);
    const form = new FormData();
    form.set('file_type', 'mp4');
    form.set('file_name', name);
    form.set('file', await openAsBlob(path, { type: 'video/mp4' }));
    const uploaded = await this.api('/im/v1/files', { method: 'POST', body: form }, token);
    return z.object({ file_key: z.string().min(1) }).parse(uploaded.data).file_key;
  }

  private async api(route: string, init: RequestInit, token?: string) {
    const headers = new Headers();
    if (typeof init.body === 'string') headers.set('Content-Type', 'application/json');
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const response = await fetch(base + route, { ...init, headers, signal: AbortSignal.timeout(15_000), redirect: 'error' });
    if (response.status >= 500) fail(FashionError.Provider);
    if (!response.ok) throw new SendRejected(response.status);
    const result = apiEnvelope.parse(await response.json());
    if (result.code !== 0) throw new SendRejected(result.code);
    return result;
  }

  private account(id: string): FeishuInstanceConfig | undefined {
    if (!this.accounts().some(account => account.id === id)) return undefined;
    return this.instances().find(instance => instance.instanceId === id);
  }

  private destination(run: Run) {
    const settings = this.service.store.getSettings();
    const account = this.account(settings.feishuInstance);
    if (!account || !run.recipient || run.recipient.instance !== account.instanceId
      || run.recipient.owner !== settings.feishuOwner) return undefined;
    return { account, owner: run.recipient.owner };
  }

  private deliveryId(run: Run): string {
    return `${run.id}/${run.version}/${run.state}`;
  }

  private summary(run: Run): string {
    const progress = run.shots.filter(shot => shot.ready).length;
    return t('fashionBotSummary', { id: this.shortId(run.id), state: t(`fashionState.${run.state}`),
      version: String(run.version), progress: String(progress) });
  }

  private shortId(id: string): string {
    return id.slice(0, 8).toUpperCase();
  }
}
