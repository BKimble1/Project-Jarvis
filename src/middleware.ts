import { NextResponse, type NextRequest } from 'next/server';

/**
 * Per-request Content-Security-Policy with a nonce.
 *
 * Next.js injects a small inline bootstrap script into every page, which would otherwise force
 * `script-src 'unsafe-inline'` — an escape hatch wide enough to undo the point of having a policy.
 * Emitting a fresh nonce here and passing it through the `x-nonce` header lets Next tag its own
 * scripts, so the policy can be `'nonce-…' 'strict-dynamic'` with no blanket inline allowance.
 *
 * `style-src` keeps `'unsafe-inline'`: the framework inlines critical CSS without a nonce, and an
 * injected stylesheet is a far smaller risk than injected script.
 */
export function middleware(request: NextRequest): NextResponse {
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const isProduction = process.env.NODE_ENV === 'production';

  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isProduction ? '' : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://avatars.githubusercontent.com",
    "font-src 'self' data:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    ...(isProduction ? ['upgrade-insecure-requests'] : []),
  ].join('; ');

  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    /*
     * Every document request. Static assets, the service worker, the manifest and image
     * optimisation are excluded: they are not documents, and a policy header on them adds
     * nothing but bytes.
     */
    {
      source:
        '/((?!_next/static|_next/image|icons/|sw\\.js|manifest\\.webmanifest|favicon\\.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
