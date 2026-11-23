import fs from 'node:fs';
import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Android + iOS app shell for Everjoy Lawndry. The screens are the same React build
 * as the website (dist/), bundled inside the app; data comes from the Everjoy server
 * set in .env.app (VITE_API_BASE).
 */
function readAppEnv(): Record<string, string> {
  if (!fs.existsSync('.env.app')) return {};
  return Object.fromEntries(
    fs.readFileSync('.env.app', 'utf8').split(/\r?\n/)
      .filter(line => /^\s*[A-Z_]+\s*=/.test(line))
      .map(line => { const i = line.indexOf('='); return [line.slice(0, i).trim(), line.slice(i + 1).trim()]; }),
  );
}

// A plain-http server (a laptop on the same Wi-Fi while testing) needs cleartext traffic and,
// because the bundled screens load from https://localhost, mixed content. Both stay OFF for an https server.
// Same precedence as Vite: an environment variable beats the .env.app file.
const httpTestServer = (process.env.VITE_API_BASE ?? readAppEnv().VITE_API_BASE ?? '').startsWith('http://');

const config: CapacitorConfig = {
  appId: 'com.everjoy.lawndry',
  appName: 'Everjoy Lawndry',
  webDir: 'dist',
  server: {
    cleartext: httpTestServer,
  },
  android: {
    allowMixedContent: httpTestServer,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 800,
      backgroundColor: '#EAF2FB',
      showSpinner: false,
    },
  },
};

export default config;
