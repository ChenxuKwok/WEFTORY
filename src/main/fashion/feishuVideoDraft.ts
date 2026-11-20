import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { z } from 'zod';

import { type bridgeSchema, FeishuVideoCardAction, FeishuVideoCardNamespace } from '../../shared/fashion/contracts';
import { t } from '../i18n';
import type { FashionService } from './service';
import { type PhotoVideoDraft, PhotoVideoState } from './store';

type CardInput = NonNullable<z.infer<typeof bridgeSchema>['card']>;
type Recipient = { instance: string; owner: string };

const plainText = (content: string) => ({ tag: 'plain_text', content });
const line = (content: string) => ({ tag: 'div', text: plainText(content) });
const chatId = (id: string) => id.split(':').at(-1);

export class FeishuVideoDraft {
  private readonly active = new Map<string, Promise<void>>();
  private readonly controller = new AbortController();

  constructor(
    private readonly service: FashionService,
    private readonly inboundDirectory: () => string,
    private readonly send: (recipient: Recipient, card: object) => Promise<string | undefined>,
    private readonly wakeVideoQueue: () => void,
  ) {}

  open(recipient: Recipient, conversation: string, restart: boolean): string {
    const key = this.key(recipient);
    if (this.active.has(key)) return t('fashionVideoDraftBusy');
    const store = this.service.store;
    const existing = store.getPhotoDraft(key);
    const draft: PhotoVideoDraft = existing && existing.conversation === chatId(conversation) && !restart && !existing.confirmed
      ? { ...existing, revision: existing.revision + 1 }
      : { id: randomUUID(), revision: 1, conversation: chatId(conversation) ?? '' };
    if (draft.product?.sha256 === draft.modelPhoto?.sha256) draft.modelPhoto = undefined;
    store.savePhotoDraft(key, draft);
    this.run(key, () => this.sendCard(recipient, draft));
    return '';
  }

  receive(recipient: Recipient, conversation: string, messageKey: string, imageFile: string): string {
    const key = this.key(recipient);
    const { store, media } = this.service;
    const draft = store.getPhotoDraft(key);
    if (!draft || draft.confirmed || draft.conversation !== chatId(conversation)) return '';
    const previous = store.getMessage(messageKey);
    if (previous !== undefined) return previous;
    if (this.active.has(key)) return t('fashionVideoDraftBusy');
    if (draft.modelPhoto) return t('fashionVideoDraftPhotosFull');
    const reply = t('fashionVideoDraftReadingPhoto');
    store.saveMessage(messageKey, reply);
    this.run(key, async () => {
      let photo;
      try {
        photo = await media.importImage(path.join(this.inboundDirectory(), imageFile), this.controller.signal);
      } catch (error) {
        if (this.controller.signal.aborted) return;
        console.warn('[WEFTORY] Could not attach Feishu photo to video draft', error instanceof Error ? error.name : 'unknown');
        await this.send(recipient, this.card(t('fashionVideoDraftPhotoError'), []));
        return;
      }
      if (draft.product) {
        if (draft.product.sha256 !== photo.sha256) draft.modelPhoto = photo;
      } else draft.product = photo;
      draft.plan = undefined;
      draft.revision++;
      store.savePhotoDraft(key, draft);
      await this.sendCard(recipient, draft);
    });
    return reply;
  }

  photoUnavailable(recipient: Recipient, conversation: string): string {
    const draft = this.service.store.getPhotoDraft(this.key(recipient));
    return draft && !draft.confirmed && draft.conversation === chatId(conversation) ? t('fashionVideoDraftDownloadError') : '';
  }

