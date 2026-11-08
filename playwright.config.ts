import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.02 } },
  use: {
    baseURL: 'http://localhost:4173',
    launchOptions: { args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] },
  },
  webServer: [
    {
      command: 'bun run build && bun run preview --port 4173',
      port: 4173,
      reuseExistingServer: true,
      timeout: 180_000,
    },
    // dev server for the dev-only harness pages (tests/e2e/visual.spec.ts); shared by all workers
    { command: 'bunx vite --port 5197 --strictPort', port: 5197, reuseExistingServer: true, timeout: 60_000 },
  ],
  projects: [
    { name: 'iphone14', use: { ...devices['iPhone 14'], browserName: 'chromium' } },
    { name: 'pixel7', use: { ...devices['Pixel 7'] } },
  ],
});
