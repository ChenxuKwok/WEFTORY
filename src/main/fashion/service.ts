import { createHash, randomUUID } from 'node:crypto';

import {
  type Asset, type Character,   Decision, type FashionApi, FashionError, type FashionSnapshot, type Plan, planSchema, type Product, type Run,
RunMode, RunState, ShotRole, ShotSource,
} from '../../shared/fashion/contracts';
import { fail,FashionFailure } from './errors';
import type { FashionMedia } from './media';
import { type FashionProviders,fashionTextRequest, ProviderRejected } from './providers';
import { type FashionStore, type ProviderTask,TaskState } from './store';

type Input<Method extends keyof FashionApi> = Parameters<FashionApi[Method]>[0];
type Shot = Run['shots'][number];
type PaidResult = { asset?: Asset; remoteId?: string };
type Phase = (typeof RunState)[keyof typeof RunState];
const runnable: ReadonlySet<Phase> = new Set([RunState.Queued, RunState.Scripting, RunState.Generating, RunState.Assembling]);
const stoppable: ReadonlySet<Phase> = new Set([...runnable, RunState.Plan, RunState.Review, RunState.Rework,
  RunState.Budget, RunState.Reconcile, RunState.Failed]);
const restartable: ReadonlySet<Phase> = new Set([RunState.Failed, RunState.Budget, RunState.Reconcile]);
const demoProduct: Product = {
  id: '00000000-0000-4000-8000-000000000001', sku: 'DEMO', title: 'Demo SKU',
  facts: '', forbidden: '', rights: 'WEFTORY', images: [],
};
const demoCharacter: Character = {
  id: '00000000-0000-4000-8000-000000000002', name: 'Demo', persona: '', image: '', arkAsset: '',
};
const demoPlan: Plan = {
  schemaVersion: 1,
  shots: [
    { direction: 'Introduce the commuter outfit.', caption: 'A commuter outfit in six shots' },
    { direction: 'Show the full outfit from the front.', caption: 'Full look' },
    { direction: 'Focus on a product detail.', caption: 'Product details' },
    { direction: 'Show the outfit in motion.', caption: 'In motion' },
    { direction: 'Show a second styling angle.', caption: 'Styling' },
    { direction: 'Finish with a clear product shot.', caption: 'See the full look' },
  ],
};

export class FashionService {
  private active?: { id: string; controller: AbortController };
  private worker?: Promise<void>;
  private stopped = true;

  constructor(
    readonly store: FashionStore,
    readonly media: FashionMedia,
    readonly providers: FashionProviders,
    private readonly changed: (run: Run) => void,
    private readonly arkConfigured: () => boolean,
  ) {}

  start(): void {
    this.stopped = false;
    this.wake();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.active?.controller.abort();
    await this.worker;
  }

  snapshot(): FashionSnapshot {
    return {
      runs: this.store.runs(), products: this.store.products(), characters: this.store.characters(),
      settings: this.store.getSettings(), arkConfigured: this.arkConfigured(),
    };
  }

  saveProduct(input: Input<'saveProduct'>): Product {
    input.images.forEach(id => this.image(id));
    if (input.id && !this.store.products().some(product => product.id === input.id)) fail(FashionError.Invalid);
    const existingSku = this.store.products().find(product => product.sku === input.sku);
    if (existingSku && existingSku.id !== input.id) fail(FashionError.Invalid);
    const product = { ...input, id: input.id ?? randomUUID() };
    this.store.saveProduct(product);
    return product;
  }

  saveCharacter(input: Input<'saveCharacter'>): Character {
    this.image(input.image);
    if (input.id && !this.store.characters().some(character => character.id === input.id)) fail(FashionError.Invalid);
    const character = { ...input, id: input.id ?? randomUUID() };
    this.store.saveCharacter(character);
    return character;
  }

