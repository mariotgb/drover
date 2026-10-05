import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { build as buildWeb, type Plugin } from 'vite'

// Strict CSP for packaged builds only (the dev server needs inline scripts).
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: hdfile: https:",
  "media-src 'self' blob: hdfile:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'"
].join('; ')

function cspPlugin(): Plugin {
  return {
    name: 'drover-csp',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`)
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: {
      index: resolve(__dirname, 'src/main/index.ts'),
      serverWatchdogWorker: resolve(__dirname, 'src/main/herdr/watchdog-worker.ts'),
      transcriptWorker: resolve(__dirname, 'src/main/transcripts/worker.ts')
    } } },
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@': resolve(__dirname, 'src/renderer/src')
      }
    },
    plugins: [react(), cspPlugin(), {
      name: 'drover-remote-renderers',
      apply: 'build',
      async closeBundle() {
        const aliases = { '@shared': resolve(__dirname, 'src/shared'), '@': resolve(__dirname, 'src/renderer/src') }
        await buildWeb({
          configFile: false,
          root: resolve(__dirname, 'src/renderer/web'),
          base: '/',
          publicDir: resolve(__dirname, 'src/renderer/public'),
          resolve: { alias: aliases },
          plugins: [react()],
          build: { outDir: resolve(__dirname, 'out/web'), emptyOutDir: true }
        })
        await buildWeb({
          configFile: false,
          root: resolve(__dirname, 'src/renderer/auth'),
          base: '/auth/',
          publicDir: resolve(__dirname, 'src/renderer/auth/public'),
          resolve: { alias: aliases },
          plugins: [react()],
          build: { outDir: resolve(__dirname, 'out/web/auth'), emptyOutDir: true }
        })
      }
    }],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html')
      }
    }
  }
})
