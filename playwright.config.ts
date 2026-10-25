import { defineConfig } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';

// A fresh daemon on :7319 with its own data dir, mock accounts, and a pinned start time
// (Monday Oct 26 2026, 3:30 PM) so the click-through is deterministic. Uses installed Chrome.
const data = path.join(os.tmpdir(), `margin-e2e-${Date.now()}`);
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:7319', channel: 'chrome', headless: true, viewport: { width: 1280, height: 860 }, trace: 'retain-on-failure' },
  webServer: {
    command: 'node --no-warnings --import tsx src/daemon.ts',
    url: 'http://127.0.0.1:7319/api/health',
    reuseExistingServer: false,
    env: { MARGIN_PORT: '7319', MARGIN_DATA_DIR: data, MARGIN_KEYCHAIN: 'memory', MARGIN_NOTIFY: 'log', MARGIN_DEV: '1', MARGIN_FAKE_NOW: '2026-10-26T15:30:00-04:00' },
  },
});