  create(input: Input<'create'>): string {
    const demo = input.mode === RunMode.Demo;
    const product = demo ? demoProduct : this.store.products().find(item => item.id === input.productId);
    const character = demo ? demoCharacter : this.store.characters().find(item => item.id === input.characterId);
    if (!product || !character) fail(FashionError.Invalid);
    if (!demo && !character.arkAsset && !character.allowFirstFrame) fail(FashionError.Setup);
    const { imageModel, videoModel, textCents, frameCents, clipCents, feishuInstance, feishuOwner } = this.store.getSettings();
    if (!demo && (!this.arkConfigured() || !this.providers.textConfigured() || !imageModel || !videoModel)) fail(FashionError.Setup);
    const run: Run = {
      id: randomUUID(), mode: input.mode, product, character, version: 1,
      state: RunState.Queued, updatedAt: Date.now(), maxCents: input.maxCents, reservedCents: 0,
      recipient: !demo && feishuInstance && feishuOwner ? { instance: feishuInstance, owner: feishuOwner } : undefined,
      models: demo ? undefined : { imageModel, videoModel, textCents, frameCents, clipCents },
      shots: ShotRole.map((role, index) => ({
        number: index + 1, attempt: 0,
        source: demo ? ShotSource.Demo : role === 'detail' || role === 'cta' ? ShotSource.Product : ShotSource.Generated,
      })),
    };
    this.save(run);
    this.wake();
    return run.id;
  }

  savePlan(input: Input<'savePlan'>): void {
    const run = this.expect(input.id, input.version, RunState.Plan);
    this.save({ ...run, plan: input.plan, version: run.version + 1 });
  }

  approvePlan(input: Input<'approvePlan'>): void {
    const run = this.expect(input.id, input.version, RunState.Plan);
    this.save({ ...run, state: RunState.Generating });
    this.wake();
  }

  review(input: Input<'review'>, reviewer = 'desktop'): void {
    const run = this.expect(input.id, input.version, RunState.Review);
    if (run.final?.id !== input.assetId || run.final.sha256 !== input.sha256) fail(FashionError.State);
    this.store.atomic(() => {
      this.store.saveReview(run.id, { ...input, reviewer, at: Date.now() });
      const state = input.decision === Decision.Approve
        ? RunState.Approved : input.decision === Decision.Return ? RunState.Rework : RunState.Rejected;
      this.save({ ...run, reviewComment: input.comment, state,
        delivery: state === RunState.Approved && run.recipient ? 'pending' : undefined });
    });
  }

  rework(input: Input<'rework'>): void {
    const run = this.expect(input.id, input.version, RunState.Review, RunState.Rework, RunState.Approved);
    this.save({
      ...run, final: undefined, delivery: undefined, reviewComment: undefined,
      version: run.version + 1, state: RunState.Generating,
      shots: run.shots.map(shot => shot.number === input.shot ? {
        number: shot.number, source: shot.source, attempt: shot.attempt + 1, comment: input.comment,
      } : shot),
    });
    this.wake();
  }

  retry(input: Input<'retry'>): void {
    const run = this.requireRun(input.id);
    if (!restartable.has(run.state) || this.active?.id === run.id && !this.active.controller.signal.aborted) fail(FashionError.State);
    if (run.state === RunState.Reconcile && !input.reconcile) fail(FashionError.Reconcile);
    this.store.atomic(() => {
      if (run.state === RunState.Reconcile) {
        for (const task of this.store.tasks(run.id)) {
          if (task.state === TaskState.Submitting) this.store.saveTask({ ...task, state: TaskState.Abandoned });
        }
      }
      const invalidScript = !run.plan && run.state === RunState.Failed
        && this.store.tasks(run.id).filter(task => task.id.includes(`/text-${run.scriptRevision ?? 0}-`)
          && task.state === TaskState.Completed && !task.plan).length >= 3;
      this.save({
        ...run, error: undefined,
        scriptRevision: invalidScript ? (run.scriptRevision ?? 0) + 1 : run.scriptRevision,
        maxCents: Math.max(input.maxCents ?? run.maxCents, run.reservedCents),
        state: run.plan ? RunState.Generating : RunState.Queued,
      });
    });
    this.wake();
  }

