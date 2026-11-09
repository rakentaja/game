import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  assetsInclude: ['**/*.glsl', '**/*.glb', '**/*.ktx2'],
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 900,
    rolldownOptions: {
      output: {
        // modules shared by the entry and lazy chunks: one "boot" chunk instead of six tiny ones
        // (each extra initial file costs gzip context + a request)
        codeSplitting: {
          groups: [
            {
              name: 'boot',
              test: /[\\/]src[\\/](data[\\/](tuning|palette)|systems[\\/]combat|core[\\/]storage|ui[\\/]dom)\.ts$|preload-helper|rolldown-runtime/,
            },
          ],
        },
        // co-op/net chunks get a `net-` prefix so the service worker can skip precaching them
        // (solo players never download the lobby, Trystero or the MQTT fallback)
        chunkFileNames: (c) =>
          c.moduleIds.some((id) =>
            /[\\/](src[\\/]net|trystero|@trystero-p2p|mqtt)[\\/]|screens[\\/]coop\./.test(id),
          )
            ? 'assets/net-[name]-[hash].js'
            : 'assets/[name]-[hash].js',
      },
    },
  },
  server: { port: 5173 },
  plugins: [
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      manifest: false,
      workbox: {
        globPatterns: [
          '**/*.{js,css,html,glb,ktx2,webm,m4a,ogg,mp3,opus,wav,png,webp,jpg,svg,woff2,ttf,json,webmanifest}',
        ],
        // iOS launch images are only read at install time; don't precache 1.3 MB of them
        globIgnores: ['**/icons/splash/**', '**/*.map', '**/assets/net-*', '**/assets/coop-*.css'],
        maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
      },
    }),
  ],
});
