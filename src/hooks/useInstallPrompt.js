import { useCallback, useEffect, useState } from 'react';

// Chrome's deferred install prompt, offered in the Watch empty state. Null
// when the app is already installed, the browser never fires the event (iOS
// Safari, Firefox), or the operator dismissed it.
export function useInstallPrompt() {
  const [deferred, setDeferred] = useState(null);

  useEffect(() => {
    const onPrompt = (e) => { e.preventDefault(); setDeferred(e); };
    const onInstalled = () => setDeferred(null);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const install = useCallback(async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice.catch(() => {});
    setDeferred(null); // the event is single-use either way
  }, [deferred]);

  return deferred ? install : null;
}
