import { type FormEvent, type ReactNode,useCallback, useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import { Decision, FashionError, FashionMediaScheme, RunMode, RunState, ShotRole } from '../../../shared/fashion/constants';
import type { Character, FashionApi, FashionResult, FashionSnapshot, Plan, Product, Run } from '../../../shared/fashion/contracts';
import { i18nService } from '../../services/i18n';
import type { RootState } from '../../store';
import { chooseFashionRun, receiveFashionSnapshot } from '../../store/slices/fashionSlice';

const t = (key: string, values?: Record<string, string>) => i18nService.t(key)
  .replace(/\{(\w+)\}/g, (placeholder, token: string) => values?.[token] ?? placeholder);
const panel = 'rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-900';
const field = 'w-full rounded-lg border border-slate-200 bg-transparent px-3 py-2 text-sm focus-visible:outline-blue-500 dark:border-slate-700';
const button = 'rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-100 disabled:opacity-40 dark:border-slate-600 dark:hover:bg-slate-800';
const primary = 'rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-40 dark:bg-blue-600 dark:hover:bg-blue-500';
const eyebrow = 'text-xs font-medium text-slate-500 dark:text-slate-400';
const tabs = { Queue: 'fashionQueue', Assets: 'fashionAssets', Settings: 'fashionSettings' } as const;
type Tab = typeof tabs[keyof typeof tabs];
type Action = <T>(request: () => Promise<FashionResult<T>>) => Promise<T | undefined>;
const mediaUrl = (id: string) => `${FashionMediaScheme}://asset/${id}`;
const money = (cents: number) => (cents / 100).toFixed(2);
const formText = (data: FormData, name: string) => String(data.get(name) ?? '');
const formCents = (data: FormData, name: string) => Math.round(Number(formText(data, name)) * 100);

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="grid gap-1.5"><span className={eyebrow}>{t(label)}</span>{children}</label>;
}

function Money({ name, label, value, required }: { name: string; label: string; value?: number; required?: boolean }) {
  return <Field label={label}><input className={field} name={name} type="number" min="0" max="100000" step="0.01"
    defaultValue={value === undefined ? undefined : money(value)} required={required} /></Field>;
}

