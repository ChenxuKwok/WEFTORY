export const FashionName = 'WEFTORY';
export const FashionLogoFile = 'weftory-mark.png';
export const DefaultSeedanceModel = 'doubao-seedance-2-5-260628';
export const ArkRechargeUrl = 'https://console.volcengine.com/finance/fund/recharge';

export const FashionIpc = {
  Snapshot: 'fashion:snapshot',
  Import: 'fashion:import',
  SaveProduct: 'fashion:saveProduct',
  SaveCharacter: 'fashion:saveCharacter',
  SaveSettings: 'fashion:saveSettings',
  TestSetup: 'fashion:testSetup',
  Create: 'fashion:create',
  SavePlan: 'fashion:savePlan',
  ApprovePlan: 'fashion:approvePlan',
  Review: 'fashion:review',
  Rework: 'fashion:rework',
  Retry: 'fashion:retry',
  Cancel: 'fashion:cancel',
  Export: 'fashion:export',
  Changed: 'fashion:changed',
} as const;

export const FashionMediaScheme = 'weftory-media';
export const FashionPluginId = 'weftory-fashion';
export const FashionBridgeRoute = '/weftory-command';

export const RunState = {
  Queued: 'queued',
  Scripting: 'scripting',
  Plan: 'plan',
  Generating: 'generating',
  Assembling: 'assembling',
  Review: 'review',
  Approved: 'approved',
  Rework: 'rework',
  Rejected: 'rejected',
  Cancelled: 'cancelled',
  Failed: 'failed',
  Budget: 'budget',
  Reconcile: 'reconcile',
} as const;
export type RunState = typeof RunState[keyof typeof RunState];

export const RunMode = { Demo: 'demo', Live: 'live' } as const;
export const Decision = { Approve: 'approve', Return: 'return', Reject: 'reject' } as const;
export const ShotSource = { Generated: 'generated', Product: 'product', Demo: 'demo' } as const;
export const ShotRole = ['hook', 'full_look', 'detail', 'movement', 'styling', 'cta'] as const;
export const ShotDuration = [3, 4, 3, 4, 4, 3] as const;
export const FashionError = {
  Invalid: 'invalid',
  Media: 'media',
  State: 'state',
  Setup: 'setup',
  Storage: 'storage',
  Provider: 'provider',
  Budget: 'budget',
  Reconcile: 'reconcile',
} as const;
export type FashionError = typeof FashionError[keyof typeof FashionError];
