import { FashionError } from '../../shared/fashion/contracts';
import { t } from '../i18n';
import { fail } from './errors';
import { ProviderRejected } from './providers';
import type { FashionService } from './service';
import { type PhotoVideoJob, PhotoVideoState } from './store';

export class FeishuPhotoVideoQueue {
  private readonly controller = new AbortController();
  private worker?: Promise<void>;
  private readonly attempted = new Set<string>();

  constructor(
    private readonly service: FashionService,
    private readonly isBound: (job: PhotoVideoJob) => boolean,
    private readonly deliver: (job: PhotoVideoJob, text?: string) => Promise<void>,
  ) {}

  wake(): void {
    if (this.worker || this.controller.signal.aborted) return;
    this.worker = Promise.resolve().then(() => this.drain()).catch(() => {
      console.error('[WEFTORY] Feishu photo video queue stopped unexpectedly');
    }).finally(() => {
      this.worker = undefined;
    });
  }

  async stop(): Promise<void> {
    this.controller.abort();
    await this.worker;
  }

  private async drain(): Promise<void> {
    const signal = this.controller.signal;
    const { media, providers, store } = this.service;
    while (!signal.aborted) {
      const job = store.pendingPhotoVideos().find(item => !this.attempted.has(item.id) && this.isBound(item));
      if (!job) return;
      try {
        if (job.state === PhotoVideoState.Submitting) {
          await this.deliver(job, t('fashionBotPhotoVideoUnknown'));
        } else {
          if (job.state === PhotoVideoState.Queued) {
            if (!job.product || !job.plan) fail(FashionError.Invalid);
            const body = await providers.photoVideoRequest(job.model, job.product, job.plan, job.modelPhoto);
            if (signal.aborted || !this.isBound(job)) continue;
            job.state = PhotoVideoState.Submitting;
            store.savePhotoVideo(job);
            job.remoteId = await providers.submitVideo(body, signal);
            job.state = PhotoVideoState.Submitted;
            store.savePhotoVideo(job);
          }
          if (job.state === PhotoVideoState.Submitted && job.remoteId) {
            const video = await providers.getVideo(job.remoteId, signal);
            await media.verifyPhotoVideo(video, signal);
            job.video = video;
            job.state = PhotoVideoState.Ready;
            store.savePhotoVideo(job);
          }
          if (!signal.aborted && this.isBound(job)) await this.deliver(job);
          else continue;
        }
      } catch (error) {
        if (signal.aborted || !this.isBound(job)) continue;
        const ambiguous = job.state === PhotoVideoState.Submitting && !(error instanceof ProviderRejected);
        const text = ambiguous ? t('fashionBotPhotoVideoUnknown') : t('fashionBotPhotoVideoFailed');
        if (job.state === PhotoVideoState.Ready) {
          console.warn('[WEFTORY] Feishu photo video delivery will retry after restart');
          this.attempted.add(job.id);
          continue;
        }
        if (job.state === PhotoVideoState.Submitted && !(error instanceof ProviderRejected)) {
          // Keep the upstream task ID so a temporary failure can resume by polling.
          await this.deliver(job, text).catch((): void => undefined);
          this.attempted.add(job.id);
          continue;
        }
        await this.deliver(job, text).catch((): void => undefined);
      }
      job.state = PhotoVideoState.Finished;
      store.savePhotoVideo(job);
    }
  }
}