export default function FashionHome({ api }: { api: FashionApi }) {
  const [tab, setTab] = useState<Tab>(tabs.Queue);
  const { snapshot, runId } = useSelector((state: RootState) => state.fashion);
  const dispatch = useDispatch();
  const [error, setError] = useState<FashionError>();
  const [busy, setBusy] = useState(false);
  const sequence = useRef({ latest: 0 });
  const refresh = useCallback(async () => {
    const calls = sequence.current;
    const next = ++calls.latest;
    const result = await api.snapshot();
    if (next !== calls.latest) return;
    if (result.ok) dispatch(receiveFashionSnapshot(result.value));
    else setError(result.error);
  }, [api, dispatch]);

  useEffect(() => {
    const calls = sequence.current;
    const update = () => { void refresh().catch(() => setError(FashionError.Storage)); };
    update();
    const unsubscribe = api.onChanged(update);
    window.addEventListener('focus', update);
    return () => {
      calls.latest++;
      unsubscribe();
      window.removeEventListener('focus', update);
    };
  }, [api, refresh]);

  const act: Action = async request => {
    setError(undefined);
    setBusy(true);
    try {
      const result = await request();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      await refresh();
      return result.value;
    } catch {
      setError(FashionError.Storage);
    } finally {
      setBusy(false);
    }
  };

  const run = snapshot?.runs.find(item => item.id === runId) ?? snapshot?.runs[0];
  const create = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    const data = event && new FormData(event.currentTarget);
    const id = await act(() => api.create(data ? {
      mode: RunMode.Live, productId: formText(data, 'product'), characterId: formText(data, 'character'),
      maxCents: formCents(data, 'budget'),
    } : { mode: RunMode.Demo, maxCents: 0 }));
    if (id) dispatch(chooseFashionRun(id));
  };

  return (
    <main className="h-full min-h-0 w-full overflow-y-auto bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <div className="mx-auto grid max-w-6xl gap-5 p-6 lg:p-9">
        <header>
          <h1 className="text-3xl font-semibold tracking-tight">{t('fashionName')}</h1>
          <nav aria-label={t('fashionName')} className="mt-4 flex flex-wrap gap-2 border-b border-slate-200 dark:border-slate-800">
            {Object.values(tabs).map(value => <button key={value} type="button" onClick={() => { setTab(value); setError(undefined); }}
              aria-current={tab === value ? 'page' : undefined}
              className={`border-b-2 px-3 py-2 text-sm ${tab === value ? 'border-blue-600 font-semibold' : 'border-transparent text-slate-500'}`}>
              {t(value)}
            </button>)}
          </nav>
        </header>
        {error && <div role="alert" className="rounded-lg border border-rose-200 px-4 py-3 text-sm text-rose-700 dark:border-rose-900 dark:text-rose-300">
          {t(`fashionError.${error}`)}
        </div>}
        {snapshot && <fieldset disabled={busy} className="min-w-0">
          {tab === tabs.Queue && <div className="grid gap-5">
            <section className={panel}>
              <div className="mb-4 flex items-start justify-between gap-3">
                <div><h2 className="font-semibold">{t('fashionNewRun')}</h2><p className={eyebrow}>{t('fashionTemplate')}</p></div>
                <button className={button} type="button" onClick={() => { void create(); }}>{t('fashionDemo')}</button>
              </div>
              <form onSubmit={create} className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_auto]">
                <Field label="fashionProduct"><select name="product" className={field} required>
                  <option value="">{t('fashionChoose')}</option>
                  {snapshot.products.map(product => <option key={product.id} value={product.id}>{product.sku} · {product.title}</option>)}
                </select></Field>
                <Field label="fashionCharacter"><select name="character" className={field} required>
                  <option value="">{t('fashionChoose')}</option>
                  {snapshot.characters.map(character => <option key={character.id} value={character.id}>{character.name}</option>)}
                </select></Field>
                <Money name="budget" label="fashionBudget" required />
                <button className={primary} type="submit" disabled={!snapshot.products.length || !snapshot.characters.length}>
                  {t('fashionNewRun')}
                </button>
              </form>
            </section>
            <div className="grid items-start gap-5 lg:grid-cols-[230px_minmax(0,1fr)]">
              <section className={panel}>
                <h2 className="mb-3 font-semibold">{t('fashionQueue')}</h2>
                {!snapshot.runs.length && <p className="text-sm text-slate-500">{t('fashionEmpty')}</p>}
                <ul className="grid gap-2">
                  {snapshot.runs.map(item => <li key={item.id}>
                    <button type="button" aria-pressed={item.id === run?.id} onClick={() => dispatch(chooseFashionRun(item.id))}
                      className={`w-full rounded-lg p-2.5 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800 ${item.id === run?.id ? 'bg-slate-100 dark:bg-slate-800' : ''}`}>
                      <span className="block truncate font-medium">{item.product.title}</span>
                      <span className={eyebrow}>{item.id.slice(0, 8).toUpperCase()} · {t(`fashionState.${item.state}`)}</span>
                    </button>
                  </li>)}
                </ul>
              </section>
              {run && <RunDetail key={`${run.id}/${run.version}`} run={run} api={api} act={act} />}
            </div>
          </div>}
          {tab === tabs.Assets && <div className="grid gap-5 lg:grid-cols-2">
            <CatalogEditor type="product" snapshot={snapshot} api={api} act={act} />
            <CatalogEditor type="character" snapshot={snapshot} api={api} act={act} />
          </div>}
          {tab === tabs.Settings && <SettingsEditor key={JSON.stringify(snapshot.settings)} snapshot={snapshot} api={api} act={act} />}
        </fieldset>}
      </div>
    </main>
  );
}

function CatalogEditor({ type, snapshot, api, act }: {
  type: 'product' | 'character'; snapshot: FashionSnapshot; api: FashionApi; act: Action;
}) {
  const [selected, setSelected] = useState('');
  const isProduct = type === 'product';
  const items = isProduct ? snapshot.products : snapshot.characters;
  const existing = items.find(item => item.id === selected);
  return <section className={panel}>
    <div className="mb-4 flex items-center justify-between gap-4">
      <h2 className="font-semibold">{t(isProduct ? 'fashionProduct' : 'fashionCharacter')}</h2>
      <select value={selected} className={`${field} max-w-48`} aria-label={t(isProduct ? 'fashionProduct' : 'fashionCharacter')}
        onChange={event => setSelected(event.target.value)}>
        <option value="">{t('fashionNew')}</option>
        {items.map(item => <option key={item.id} value={item.id}>{'title' in item ? item.title : item.name}</option>)}
      </select>
    </div>
    <CatalogForm key={selected} existing={existing} isProduct={isProduct} api={api} act={act} onSave={setSelected} />
  </section>;
}

