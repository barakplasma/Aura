import * as esbuild from 'esbuild';
import path from 'node:path';

const dir = import.meta.dirname;

await esbuild.build({
  entryPoints: [path.join(dir, '..', 'lib', 'aura.js')],
  outfile: path.join(dir, '..', 'public', 'aura.bundle.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  sourcemap: true,
  external: ['@material/web'],
});
