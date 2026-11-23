import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

// The same API tests run twice: on SQLite (local installs) and on Postgres via PGlite
// (the engine used in production on Neon), so every query is checked on both.
// Tests never touch the real database or uploads folder.
const common = { include: ['tests/**/*.test.ts'], testTimeout: 20_000, hookTimeout: 60_000 };
const uploads = path.join(os.tmpdir(), 'everjoy-test-uploads');

export default defineConfig({
  test: {
    projects: [
      { test: { ...common, name: 'sqlite', env: { DB_PATH: ':memory:', NODE_ENV: 'test', UPLOAD_DIR: uploads } } },
      { test: { ...common, name: 'postgres', env: { DATABASE_URL: 'pglite://memory', NODE_ENV: 'test', UPLOAD_DIR: uploads } } },
    ],
  },
});