function CatalogForm({ existing, isProduct, api, act, onSave }: {
  existing?: Product | Character; isProduct: boolean; api: FashionApi; act: Action; onSave: (id: string) => void;
}) {
  const product = existing && 'sku' in existing ? existing : undefined;
  const character = existing && 'image' in existing ? existing : undefined;
  const [images, setImages] = useState(product?.images ?? (character ? [character.image] : []));
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const saved = isProduct
      ? await act(() => api.saveProduct({ id: product?.id, sku: formText(data, 'sku'), title: formText(data, 'title'),
        facts: formText(data, 'facts'), forbidden: formText(data, 'forbidden'), rights: formText(data, 'rights'), images }))
      : await act(() => api.saveCharacter({ id: character?.id, name: formText(data, 'name'), persona: formText(data, 'persona'),
        arkAsset: formText(data, 'avatar'), allowFirstFrame: data.has('firstFrame'), image: images[0] }));
    if (saved) onSave(saved.id);
  };
  return <form onSubmit={submit} className="grid gap-3">
    {isProduct ? <>
      <Field label="fashionSku"><input className={field} name="sku" defaultValue={product?.sku} maxLength={100} required /></Field>
      <Field label="fashionTitle"><input className={field} name="title" defaultValue={product?.title} maxLength={100} required /></Field>
      <Field label="fashionFacts"><textarea className={field} name="facts" defaultValue={product?.facts} maxLength={1500} /></Field>
      <Field label="fashionForbidden"><textarea className={field} name="forbidden" defaultValue={product?.forbidden} maxLength={1500} /></Field>
      <Field label="fashionRights"><input className={field} name="rights" defaultValue={product?.rights} maxLength={100} required /></Field>
    </> : <>
      <Field label="fashionCharacterName"><input className={field} name="name" defaultValue={character?.name} maxLength={100} required /></Field>
      <Field label="fashionPersona"><textarea className={field} name="persona" defaultValue={character?.persona} maxLength={1500} /></Field>
      <Field label="fashionAvatar"><input className={field} name="avatar" defaultValue={character?.arkAsset} placeholder="asset://…" /></Field>
      <p className={eyebrow}>{t('fashionModelNote')}</p>
      <label className="flex items-start gap-2 text-sm">
        <input name="firstFrame" type="checkbox" defaultChecked={character?.allowFirstFrame} />
        {t('fashionFirstFrame')}
      </label>
    </>}
    <div className="flex flex-wrap gap-2">
      {images.map((image, index) => <div key={`${image}/${index}`} className="group relative">
        <img src={mediaUrl(image)} alt={t(isProduct ? 'fashionProduct' : 'fashionCharacter')} className="h-20 w-20 rounded-lg object-cover" />
        <button type="button" className="absolute right-0 top-0 rounded bg-slate-950 px-1.5 text-white"
          title={t('fashionImageRemove')} aria-label={t('fashionImageRemove')}
          onClick={() => setImages(current => current.filter((_, i) => i !== index))}>×</button>
      </div>)}
    </div>
    <div className="flex gap-2">
      <button type="button" className={button} disabled={isProduct && images.length >= 8} onClick={async () => {
        const image = await act(() => api.importImage());
        if (image) setImages(current => isProduct ? [...current, image.id] : [image.id]);
      }}>{t('fashionImageImport')}</button>
      <button type="submit" className={primary} disabled={!images.length}>{t('fashionSave')}</button>
    </div>
  </form>;
}

