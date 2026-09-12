'use client';

import { useEffect } from 'react';

/**
 * Registers the service worker so Jarvis installs and opens like an app on iOS and Android.
 * The worker only caches the app shell; project data is always fetched fresh from the server.
 */
export function PwaRegister() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    if (process.env.NODE_ENV !== 'production') return;
    const register = () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        /* Registration failures are non-fatal: Jarvis works exactly the same online. */
      });
    };
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  }, []);
  return null;
}
