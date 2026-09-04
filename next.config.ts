import type { NextConfig } from 'next';

/**
 * Security headers applied to every response.
 *
 * The Content-Security-Policy is *not* here: it carries a per-request nonce and is therefore set
 * by `src/middleware.ts`. Everything below is static and identical on every response.
 */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  /*
   * Loaded by Node, not bundled by webpack.
   *
   * `pdfjs-dist`'s legacy build is written for a runtime that supplies its own module machinery,
   * and bundling it produces a module that throws at `getDocument` rather than at build time — so
   * PDF ingestion failed only when a real PDF arrived, with "this PDF could not be read", which
   * reads like a bad file rather than a broken parser. Found by an end-to-end test that uploaded
   * a PDF the unit tests parse happily; the difference was the bundler, not the bytes.
   */
  serverExternalPackages: ['@electric-sql/pglite', 'pg', 'pdfjs-dist'],
  experimental: {
    /*
     * Trade a little compile speed for a lot less memory.
     *
     * The development server restarts itself when its used heap passes 80% of the heap limit
     * (`next/dist/server/lib/start-server.js`), and for an application this size it reached that
     * during a full end-to-end run — resetting in-flight requests with ECONNRESET and discarding
     * every compiled route, which turned a 353-second run into a 574-second failing one. This
     * flag lowers webpack's peak, which is the half of that equation worth reducing rather than
     * simply accommodating.
     */
    webpackMemoryOptimizations: true,
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
