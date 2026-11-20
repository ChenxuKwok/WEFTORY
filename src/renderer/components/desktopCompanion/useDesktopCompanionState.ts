import { useEffect, useState } from 'react';

import type { DesktopCompanionState } from '../../../shared/desktopCompanion/constants';

export function useDesktopCompanionState(enabled = true) {
  const [state, setState] = useState<DesktopCompanionState | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const accept = (next: DesktopCompanionState) => {
      if (active) setState(previous => !previous || next.revision >= previous.revision ? next : previous);
    };
    const unsubscribe = window.electron.desktopCompanion.onChanged(accept);
    void window.electron.desktopCompanion.getState().then(accept).catch(() => { if (active) setError(true); });
    return () => { active = false; unsubscribe(); };
  }, [enabled]);
  return enabled ? { state, error } : { state: null, error: false };
}
