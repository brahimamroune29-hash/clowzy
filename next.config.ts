import type { NextConfig } from 'next';
// Headers are compiled at build time, so build with the production APP_URL set.
const https = !!process.env.APP_URL?.toLowerCase().startsWith('https:');
const isDev = process.env.NODE_ENV === 'development';
// ponytail: static CSP with 'unsafe-inline' per the Next 16 "Without Nonces" guide; switch to nonces via proxy.ts if third-party scripts are ever added.
const csp = `default-src 'self'; script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'${https ? '; upgrade-insecure-requests' : ''}`;
const config: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  async headers() {
    return [{ source: '/(.*)', headers: [
      { key: 'Content-Security-Policy', value: csp },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'same-origin' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      ...(https ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000' }] : []),
    ] }];
  }
};
export default config;