function SettingsEditor({ snapshot, api, act }: { snapshot: FashionSnapshot; api: FashionApi; act: Action }) {
  const [checked, setChecked] = useState<{ ffmpeg: boolean; text: boolean; ark: boolean; feishu: boolean }>();
  const [saved, setSaved] = useState(false);
  const config = snapshot.settings;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setSaved(false);
    const done = await act(async () => {
      const result = await api.saveSettings({
        imageModel: formText(data, 'imageModel'), videoModel: formText(data, 'videoModel'),
        arkKey: formText(data, 'arkKey') || undefined, feishuInstance: formText(data, 'feishuInstance'),
        feishuOwner: formText(data, 'feishuOwner'), textCents: formCents(data, 'textCents'),
        frameCents: formCents(data, 'frameCents'), clipCents: formCents(data, 'clipCents'),
      });
      return result.ok ? { ok: true, value: true } : result;
    });
    if (done) {
      const key = form.elements.namedItem('arkKey') as HTMLInputElement | null;
      if (key) key.value = '';
      setChecked(undefined);
      setSaved(true);
    }
  };
  return <section className={panel}>
    <h2 className="mb-4 font-semibold">{t('fashionSettings')}</h2>
    <form className="grid gap-4" onSubmit={submit}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="fashionArkKey"><input className={field} type="password" autoComplete="off" name="arkKey"
          placeholder={snapshot.arkConfigured ? t('fashionArkSaved') : undefined} /></Field>
        <Field label="fashionImageModel"><input className={field} name="imageModel" defaultValue={config.imageModel} /></Field>
        <Field label="fashionVideoModel"><input className={field} name="videoModel" defaultValue={config.videoModel} /></Field>
        <Money name="textCents" label="fashionTextCost" value={config.textCents} />
        <Money name="frameCents" label="fashionImageCost" value={config.frameCents} />
        <Money name="clipCents" label="fashionClipCost" value={config.clipCents} />
      </div>
      <p className={eyebrow}>{t('fashionFeeNote')}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="fashionFeishuAccount"><select className={field} name="feishuInstance" defaultValue={config.feishuInstance}>
          <option value="">{t('fashionChoose')}</option>
          {snapshot.feishuAccounts?.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}
        </select></Field>
        <Field label="fashionFeishuOwner"><input className={field} name="feishuOwner" defaultValue={config.feishuOwner} placeholder="ou_…" /></Field>
      </div>
      <p className={eyebrow}>{t('fashionFeishuNote')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className={primary}>{t('fashionSave')}</button>
        <button type="button" className={button} onClick={async () => setChecked(await act(() => api.testSetup()))}>{t('fashionConnection')}</button>
        {saved && <span role="status" className={eyebrow}>{t('fashionSaved')}</span>}
      </div>
    </form>
    {checked && <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
      {([['FFmpeg / ffprobe', checked.ffmpeg], [t('fashionTextModel'), checked.text],
        ['Ark', checked.ark], [t('fashionFeishuAccount'), checked.feishu]] as const).map(([label, available]) =>
        <div key={label}><dt className="font-medium">{label}</dt><dd>{t(available ? 'fashionCheckPass' : 'fashionCheckFail')}</dd></div>)}
    </dl>}
  </section>;
}