  action(recipient: Recipient, messageId: string, input: CardInput): string {
    const key = this.key(recipient);
    const { store, providers } = this.service;
    const draft = store.getPhotoDraft(key);
    if (!draft || draft.id !== input.draftId || draft.revision !== input.revision
      || draft.cardMessageId !== messageId || draft.confirmed) return t('fashionVideoDraftStale');
    if (this.active.has(key)) return t('fashionVideoDraftBusy');
    if (!draft.product) return t('fashionVideoDraftNeedsPhoto');
    if (input.action === FeishuVideoCardAction.Draft) {
      this.run(key, async () => {
        try {
          draft.plan = await providers.draftPhotoVideo(input.model ?? '', input.script ?? '',
            Boolean(draft.modelPhoto), this.controller.signal);
        } catch (error) {
          if (this.controller.signal.aborted) return;
          const detail = error instanceof z.ZodError
            ? error.issues.map(issue => `${issue.path.join('.') || 'root'}:${issue.code}`).join(', ')
            : error instanceof Error ? error.name : 'unknown';
          console.warn('[WEFTORY] Could not fill Feishu video draft', detail);
          draft.revision++;
          store.savePhotoDraft(key, draft);
          await this.sendCard(recipient, draft, t('fashionVideoDraftAiError'));
          return;
        }
        draft.revision++;
        store.savePhotoDraft(key, draft);
        await this.sendCard(recipient, draft);
      });
      return t('fashionVideoDraftWriting');
    }
    if (!draft.plan) return t('fashionVideoDraftStale');
    if (!store.getSecret()) return t('fashionError.setup');
    const model = store.getSettings().videoModel;
    store.atomic(() => {
      store.enqueuePhotoVideo({
        id: `${recipient.instance}/${draft.id}`, ...recipient, model,
        product: draft.product, modelPhoto: draft.modelPhoto, plan: draft.plan, state: PhotoVideoState.Queued,
      });
      store.savePhotoDraft(key, { ...draft, confirmed: true });
    });
    this.wakeVideoQueue();
    return t('fashionVideoDraftQueued');
  }

  async stop(): Promise<void> {
    this.controller.abort();
    await Promise.allSettled(this.active.values());
  }

  private key(recipient: Recipient): string {
    return `${recipient.instance}/${recipient.owner}`;
  }

  private run(key: string, work: () => Promise<void>): void {
    this.active.set(key, Promise.resolve().then(work).catch(error => {
      console.warn('[WEFTORY] Could not send Feishu video draft card', error instanceof Error ? error.name : 'unknown');
    }).finally(() => {
      this.active.delete(key);
    }));
  }

  private async sendCard(recipient: Recipient, draft: PhotoVideoDraft, notice?: string): Promise<void> {
    const button = (action: typeof FeishuVideoCardAction[keyof typeof FeishuVideoCardAction], title: string) => {
      const callback = `${FeishuVideoCardNamespace}:${action}:${draft.id}:${draft.revision}`;
      return { tag: 'button', behaviors: [{ type: 'callback', value: { action: callback } }],
        text: plainText(title), type: 'primary' };
    };
    const elements: object[] = notice ? [line(notice)] : [];
    if (draft.plan) {
      elements.push(line(`${t('fashionVideoDraftModelTitle')}\n${draft.plan.model}`),
        line(`${t('fashionVideoDraftScriptTitle')}\n${draft.plan.storyboard}`),
        line(t('fashionVideoDraftCharge')), button(FeishuVideoCardAction.Confirm, t('fashionVideoDraftConfirm')));
      await this.publish(recipient, draft, this.card(t('fashionVideoDraftReview'), elements));
      return;
    }
    elements.push(line(t(draft.product ? 'fashionVideoDraftProductReady' : 'fashionVideoDraftProductMissing')),
      line(t(draft.modelPhoto ? 'fashionVideoDraftModelReady' : 'fashionVideoDraftModelMissing')));
    if (draft.product) {
      const submit = button(FeishuVideoCardAction.Draft, t('fashionVideoDraftFill'));
      elements.push({ tag: 'form', name: 'video_form', elements: [
        { tag: 'input', name: 'model', max_length: 280, label: plainText(t('fashionVideoDraftModelTitle')),
          placeholder: plainText(t('fashionVideoDraftOptional')) },
        { tag: 'input', name: 'script', input_type: 'multiline_text', max_length: 1000,
          label: plainText(t('fashionVideoDraftScriptTitle')),
          placeholder: plainText(t('fashionVideoDraftOptional')) },
        { ...submit, name: 'draft_video', form_action_type: 'submit' },
      ] });
    }
    await this.publish(recipient, draft, this.card(t('fashionVideoDraftHeader'), elements));
  }

  private async publish(recipient: Recipient, draft: PhotoVideoDraft, card: object): Promise<void> {
    const cardMessageId = await this.send(recipient, card);
    if (cardMessageId) this.service.store.savePhotoDraft(this.key(recipient), { ...draft, cardMessageId });
  }

  private card(title: string, elements: object[]): object {
    return { schema: '2.0', config: { update_multi: true, enable_forward: false }, header: { title: plainText(title) }, body: { elements } };
  }
}
