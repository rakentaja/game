/**
 * PWA glue: service-worker registration with a "new printing ready — reload" toast, head links
 * (manifest, apple-touch-icon, iOS splash) and the deferred add-to-home-screen prompt.
 */
import { SPLASHES, splashFile, splashMedia } from '../ui/pwa/splash';

export interface PwaNotify {
  t(key: string): string;
  toast(
    msg: string,
    opts?: { action?: { label: string; run: () => void }; ms?: number; closable?: boolean },
  ): () => void;
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
let captureInstalled = false;

/** Start listening for the install prompt as early as possible (idempotent). */
export function captureInstallPrompt(): void {
  if (captureInstalled || typeof window === 'undefined') return;
  captureInstalled = true;
  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
  });
  addEventListener('appinstalled', () => {
    deferred = null;
  });
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    matchMedia('(display-mode: standalone)').matches ||
    matchMedia('(display-mode: fullscreen)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
}

/** 'prompt' = native install dialog available; 'ios' = show Share → Add to Home Screen hint. */
export function installMode(): 'prompt' | 'ios' | null {
  if (isStandalone()) return null;
  if (deferred) return 'prompt';
  if (isIOS()) return 'ios';
  return null;
}

export async function promptInstall(): Promise<boolean> {
  const d = deferred;
  if (!d) return false;
  deferred = null;
  await d.prompt();
  return (await d.userChoice).outcome === 'accepted';
}

/** Add <link>/<meta> tags iOS and Chrome need, unless index.html already has them. */
export function installHeadLinks(base: string = import.meta.env.BASE_URL): void {
  if (typeof document === 'undefined') return;
  const head = document.head;
  const add = (tag: 'link' | 'meta', attrs: Record<string, string>, selector: string) => {
    if (head.querySelector(selector)) return;
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    head.append(el);
  };
  add('link', { rel: 'manifest', href: `${base}manifest.webmanifest` }, 'link[rel="manifest"]');
  add('link', { rel: 'icon', type: 'image/svg+xml', href: `${base}icons/icon.svg` }, 'link[rel="icon"]');
  add(
    'link',
    { rel: 'apple-touch-icon', href: `${base}icons/apple-touch-icon.png` },
    'link[rel="apple-touch-icon"]',
  );
  add(
    'meta',
    { name: 'apple-mobile-web-app-title', content: 'INKWAKE' },
    'meta[name="apple-mobile-web-app-title"]',
  );
  if (!head.querySelector('link[rel="apple-touch-startup-image"]')) {
    for (const sp of SPLASHES) {
      const l = document.createElement('link');
      l.rel = 'apple-touch-startup-image';
      l.media = splashMedia(sp);
      l.href = `${base}${splashFile(sp)}`;
      head.append(l);
    }
  }
}

let registered = false;

/** Register the SW (prod builds). Shows a reload toast when a new version is waiting. */
export async function registerPWA(ui: PwaNotify): Promise<void> {
  if (registered || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  registered = true;
  try {
    const { registerSW } = await import('virtual:pwa-register');
    const update = registerSW({
      immediate: true,
      onNeedRefresh() {
        ui.toast(ui.t('pwa.update'), {
          action: { label: ui.t('pwa.reload'), run: () => void update(true) },
          closable: true,
        });
      },
      onOfflineReady() {
        ui.toast(ui.t('pwa.offline'), { ms: 3200 });
      },
    });
  } catch {
    /* dev server without SW / unsupported */
  }
}