function RunDetail({ run, api, act }: { run: Run; api: FashionApi; act: Action }) {
  const [draft, setDraft] = useState<Plan>();
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [exported, setExported] = useState(false);
  const version = { id: run.id, version: run.version };
  const plan = draft ?? run.plan;
  const editing = run.state === RunState.Plan;
  const canRework = run.state === RunState.Review || run.state === RunState.Rework || run.state === RunState.Approved;
  const canRetry = run.state === RunState.Failed || run.state === RunState.Budget || run.state === RunState.Reconcile;
  const canCancel = run.state !== RunState.Approved && run.state !== RunState.Rejected && run.state !== RunState.Cancelled;
  const progress = run.shots.filter(shot => shot.ready).length;
  const change = (index: number, key: 'direction' | 'caption', value: string) => {
    if (!plan) return;
    setDraft({ ...plan, shots: plan.shots.map((shot, i) => i === index ? { ...shot, [key]: value } : shot) });
  };
  const review = (decision: typeof Decision[keyof typeof Decision]) => {
    const final = run.final;
    if (final) void act(() => api.review({ ...version, assetId: final.id, sha256: final.sha256, decision, comment: note }));
  };
  return <section className={panel}>
    <div className="flex flex-wrap justify-between gap-3">
      <div><h2 className="text-lg font-semibold">{run.product.title}</h2>
        <p className={eyebrow}>{run.character.name} · {t('fashionVersion', { version: String(run.version) })} · {t(`fashionState.${run.state}`)}</p></div>
      {canCancel && <button type="button" className={button} onClick={() => void act(() => api.cancel(run.id))}>{t('fashionCancel')}</button>}
    </div>
    <div className="mt-3 grid gap-1">
      <div className={`flex flex-wrap justify-between gap-2 ${eyebrow}`}>
        <span>{t('fashionProgress', { done: String(progress) })}</span>
        {run.mode === RunMode.Live && <span>{t('fashionReserved', { reserved: money(run.reservedCents), max: money(run.maxCents) })}</span>}
      </div>
      <progress className="w-full accent-blue-600" aria-label={t('fashionQueue')} value={progress} max={6} />
      {run.error && <p className="text-sm text-rose-700 dark:text-rose-300">{t(`fashionError.${run.error}`)}</p>}
      {run.delivery && <p className={eyebrow}>{t(`fashionDelivery.${run.delivery}`)}</p>}
    </div>
    {canRetry && <form className="mt-3 grid gap-2" onSubmit={event => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      void act(() => api.retry({ id: run.id, maxCents: formCents(data, 'budget'), reconcile: confirmed }));
    }}>
      <Money name="budget" label="fashionNewBudget" value={run.maxCents} required />
      {run.state === RunState.Reconcile && <label className="flex gap-2 text-sm">
        <input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />
        {t('fashionReconcileConfirm')}
      </label>}
      <button className={button} type="submit" disabled={run.state === RunState.Reconcile && !confirmed}>{t('fashionRetry')}</button>
    </form>}
    {run.final && <div className="mt-5 grid items-start gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <video src={mediaUrl(run.final.id)} controls playsInline preload="metadata" aria-label={t('fashionPreview')}
        className="max-h-[420px] w-full rounded-xl bg-slate-950" />
      <div className="grid gap-3">
        <h3 className="font-semibold">{t('fashionRender')}</h3>
        {run.product.images.length > 0 && <div className="flex flex-wrap gap-2">
          {run.product.images.map(id => <img key={id} src={mediaUrl(id)} className="h-20 w-20 rounded object-cover" alt={t('fashionProduct')} />)}
        </div>}
        {run.reviewComment && <p className="break-words text-sm">{run.reviewComment}</p>}
        {canRework && <Field label="fashionComment"><textarea maxLength={1500} value={note}
          onChange={event => setNote(event.target.value)} className={field} /></Field>}
        {run.state === RunState.Review && <div className="flex flex-wrap gap-2">
          <button type="button" className={primary} onClick={() => review(Decision.Approve)}>{t('fashionApprove')}</button>
          <button type="button" className={button} onClick={() => review(Decision.Return)}>{t('fashionReturn')}</button>
          <button type="button" className={button} onClick={() => review(Decision.Reject)}>{t('fashionReject')}</button>
        </div>}
        {run.state === RunState.Approved && <div>
          <button type="button" className={primary} onClick={async () => setExported(Boolean(await act(() => api.exportRun(version))))}>{t('fashionExport')}</button>
          {exported && <span role="status" className={`ml-2 ${eyebrow}`}>{t('fashionExported')}</span>}
        </div>}
      </div>
    </div>}
    {plan && <div className="mt-5 grid gap-3">
      <h3 className="font-semibold">{t('fashionPlan')}</h3>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {run.shots.map((shot, index) => <article key={shot.number} className="grid content-start gap-2 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
          <h4 className="text-sm font-semibold">{shot.number}. {t(`fashionShot.${ShotRole[index]}`)}</h4>
          <p className={eyebrow}>{t(`fashionSource.${shot.source}`)}</p>
          {shot.clip ? <video src={mediaUrl(shot.clip.id)} controls playsInline preload="none" className="w-full rounded-lg" />
            : shot.frame && <img src={mediaUrl(shot.frame.id)} alt={t(`fashionShot.${ShotRole[index]}`)} className="max-h-52 w-full rounded-lg object-contain" />}
          {editing ? <>
            <Field label="fashionDirection"><textarea className={field} value={plan.shots[index].direction} maxLength={600}
              onChange={event => change(index, 'direction', event.target.value)} /></Field>
            <Field label="fashionCaption"><input className={field} value={plan.shots[index].caption} maxLength={90}
              onChange={event => change(index, 'caption', event.target.value)} /></Field>
          </> : <><p className="break-words text-sm">{plan.shots[index].direction}</p>
            {plan.shots[index].caption && <p className={eyebrow}>{plan.shots[index].caption}</p>}</>}
          {canRework && <button type="button" className={button}
            onClick={() => void act(() => api.rework({ ...version, shot: shot.number, comment: note }))}>{t('fashionRework')}</button>}
        </article>)}
      </div>
      {editing && <div className="flex gap-2">
        <button type="button" className={button} disabled={!draft} onClick={() => {
          if (draft) void act(() => api.savePlan({ ...version, plan: draft }));
        }}>{t('fashionSave')}</button>
        <button type="button" className={primary} disabled={Boolean(draft)}
          onClick={() => void act(() => api.approvePlan(version))}>{t('fashionApprovePlan')}</button>
      </div>}
    </div>}
  </section>;
}
