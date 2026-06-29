import * as esbuild from 'esbuild';
import path from 'node:path';

const dir = import.meta.dirname;

await esbuild.build({
  entryPoints: [path.join(dir, 'material-entry.js')],
  outfile: path.join(dir, '..', 'public', 'material.bundle.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  sourcemap: true,
});
