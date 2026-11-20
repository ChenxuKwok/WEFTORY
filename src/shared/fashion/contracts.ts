import { z } from 'zod';

import { Decision, type FashionError, FeishuVideoCardAction, RunMode, type RunState, type ShotSource } from './constants';

export * from './constants';

export const idSchema = z.uuid();
const label = z.string().trim().min(1).max(100);
const memo = z.string().trim().max(1500);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const cents = z.number().int().min(0).max(10_000_000);

export const productSchema = z.object({
  id: idSchema.optional(),
  sku: label.regex(/^[\w.-]+$/),
  title: label,
  facts: memo,
  forbidden: memo,
  rights: label,
  images: z.array(idSchema).min(1).max(8),
});
export const characterSchema = z.object({
  id: idSchema.optional(),
  name: label,
  persona: memo,
  image: idSchema,
  arkAsset: z.string().trim().regex(/^(asset:\/\/[\w-]+)?$/),
  allowFirstFrame: z.boolean().optional(),
});
export const planSchema = z.object({
  schemaVersion: z.literal(1),
  shots: z.array(z.object({
    direction: z.string().trim().min(1).max(600),
    caption: z.string().trim().max(90),
  })).length(6),
});
export const settingsSchema = z.object({
  imageModel: z.string().trim().max(100),
  videoModel: z.string().trim().max(100),
  textCents: cents,
  frameCents: cents,
  clipCents: cents,
  feishuInstance: z.string().trim().max(100),
  feishuOwner: z.string().trim().regex(/^(ou_[\w-]+)?$/),
});
export const saveSettingsSchema = settingsSchema.extend({ arkKey: z.string().trim().min(1).max(512).optional() });
export const createSchema = z.object({
  mode: z.enum(RunMode),
  productId: idSchema.optional(),
  characterId: idSchema.optional(),
  maxCents: cents,
});
export const versionSchema = z.object({ id: idSchema, version: z.number().int().positive() });
export const savePlanSchema = versionSchema.extend({ plan: planSchema });
export const reviewSchema = versionSchema.extend({
  assetId: idSchema,
  sha256,
  decision: z.enum(Decision),
  comment: memo,
});
export const reworkSchema = versionSchema.extend({ shot: z.number().int().min(1).max(6), comment: memo });
export const retrySchema = z.object({ id: idSchema, maxCents: cents.optional(), reconcile: z.boolean().optional() });
export const bridgeSchema = z.object({
  accountId: label,
  senderId: label,
  messageId: label,
  conversationId: label,
  groupChatId: z.string().regex(/^oc_[\w-]+$/).max(100).optional(),
  command: z.string().max(1600).optional(),
  imageFile: z.string().max(256).regex(/^(?:[\p{L}\p{N}._-]+---)?[\da-f-]{36}\.(?:png|jpe?g)$/iu).optional(),
  imageUnavailable: z.literal(true).optional(),
  card: z.object({
    action: z.enum(FeishuVideoCardAction),
    draftId: idSchema,
    revision: z.number().int().positive(),
    model: memo.optional(),
    script: memo.optional(),
  }).optional(),
}).refine(input => [input.command, input.imageFile, input.imageUnavailable, input.card].filter(Boolean).length === 1);

export const photoVideoPlanSchema = z.object({
  model: z.string().trim().min(1).max(280),
  storyboard: z.string().trim().min(1).max(1500),
});
export type PhotoVideoPlan = z.infer<typeof photoVideoPlanSchema>;

export type Product = z.infer<typeof productSchema> & { id: string };
export type Character = z.infer<typeof characterSchema> & { id: string };
export type Settings = z.infer<typeof settingsSchema>;
export type Plan = z.infer<typeof planSchema>;
export type Asset = { id: string; sha256: string; mime: string };
export type RunShot = {
  number: number;
  attempt: number;
  source: typeof ShotSource[keyof typeof ShotSource];
  frame?: Asset;
  clip?: Asset;
  comment?: string;
  ready?: boolean;
};
export type Run = {
  id: string;
  mode: typeof RunMode[keyof typeof RunMode];
  state: RunState;
  product: Product;
  character: Character;
  plan?: Plan;
  scriptRevision?: number;
  version: number;
  shots: RunShot[];
  final?: Asset;
  reviewComment?: string;
  delivery?: 'pending' | 'sent' | 'failed' | 'uncertain';
  models?: Pick<Settings, 'imageModel' | 'videoModel' | 'textCents' | 'frameCents' | 'clipCents'>;
  recipient?: { instance: string; owner: string };
  reservedCents: number;
  maxCents: number;
  error?: FashionError;
  updatedAt: number;
};
export type FashionSnapshot = {
  runs: Run[];
  products: Product[];
  characters: Character[];
  settings: Settings;
  arkConfigured: boolean;
  feishuAccounts?: Array<{ id: string; name: string }>;
};
export type FashionResult<T> = { ok: true; value: T } | { ok: false; error: FashionError };

export interface FashionApi {
  snapshot(): Promise<FashionResult<FashionSnapshot>>;
  importImage(): Promise<FashionResult<Asset | null>>;
  saveProduct(input: z.infer<typeof productSchema>): Promise<FashionResult<Product>>;
  saveCharacter(input: z.infer<typeof characterSchema>): Promise<FashionResult<Character>>;
  saveSettings(input: z.infer<typeof saveSettingsSchema>): Promise<FashionResult<void>>;
  testSetup(): Promise<FashionResult<{ ffmpeg: boolean; text: boolean; ark: boolean; feishu: boolean }>>;
  create(input: z.infer<typeof createSchema>): Promise<FashionResult<string>>;
  savePlan(input: z.infer<typeof savePlanSchema>): Promise<FashionResult<void>>;
  approvePlan(input: z.infer<typeof versionSchema>): Promise<FashionResult<void>>;
  review(input: z.infer<typeof reviewSchema>): Promise<FashionResult<void>>;
  rework(input: z.infer<typeof reworkSchema>): Promise<FashionResult<void>>;
  retry(input: z.infer<typeof retrySchema>): Promise<FashionResult<void>>;
  cancel(id: string): Promise<FashionResult<void>>;
  exportRun(input: z.infer<typeof versionSchema>): Promise<FashionResult<boolean>>;
  onChanged(callback: (update: { id: string; version: number }) => void): () => void;
}
