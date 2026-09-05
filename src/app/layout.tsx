import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import { Toaster } from 'sonner';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Jarvis', template: '%s · Jarvis' },
  description: 'A private project registry and portfolio status brain.',
  applicationName: 'Jarvis',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'Jarvis', statusBarStyle: 'default' },
  icons: {
    icon: [
      { url: '/icons/icon.svg', type: 'image/svg+xml' },
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: [{ url: '/icons/icon-180.png', sizes: '180x180', type: 'image/png' }],
  },
  /* A private tool must never appear in a search index. */
  robots: { index: false, follow: false, nocache: true },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f8fa' },
    { media: '(prefers-color-scheme: dark)', color: '#16181d' },
  ],
};

/**
 * Applies the stored theme before first paint.
 *
 * Without this the page would render in the system theme and then flip, which looks broken on a
 * phone. It is inline because it must run before hydration; it touches nothing but the root
 * element's `data-theme`.
 */
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('jarvis-theme');if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  /* Set by src/middleware.ts. The theme script is the one inline script Jarvis emits itself. */
  const nonce = (await headers()).get('x-nonce') ?? undefined;

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/*
          `suppressHydrationWarning` is required, not cosmetic: browsers deliberately hide a
          script's nonce from the DOM once the page is parsed, so the client always sees an empty
          value where the server sent one. Without this, React reports a mismatch on every load.
        */}
        <script
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }}
        />
      </head>
      <body>
        <a href="#main" className="jarvis-skip-link">
          Skip to content
        </a>
        {children}
        <Toaster
          position="top-center"
          toastOptions={{
            style: {
              background: 'var(--color-surface)',
              color: 'var(--color-text)',
              border: '1px solid var(--color-border-strong)',
            },
          }}
        />
      </body>
    </html>
  );
}
