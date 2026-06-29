import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['lib/training.js'],
  outfile: 'public/training.bundle.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  sourcemap: true,
});
