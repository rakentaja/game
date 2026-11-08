import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.02 } },
  use: {
    baseURL: 'http://localhost:4173',
    launchOptions: { args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] },
  },
  webServer: {
    command: 'bun run build && bun run preview --port 4173',
    port: 4173,
    reuseExistingServer: true,
    timeout: 180_000,
  },
  projects: [
    { name: 'iphone14', use: { ...devices['iPhone 14'], browserName: 'chromium' } },
    { name: 'pixel7', use: { ...devices['Pixel 7'] } },
  ],
});
