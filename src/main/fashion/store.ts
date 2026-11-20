import type Database from 'better-sqlite3';

import { type Asset, type Character, DefaultSeedanceModel, type PhotoVideoPlan, type Plan, type Product, type Run, type Settings } from '../../shared/fashion/contracts';

export const TaskState = {
  Submitting: 'submitting',
  Submitted: 'submitted',
  Completed: 'completed',
  Rejected: 'rejected',
  Abandoned: 'abandoned',
} as const;

export type ProviderTask = {
  id: string;
  runId: string;
  requestHash: string;
  cost: number;
  plan?: Plan;
  state: typeof TaskState[keyof typeof TaskState];
  remoteId?: string;
  asset?: Asset;
};

export const PhotoVideoState = {
  Queued: 'queued',
  Submitting: 'submitting',
  Submitted: 'submitted',
  Ready: 'ready',
  Finished: 'finished',
} as const;

export type PhotoVideoJob = {
  id: string;
  instance: string;
  owner: string;
  product?: Asset;
  modelPhoto?: Asset;
  plan?: PhotoVideoPlan;
  model: string;
  state: typeof PhotoVideoState[keyof typeof PhotoVideoState];
  remoteId?: string;
  video?: Asset;
  fileKey?: string;
};

export type PhotoVideoDraft = {
  id: string;
  revision: number;
  conversation: string;
  cardMessageId?: string;
  product?: Asset;
  modelPhoto?: Asset;
  plan?: PhotoVideoPlan;
  confirmed?: boolean;
};

const defaultSettings: Settings = {
  imageModel: '',
  videoModel: DefaultSeedanceModel,
  textCents: 0,
  frameCents: 0,
  clipCents: 0,
  feishuInstance: '',
  feishuOwner: '',
};

export class FashionStore {
  constructor(private readonly db: Database.Database) {
    db.transaction(() => db.exec(`
      CREATE TABLE IF NOT EXISTS fashion_products (id TEXT PRIMARY KEY, sku TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fashion_characters (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fashion_runs (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fashion_assets (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fashion_tasks (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES fashion_runs(id), data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS fashion_tasks_run ON fashion_tasks(run_id);
      CREATE TABLE IF NOT EXISTS fashion_renders (run_id TEXT NOT NULL REFERENCES fashion_runs(id), version INTEGER NOT NULL,
        data TEXT NOT NULL, PRIMARY KEY (run_id, version));
      CREATE TABLE IF NOT EXISTS fashion_reviews (id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES fashion_runs(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fashion_events (id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES fashion_runs(id), created_at INTEGER NOT NULL, state TEXT NOT NULL, version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS fashion_settings (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL, secret BLOB);
      CREATE TABLE IF NOT EXISTS fashion_feishu_messages (id TEXT PRIMARY KEY, reply TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fashion_feishu_codes (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fashion_deliveries (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fashion_photo_videos (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fashion_photo_drafts (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    `))();
  }

  atomic<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  products(): Product[] {
    return this.all('SELECT data FROM fashion_products ORDER BY sku');
  }

  characters(): Character[] {
    return this.all('SELECT data FROM fashion_characters ORDER BY id');
  }

  runs(): Run[] {
    return this.all('SELECT data FROM fashion_runs ORDER BY updated_at DESC');
  }

  getRun(id: string): Run | undefined {
    return this.get('SELECT data FROM fashion_runs WHERE id = ?', id);
  }

  saveRun(run: Run): void {
    this.atomic(() => {
      run.updatedAt = Date.now();
      this.db.prepare(`INSERT INTO fashion_runs VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, data = excluded.data`)
        .run(run.id, run.updatedAt, JSON.stringify(run));
      this.db.prepare('INSERT INTO fashion_events (run_id, created_at, state, version) VALUES (?, ?, ?, ?)')
        .run(run.id, run.updatedAt, run.state, run.version);
    });
  }

  saveProduct(product: Product): void {
    this.db.prepare(`INSERT INTO fashion_products VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET sku = excluded.sku, data = excluded.data`)
      .run(product.id, product.sku, JSON.stringify(product));
  }

  saveCharacter(character: Character): void {
    this.db.prepare('INSERT OR REPLACE INTO fashion_characters VALUES (?, ?)').run(character.id, JSON.stringify(character));
  }

  getAsset(id: string): Asset | undefined {
    return this.get('SELECT data FROM fashion_assets WHERE id = ?', id);
  }

  saveAsset(asset: Asset): void {
    this.db.prepare('INSERT INTO fashion_assets VALUES (?, ?)').run(asset.id, JSON.stringify(asset));
  }

