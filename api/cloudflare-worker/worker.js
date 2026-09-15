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

    // Compatibility route for frontend login endpoint
    if (url.pathname === '/api/auth/login' && request.method === 'POST') {
      try {
        await ensureSchema(env);
        const body = await request.json();
        const payload = { ...body, action: 'login' };
        const response = await dispatchAction(env, request, payload);
        return json(response, 200, cors);
      } catch (error) {
        return json({
          ok: false,
          code: error?.code || 'INTERNAL_ERROR',
          message: error?.message || 'Terjadi kesalahan.'
        }, error?.status || 500, cors);
      }
    }

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

    // Semua request GET/HEAD selain /api diteruskan ke file statis (html, css, js, gambar).
    // Sebelumnya hanya path "/" yang diteruskan, sehingga klik link apa pun (login.html,
    // style.css, auth.js, dll) selalu berakhir dengan JSON 404 alih-alih menampilkan halaman.
    if ((request.method === 'GET' || request.method === 'HEAD') && env.ASSETS) {
      const assetResponse = await env.ASSETS.fetch(request);
      if (assetResponse.status !== 404) return assetResponse;
    }

    if (url.pathname === '/' && request.method === 'GET') {
      return new Response(`<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kelas Senja API</title>
<style>body{font-family:Arial,sans-serif;padding:40px;line-height:1.6}code{background:#eee;padding:4px;border-radius:4px}</style>
</head>
<body>
<h1>Kelas Senja Cloudflare API</h1>
<p>Worker aktif dan berjalan dengan baik.</p>
<p>Gunakan endpoint API:</p>
<ul>
<li><code>/api</code></li>
<li><code>/api/auth/login</code></li>
</ul>
</body>
</html>`, {headers:{'content-type':'text/html; charset=UTF-8', ...cors}});
    }

    return json({ ok: false, code: 'NOT_FOUND', message: 'Endpoint tidak ditemukan.' }, 404, cors);
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
