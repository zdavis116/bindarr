import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { VitePWA } from 'vite-plugin-pwa'

// Bake the version into the bundle. Settings used to learn its own version from
// /api/settings/version, so any hiccup on that call left it showing "Version …"
// — the app couldn't state what build it was, which is exactly what you need
// when filing a bug. The release workflow bumps this file, so it's the truth.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

// https://vitejs.dev/config/
export default defineConfig({
  // Demo build is served from https://<user>.github.io/bindarr/, so assets need
  // that sub-path prefix. Every other build (web/mobile) stays root-relative.
  base: process.env.VITE_DEMO ? '/bindarr/' : '/',
  plugins: [
    react(),
    basicSsl(),
    // INSTALLABLE ON HIS PHONE.
    //
    // Zach: "I would like this to work as a pwa for my phone."
    //
    // The repo already contained a manifest.webmanifest, but it was inert three
    // ways over: never linked from index.html so no browser read it, pointing at
    // an icons/ directory that did not exist so every icon 404'd, and missing
    // name / start_url / display so it could not have satisfied an install
    // prompt even if found. It looked done in a file listing and had never once
    // worked.
    //
    // NOT OFFLINE-FIRST, deliberately. He said offline does not matter, and this
    // app's entire contract is that a price is current and says where it came
    // from -- serving yesterday's figures from a cache would quietly break the
    // thing the last several days of work were spent getting right.
    //
    // So: the SHELL is cached (HTML, JS, CSS, icons) and every /api call goes to
    // the network. The app opens instantly and, with no connection, shows its
    // normal empty/error states rather than stale numbers presented as fact.
    VitePWA({
      registerType: 'prompt',
      manifest: false,          // public/manifest.webmanifest is the source of truth
      includeAssets: ['logo.svg', 'icons/*.png'],
      workbox: {
        // The scan models are tens of megabytes and are fetched on demand;
        // precaching them would make the install download enormous.
        globPatterns: ['**/*.{js,css,html,svg,png,webp,woff2}'],
        globIgnores: ['**/models/**', '**/sketches/**'],
        // A card image is immutable once published and heavy to re-fetch, so it
        // is worth caching -- but capped, or a big collection fills the phone.
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/cards\.scryfall\.io\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'card-images',
              expiration: { maxEntries: 600, maxAgeSeconds: 30 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
        // EVERY /api CALL MUST REACH THE SERVER. navigateFallback would
        // otherwise answer API requests with index.html, and a cached price is
        // a price that lies about being current.
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
      },
      devOptions: { enabled: false },
    }),
  ],
  // Matches how the app already reads build-time config (VITE_DEMO), so this
  // needs no new global and no eslint exception.
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version),
  },
  // Ship source maps so a minified production error (e.g. a device-only crash in
  // the Android WebView) maps back to real file:line via chrome://inspect. Repo
  // is public, so exposing sources costs nothing.
  build: {
    sourcemap: true,
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      }
    }
  }
})