  tasks(runId: string): ProviderTask[] {
    return this.all('SELECT data FROM fashion_tasks WHERE run_id = ? ORDER BY rowid', runId);
  }

  getTask(id: string): ProviderTask | undefined {
    return this.get('SELECT data FROM fashion_tasks WHERE id = ?', id);
  }

  saveTask(task: ProviderTask): void {
    this.db.prepare('INSERT OR REPLACE INTO fashion_tasks VALUES (?, ?, ?)').run(task.id, task.runId, JSON.stringify(task));
  }

  saveRender(render: { runId: string; version: number; asset: Asset; plan?: Plan; shots: Run['shots'];
    productId: string; characterId: string }): void {
    this.db.prepare('INSERT INTO fashion_renders VALUES (?, ?, ?)').run(render.runId, render.version, JSON.stringify(render));
  }

  saveReview(runId: string, review: object): void {
    this.db.prepare('INSERT INTO fashion_reviews (run_id, data) VALUES (?, ?)').run(runId, JSON.stringify(review));
  }

  getSettings(): Settings {
    const saved = this.get<Settings>('SELECT data FROM fashion_settings WHERE id = 1');
    return { ...defaultSettings, ...saved, videoModel: saved?.videoModel || DefaultSeedanceModel };
  }

  getSecret(): Buffer | undefined {
    return (this.db.prepare('SELECT secret FROM fashion_settings WHERE id = 1').get() as { secret?: Buffer })?.secret;
  }

  saveSettings(settings: Settings, secret?: Buffer): void {
    this.db.prepare(`INSERT INTO fashion_settings VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data, secret = COALESCE(excluded.secret, secret)`)
      .run(JSON.stringify(settings), secret ?? null);
  }

  getMessage(id: string): string | undefined {
    return (this.db.prepare('SELECT reply FROM fashion_feishu_messages WHERE id = ?').get(id) as { reply: string } | undefined)?.reply;
  }

  saveMessage(id: string, reply: string): void {
    this.db.prepare('INSERT INTO fashion_feishu_messages VALUES (?, ?)').run(id, reply);
  }

  getCode<T>(id: string): T | undefined {
    return this.get('SELECT data FROM fashion_feishu_codes WHERE id = ?', id);
  }

  saveCode(id: string, code: object): void {
    this.db.prepare('INSERT INTO fashion_feishu_codes VALUES (?, ?)').run(id, JSON.stringify(code));
  }

  consumeCode(id: string): void {
    this.db.prepare('DELETE FROM fashion_feishu_codes WHERE id = ?').run(id);
  }

  getDelivery<T>(id: string): T | undefined {
    return this.get('SELECT data FROM fashion_deliveries WHERE id = ?', id);
  }

  saveDelivery(id: string, data: object): void {
    this.db.prepare('INSERT OR REPLACE INTO fashion_deliveries VALUES (?, ?)').run(id, JSON.stringify(data));
  }

  enqueuePhotoVideo(job: PhotoVideoJob): void {
    this.db.prepare('INSERT OR IGNORE INTO fashion_photo_videos VALUES (?, ?)').run(job.id, JSON.stringify(job));
  }

  getPhotoDraft(id: string): PhotoVideoDraft | undefined {
    return this.get('SELECT data FROM fashion_photo_drafts WHERE id = ?', id);
  }

  savePhotoDraft(id: string, draft: PhotoVideoDraft): void {
    this.db.prepare('INSERT OR REPLACE INTO fashion_photo_drafts VALUES (?, ?)').run(id, JSON.stringify(draft));
  }

  savePhotoVideo(job: PhotoVideoJob): void {
    this.db.prepare('UPDATE fashion_photo_videos SET data = ? WHERE id = ?').run(JSON.stringify(job), job.id);
  }

  pendingPhotoVideos(): PhotoVideoJob[] {
    return (this.db.prepare("SELECT data FROM fashion_photo_videos WHERE json_extract(data, '$.state') != ? ORDER BY rowid")
      .all(PhotoVideoState.Finished) as Array<{ data: string }>).map(row => JSON.parse(row.data) as PhotoVideoJob);
  }

  private all<T>(sql: string, ...params: string[]): T[] {
    return (this.db.prepare(sql).all(...params) as Array<{ data: string }>).map(row => JSON.parse(row.data) as T);
  }

  private get<T>(sql: string, ...params: string[]): T | undefined {
    const row = this.db.prepare(sql).get(...params) as { data: string } | undefined;
    return row && JSON.parse(row.data) as T;
  }
}
