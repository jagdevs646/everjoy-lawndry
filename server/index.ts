import { createApp } from './app.js';

const arg = (name: string) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : undefined; };
const demo = process.argv.includes('--demo') || process.env.DEMO === '1';
// --port wins (local dev pins the API to 3001 behind Vite); hosts like Render/Railway set PORT.
const port = Number(arg('--port') || process.env.PORT || 3001);

createApp({ demo }).listen(port, () => {
  console.log(`Everjoy Lawndry running on http://localhost:${port}${demo ? '  (demo data)' : ''}`);
});
