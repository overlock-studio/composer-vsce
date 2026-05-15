import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');
const dev = process.argv.includes('--dev') || watch;

const common = {
  bundle: true,
  sourcemap: dev,
  minify: !dev,
  logLevel: 'info',
  loader: { '.css': 'css' },
  preserveSymlinks: true,
};

const extensionConfig = {
  ...common,
  entryPoints: [path.join(__dirname, 'src/extension.ts')],
  outfile: path.join(__dirname, 'dist/extension.js'),
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
};

const webviewConfig = {
  ...common,
  entryPoints: [path.join(__dirname, 'src/webview/index.tsx')],
  outfile: path.join(__dirname, 'dist/webview.js'),
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  jsx: 'automatic',
  define: {
    'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production'),
  },
  resolveExtensions: ['.tsx', '.ts', '.jsx', '.js', '.css'],
};

if (watch) {
  const ext = await esbuild.context(extensionConfig);
  const wv = await esbuild.context(webviewConfig);
  await Promise.all([ext.watch(), wv.watch()]);
  console.log('watching...');
} else {
  await Promise.all([
    esbuild.build(extensionConfig),
    esbuild.build(webviewConfig),
  ]);
}
