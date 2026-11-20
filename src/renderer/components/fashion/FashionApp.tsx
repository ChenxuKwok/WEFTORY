import { XMarkIcon } from '@heroicons/react/24/outline';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { AppIpcChannel } from '../../../shared/app/constants';
import { FashionLogoFile } from '../../../shared/fashion/constants';
import type { FashionApi } from '../../../shared/fashion/contracts';
import { SkinProvider } from '../../providers/SkinProvider';
import { agentService } from '../../services/agent';
import { configService } from '../../services/config';
import { i18nService } from '../../services/i18n';
import { themeService } from '../../services/theme';
import Modal from '../common/Modal';
import IMSettings from '../im/IMSettings';
import Settings from '../Settings';
import FashionHome, { FashionTab } from './FashionHome';

const TERMS_URL = 'https://c.youdao.com/dict/hardware/lobsterai/lobsterai_service.html';
const Configuration = { Text: 'model', Feishu: 'im' } as const;
type Configuration = typeof Configuration[keyof typeof Configuration];
type StudioPolicy = NonNullable<Awaited<ReturnType<typeof window.electron.enterprise.getConfig>>['config']>;
const subscribeLanguage = (listener: () => void) => i18nService.subscribe(listener);
const getLanguage = () => i18nService.getLanguage();
const t = (key: string) => i18nService.t(key);

export default function FashionApp({ api }: { api: FashionApi }) {
  const language = useSyncExternalStore(subscribeLanguage, getLanguage);
  const [startup, setStartup] = useState<{ consent: boolean; policy: StudioPolicy | null }>();
  const [error, setError] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [tab, setTab] = useState<FashionTab>(FashionTab.Queue);
  const [configuration, setConfiguration] = useState<Configuration>();
  const [configurationRevision, setConfigurationRevision] = useState(0);

  useEffect(() => {
    let active = true;
    void Promise.all([
      window.electron.store.get('privacy_agreed'),
      window.electron.enterprise.getConfig(),
      configService.init(),
    ]).then(async ([consent, enterprise]) => {
      if (!active) return;
      if (!enterprise.success) throw new Error(enterprise.error || 'Enterprise configuration unavailable.');
      themeService.initialize();
      await i18nService.initialize();
      if (active) setStartup({ consent: consent === true, policy: enterprise.config ?? null });
    }).catch((failure: unknown) => {
      console.error('[WEFTORY] Studio initialization failed.', failure);
      if (active) setError(true);
    });
    return () => { active = false; };
  }, [attempt]);

  useEffect(() => {
    document.documentElement.classList.add(`platform-${window.electron.platform}`);
    document.title = t('fashionName');
    return window.electron.ipcRenderer.on(AppIpcChannel.OpenSettings, () => setTab(FashionTab.Settings));
  }, []);

  const accept = async () => {
    if (!startup) return;
    setError(false);
    setAccepting(true);
    try {
      await window.electron.store.set('privacy_agreed', true);
      setStartup({ ...startup, consent: true });
    } catch (failure) {
      console.error('[WEFTORY] Could not save the terms acceptance.', failure);
      setError(true);
    } finally {
      setAccepting(false);
    }
  };

  const closeConfiguration = () => {
    setConfiguration(undefined);
    setConfigurationRevision(revision => revision + 1);
  };
  const configureFeishu = () => {
    void agentService.loadAgents();
    setConfiguration(Configuration.Feishu);
  };
  const showConfiguration = (target: Configuration) => {
    const policy = startup?.policy?.ui?.[`settings.${target}`];
    return policy === undefined;
  };

  if (!startup?.consent) {
    return (
      <main lang={language === 'zh' ? 'zh-CN' : 'en'} className="grid h-screen place-items-center bg-[#f7f6f3] px-6 text-center text-zinc-900 dark:bg-[#151417] dark:text-zinc-100">
        <div aria-hidden="true" className="draggable absolute inset-x-0 top-0 h-12" />
        <section className="grid max-w-sm justify-items-center gap-4">
          <img src={import.meta.env.BASE_URL + FashionLogoFile} alt="" className="h-16 w-16" draggable={false} />
          <h1 className="text-2xl font-bold tracking-[0.16em]">{t('fashionName')}</h1>
          {startup ? <>
            <p className="text-sm">{t('fashionConsent')}</p>
            <button type="button" className="text-sm underline underline-offset-4" onClick={() => {
              void window.electron.shell.openExternal(TERMS_URL).catch((failure: unknown) => {
                console.error('[WEFTORY] Could not open the terms of service.', failure);
                setError(true);
              });
            }}>{t('welcomeAgreementLinkText')}</button>
            <button type="button" className="rounded-lg bg-[#292333] px-4 py-2 text-sm font-semibold text-white disabled:opacity-40 dark:bg-violet-200 dark:text-zinc-950"
              onClick={() => void accept()} disabled={accepting}>{t('fashionAcceptTerms')}</button>
            {error && <p role="alert" className="text-sm text-rose-700 dark:text-rose-300">{t('fashionError.storage')}</p>}
          </> : error ? <>
            <p role="alert" className="text-sm">{t('initializationError')}</p>
            <button type="button" className="rounded-lg border border-current px-4 py-2 text-sm" onClick={() => {
              setError(false);
              setAttempt(current => current + 1);
            }}>{t('retry')}</button>
          </> : <p role="status" className="text-sm">{t('fashionLoading')}</p>}
        </section>
      </main>
    );
  }

  return (
    <div className="h-screen overflow-hidden">
      <FashionHome api={api} tab={tab} setTab={setTab} configurationRevision={configurationRevision}
        onConfigureText={showConfiguration(Configuration.Text) ? () => setConfiguration(Configuration.Text) : undefined}
        onConfigureFeishu={showConfiguration(Configuration.Feishu) ? configureFeishu : undefined} />
      {configuration === Configuration.Text && (
        <SkinProvider>
          <Settings modelOnly onClose={closeConfiguration} enterpriseConfig={startup.policy} />
        </SkinProvider>
      )}
      {configuration === Configuration.Feishu && (
        <Modal onClose={closeConfiguration} onEscape={closeConfiguration} className="mx-4 w-full max-w-3xl">
          <section role="dialog" aria-modal="true" aria-labelledby="fashion-feishu-title"
            className="flex h-[min(75vh,44rem)] flex-col rounded-2xl border border-border bg-background p-5 text-foreground shadow-modal">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 id="fashion-feishu-title" className="font-semibold">{t('fashionConfigureFeishu')}</h2>
              <button type="button" aria-label={t('close')} className="rounded-lg p-1.5 hover:bg-surface-raised" onClick={closeConfiguration}>
                <XMarkIcon className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
            <div className="min-h-0 flex-1"><IMSettings onlyPlatform="feishu" /></div>
          </section>
        </Modal>
      )}
    </div>
  );
}