  cancel(id: string): void {
    const run = this.requireRun(id);
    if (run.state === RunState.Cancelled) return;
    if (!stoppable.has(run.state)) fail(FashionError.State);
    this.save({ ...run, state: RunState.Cancelled });
    if (this.active?.id === id) this.active.controller.abort();
    for (const task of this.store.tasks(id)) {
      if (task.state === TaskState.Submitted && task.remoteId) {
        void this.providers.cancelVideo(task.remoteId).catch(() => {
          console.warn('[WEFTORY] Remote cancellation was not confirmed for run', id);
        });
      }
    }
  }

  approved(id: string, version: number): Asset {
    return this.expect(id, version, RunState.Approved).final ?? fail(FashionError.State);
  }

  updateDelivery(id: string, version: number, delivery: Run['delivery']): void {
    const run = this.store.getRun(id);
    if (run?.version === version && run.state === RunState.Approved) this.save({ ...run, delivery });
  }

  private wake(): void {
    if (this.worker || this.stopped) return;
    this.worker = Promise.resolve().then(() => this.drain()).catch(() => {
      console.error('[WEFTORY] Production worker stopped unexpectedly');
    }).finally(() => { this.worker = undefined; });
  }

  private async drain(): Promise<void> {
    while (!this.stopped) {
      const run = this.store.runs().reverse().find(item => runnable.has(item.state));
      if (!run) return;
      const controller = new AbortController();
      this.active = { id: run.id, controller };
      try {
        await this.work(run, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) continue;
        const code = error instanceof FashionFailure ? error.code : FashionError.Storage;
        const state = code === FashionError.Budget ? RunState.Budget
          : code === FashionError.Reconcile ? RunState.Reconcile : RunState.Failed;
        this.save({ ...run, error: code, state });
        console.warn('[WEFTORY] Run stopped', run.id, code);
      } finally {
        this.active = undefined;
      }
    }
  }

  private async work(run: Run, signal: AbortSignal): Promise<void> {
    if (!run.plan) {
      run.state = RunState.Scripting;
      this.save(run);
      const plan = run.mode === RunMode.Demo ? demoPlan : await this.script(run, signal);
      signal.throwIfAborted();
      this.save({ ...run, plan, state: RunState.Plan });
      return;
    }
    if (run.state !== RunState.Assembling) {
      for (const shot of run.shots) {
        if (shot.ready) continue;
        await this.generate(run, shot, signal);
        signal.throwIfAborted();
        shot.ready = true;
        this.save(run);
      }
      run.state = RunState.Assembling;
      this.save(run);
    }
    const final = await this.media.assemble(run, signal);
    signal.throwIfAborted();
    this.store.atomic(() => {
      this.store.saveRender({
        runId: run.id, version: run.version, asset: final, plan: run.plan, shots: run.shots,
        productId: run.product.id, characterId: run.character.id,
      });
      this.save({ ...run, final, state: RunState.Review });
    });
  }

