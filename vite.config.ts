import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  assetsInclude: ['**/*.glsl', '**/*.glb', '**/*.ktx2'],
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 900 },
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
        globIgnores: ['**/icons/splash/**', '**/*.map'],
        maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
      },
    }),
  ],
});
