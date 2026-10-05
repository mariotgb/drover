import { build } from 'esbuild'
import { join, resolve } from 'node:path'
/** Same explicit entry as electron-vite; tests exercise actual worker threads. */
export async function buildTranscriptWorker(directory) {
  await build({ entryPoints: ['src/main/transcripts/worker.ts'], bundle: true, platform: 'node', format: 'cjs',
    outfile: join(directory, 'transcriptWorker.js'), alias: { '@shared': resolve('src/shared') }, logLevel: 'silent' })
}
