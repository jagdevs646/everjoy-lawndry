import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Tests never touch the real database or uploads folder.
    env: { DB_PATH: ':memory:', NODE_ENV: 'test', UPLOAD_DIR: path.join(os.tmpdir(), 'everjoy-test-uploads') },
  },
});