  private async script(run: Run, signal: AbortSignal): Promise<Plan> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const request = fashionTextRequest(run, attempt > 0);
      const stage = `text-${run.scriptRevision ?? 0}-${attempt}`;
      const completed = this.store.tasks(run.id).find(task => task.id.startsWith(`${run.id}/${stage}/`) && task.state === TaskState.Completed);
      if (completed?.plan) return completed.plan;
      if (completed) continue;
      let plan: Plan | undefined;
      await this.paid(run, stage, request, run.models?.textCents, async () => {
        const raw = await this.providers.text(run, attempt > 0, signal);
        try {
          plan = planSchema.parse(JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/gi, '')));
        } catch {
          // A syntactically valid provider response may still fail the manifest contract.
        }
        return { plan };
      }, signal);
      if (plan) return plan;
    }
    return fail(FashionError.Provider);
  }

  private async generate(run: Run, shot: Shot, signal: AbortSignal): Promise<void> {
    if (shot.source === ShotSource.Demo) return;
    const imageIndex = shot.source === ShotSource.Product
      ? (shot.attempt + Number(shot.number === 3)) % run.product.images.length : 0;
    const product = this.image(run.product.images[imageIndex]);
    if (shot.source === ShotSource.Product) {
      shot.frame = product;
      return;
    }
    const models = run.models ?? fail(FashionError.Setup);
    const scope = `shot-${shot.number}-${shot.attempt}`;
    if (!shot.frame) {
      const body = await this.providers.frameRequest(models.imageModel, run, shot, product, this.image(run.character.image));
      shot.frame = (await this.paid(run, `${scope}-frame`, body, models.frameCents, async () => ({
        asset: await this.providers.generateFrame(body, signal),
      }), signal)).asset;
      this.save(run);
    }
    if (!shot.clip) {
      if (!shot.frame) fail(FashionError.Media);
      const body = await this.providers.videoRequest(models.videoModel, run, shot, shot.frame, product);
      const stage = `${scope}-clip`;
      const result = await this.paid(run, stage, body, models.clipCents, async () => ({
        remoteId: await this.providers.submitVideo(body, signal),
      }), signal);
      if (result.asset) {
        shot.clip = result.asset;
        return;
      }
      const remoteId = result.remoteId ?? fail(FashionError.Provider);
      try {
        shot.clip = await this.providers.getVideo(remoteId, signal);
        this.store.saveTask({ ...result, asset: shot.clip, state: TaskState.Completed });
      } catch (error) {
        if (error instanceof ProviderRejected) this.store.saveTask({ ...result, state: TaskState.Rejected });
        if (error instanceof FashionFailure) throw error;
        fail(FashionError.Provider);
      }
    }
  }

  private async paid(
    run: Run, stage: string, request: object, cost: number | undefined,
    submit: () => Promise<PaidResult & { plan?: Plan }>, signal: AbortSignal,
  ): Promise<ProviderTask> {
    signal.throwIfAborted();
    const prefix = `${run.id}/${stage}/`;
    const prior = this.store.tasks(run.id).filter(task => task.id.startsWith(prefix));
    const current = prior[prior.length - 1];
    if (current?.state === TaskState.Submitting) fail(FashionError.Reconcile);
    if (current?.state === TaskState.Submitted || current?.state === TaskState.Completed) return current;
    if (!cost || run.reservedCents + cost > run.maxCents) fail(FashionError.Budget);
    const task: ProviderTask = {
      id: `${prefix}${prior.length + 1}`, runId: run.id, state: TaskState.Submitting, cost,
      requestHash: createHash('sha256').update(JSON.stringify(request)).digest('hex'),
    };
    this.store.atomic(() => {
      this.store.saveTask(task);
      run.reservedCents += cost;
      this.save(run);
    });
    try {
      const result = await submit();
      const saved = { ...task, ...result, state: result.remoteId ? TaskState.Submitted : TaskState.Completed };
      this.store.saveTask(saved);
      if (result.remoteId && signal.aborted && this.store.getRun(run.id)?.state === RunState.Cancelled) {
        void this.providers.cancelVideo(result.remoteId).catch(() => {
          console.warn('[WEFTORY] Remote cancellation was not confirmed for run', run.id);
        });
      }
      signal.throwIfAborted();
      return saved;
    } catch (error) {
      if (signal.aborted) throw error;
      if (!(error instanceof ProviderRejected)) fail(FashionError.Reconcile);
      this.store.atomic(() => {
        this.store.saveTask({ ...task, state: TaskState.Rejected });
        run.reservedCents -= cost;
        this.save(run);
      });
      throw error;
    }
  }

  private image(id: string): Asset {
    const asset = this.store.getAsset(id);
    if (!asset?.mime.startsWith('image/')) fail(FashionError.Media);
    return asset;
  }

  private expect(id: string, version: number, ...states: RunState[]): Run {
    const run = this.requireRun(id);
    if (run.version !== version || !states.includes(run.state)) fail(FashionError.State);
    return run;
  }

  private requireRun(id: string): Run {
    return this.store.getRun(id) ?? fail(FashionError.Invalid);
  }

  private save(run: Run): void {
    this.store.saveRun(run);
    this.changed(run);
  }
}
