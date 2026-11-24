import { createApp } from './app.js';
import { db } from './db.js';

const arg = (name: string) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : undefined; };
const wantsDemo = process.argv.includes('--demo') || process.env.DEMO === '1';
// Demo data has accounts with a published password: never on a production server unless asked twice.
const demo = wantsDemo && (process.env.NODE_ENV !== 'production' || process.env.ALLOW_DEMO_IN_PRODUCTION === '1');
if (wantsDemo && !demo) console.warn('DEMO=1 is ignored because NODE_ENV=production. Remove DEMO from the server settings (or set ALLOW_DEMO_IN_PRODUCTION=1 for a throw-away demo server).');
// --port wins (local dev pins the API to 3001 behind Vite); hosts like Render/Railway set PORT.
const port = Number(arg('--port') || process.env.PORT || 3001);

const app = await createApp({ demo });
const server = app.listen(port, () => {
  console.log(`Everjoy Lawndry running on http://localhost:${port} (${db.dialect === 'postgres' ? 'Postgres' : 'SQLite'}${demo ? ', demo data' : ''})`);
});

// Render and other hosts send SIGTERM before stopping or redeploying: finish requests, close the database.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    server.close(() => { void db.close().finally(() => process.exit(0)); });
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
