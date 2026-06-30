import * as esbuild from 'esbuild';
import { copyFile } from 'node:fs/promises';
import path from 'node:path';

const dir = import.meta.dirname;
const root = path.join(dir, '..');

await Promise.all([
  esbuild.build({
    entryPoints: [path.join(root, 'src', 'main.jsx')],
    outfile: path.join(root, 'public', 'app.bundle.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    jsx: 'automatic',
    jsxImportSource: 'react',
    sourcemap: true,
  }),
  copyFile(path.join(root, 'src', 'aura.css'), path.join(root, 'public', 'aura.css')),
]);

console.log('React bundle built.');
