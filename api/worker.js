import { dispatchAction } from './api.js';
import { ensureSchema, getMeta } from './db.js';
import { ApiError, json } from './utils.js';
import { handleScheduledDriveBackup } from './backup.js';

function corsHeaders(request, env) {
  const origin = request.headers.get('origin') || '';
  const allowed = String(env.ALLOWED_ORIGIN || '').trim();
  if (!origin) return {};
  if (!allowed || origin === allowed || new URL(request.url).origin === origin) {
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'Content-Type',
      'vary': 'Origin'
    };
  }
  return {};
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (url.pathname === '/api' || url.pathname === '/api/') {
      try {
        await ensureSchema(env);
        if (request.method === 'GET') {
          return json({
            ok: true,
            message: 'Kelas Senja Cloudflare API aktif',
            installed: await getMeta(env, 'setup_complete') === '1'
          }, 200, cors);
        }
        if (request.method !== 'POST') return json({ ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Metode tidak didukung.' }, 405, cors);
        const text = await request.text();
        let body = {};
        try {
          body = text ? JSON.parse(text) : {};
        } catch {
          throw new ApiError('Isi permintaan bukan JSON yang valid.', 'INVALID_JSON');
        }
        const result = await dispatchAction(env, request, body);
        return json(result, 200, cors);
      } catch (error) {
        console.error(error);
        const status = error instanceof ApiError ? error.status : 500;
        return json({
          ok: false,
          code: error?.code || 'REQUEST_FAILED',
          message: error?.message || 'Permintaan gagal.'
        }, status, cors);
      }
    }

    const assetResponse = await env.ASSETS.fetch(request);
    const assetUrl = new URL(request.url);
    if (request.method === 'GET' && assetResponse.ok && !assetUrl.pathname.endsWith('.html')) {
      const headers = new Headers(assetResponse.headers);
      headers.set('cache-control', 'public, max-age=604800, stale-while-revalidate=2592000');
      headers.set('x-cache-policy', 'static-asset-cache');
      return new Response(assetResponse.body, { status: assetResponse.status, headers });
    }
    return assetResponse;
  },

  async scheduled(controller, env, ctx) {
    const task = (async () => {
      await ensureSchema(env);
      const result = await handleScheduledDriveBackup(env, controller);
      console.log('Kelas Senja scheduled backup:', JSON.stringify(result));
      return result;
    })();
    ctx.waitUntil(task);
  }
};
