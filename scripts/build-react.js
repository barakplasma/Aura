import * as esbuild from 'esbuild';
import { copyFile, rm } from 'node:fs/promises';
import path from 'node:path';

const dir = import.meta.dirname;
const root = path.join(dir, '..');
const outdir = path.join(root, 'public', 'assets');

// Purge stale hashed chunks from previous builds.
await rm(outdir, { recursive: true, force: true });

await Promise.all([
  esbuild.build({
    entryPoints: [path.join(root, 'src', 'main.jsx')],
    outdir,
    entryNames: 'app',
    chunkNames: 'chunk-[name]-[hash]',
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    jsx: 'automatic',
    jsxImportSource: 'react',
    minify: true,
    // External maps keep the deployed app debuggable; browsers only fetch
    // them when devtools is open, so users never pay for them.
    sourcemap: 'linked',
  }),
  copyFile(path.join(root, 'src', 'aura.css'), path.join(root, 'public', 'aura.css')),
]);

console.log('React bundle built.');
