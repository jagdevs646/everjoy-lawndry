import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { db, migrate } from './db.js';
import { appCors, csrf, initAuthSecret, mustChangePassword, session } from './auth.js';
import { serveFile } from './files.js';
import { ensureAdmin, seedDemo } from './seed.js';
import { HttpError, errorHandler } from './util.js';
import { router as publicRoutes } from './routes/public.js';
import { router as studentRoutes } from './routes/student.js';
import { router as opsRoutes } from './routes/ops.js';
import { router as adminRoutes } from './routes/admin.js';

/** Open the database (SQLite or Postgres), create tables, load the signing secret, and seed. */
export async function createApp({ demo = false } = {}) {
  await db.open();
  await migrate();
  await initAuthSecret();
  await ensureAdmin(demo);
  if (demo) await seedDemo();

  const app = express();
  app.disable('x-powered-by');
  // Which proxies may set X-Forwarded-For. Default: only a proxy on this machine (Nginx/Caddy), so a
  // client talking to Node directly can't fake its IP to dodge rate limits. On Render/Railway set TRUST_PROXY=1.
  const tp = process.env.TRUST_PROXY;
  app.set('trust proxy', tp === undefined ? 'loopback' : /^\d+$/.test(tp) ? Number(tp) : tp === 'true' ? true : tp === 'false' ? false : tp);
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    // Only our own scripts, styles, fonts and API; images also from data:/blob: (QR codes, photos, the UPI QR).
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
      "font-src 'self' data:", "connect-src 'self'", "media-src 'self' blob:", "worker-src 'self' blob:",
      "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
    ].join('; '));
    if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });
  app.use(express.json({ limit: '100kb' }));

  const api = express.Router();
  api.use(appCors, session, csrf, mustChangePassword);   // appCors answers the app's preflight before anything else
  api.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  api.get('/health', (_req, res) => res.json({ ok: true }));
  api.get('/files/:name', serveFile);
  api.use(publicRoutes, studentRoutes, opsRoutes, adminRoutes);
  api.use((_req, _res, next) => next(new HttpError(404, 'Not found.')));
  app.use('/api', api);

  // One server: the built website is served from dist/ alongside the API.
  const dist = path.resolve('dist');
  if (fs.existsSync(path.join(dist, 'index.html'))) {
    app.use('/assets', express.static(path.join(dist, 'assets'), { immutable: true, maxAge: '1y' }));
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api\/).*/, (_req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(path.join(dist, 'index.html')); });
  }

  app.use(errorHandler);
  return app;
}
