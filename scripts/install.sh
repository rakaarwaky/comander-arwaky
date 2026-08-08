#!/bin/bash
set -e

BASE_DIR="/home/raka/mcp-arwaky/comander-arwaky"
REPO_DIR="$BASE_DIR/desktop-commander"
DIST_DIR="$BASE_DIR/dist"

cd "$REPO_DIR"

echo ">>> Compiling TypeScript..."
npx tsc --outDir "$DIST_DIR"

echo ">>> Copying JS files..."
cp setup-claude-server.js uninstall-claude-server.js track-installation.js "$DIST_DIR/"
chmod +x "$DIST_DIR"/*.js

echo ">>> Copying data files..."
mkdir -p "$DIST_DIR/data"
cp src/data/onboarding-prompts.json "$DIST_DIR/data/"

echo ">>> Copying remote-device scripts..."
mkdir -p "$DIST_DIR/remote-device/scripts"
cp src/remote-device/scripts/blocking-offline-update.js "$DIST_DIR/remote-device/scripts/"

echo ">>> Building UI runtime..."
node -e "
const path = require('path');
const fs = require('fs');
const { build } = require('esbuild');

const DIST = path.resolve('$DIST_DIR');
const ROOT = path.resolve('$REPO_DIR');

const TARGETS = [
  {
    entry: 'src/ui/file-preview/src/main.ts',
    outfile: path.join(DIST, 'ui/file-preview/preview-runtime.js'),
    staticDir: 'src/ui/file-preview',
    styles: [
      'src/ui/styles/base.css',
      'src/ui/styles/components/compact-row.css',
      'src/ui/styles/apps/file-preview.css'
    ]
  },
  {
    entry: 'src/ui/config-editor/src/main.ts',
    outfile: path.join(DIST, 'ui/config-editor/config-editor-runtime.js'),
    staticDir: 'src/ui/config-editor',
    styles: [
      'src/ui/styles/base.css',
      'src/ui/styles/components/compact-row.css',
      'src/ui/styles/apps/config-editor.css'
    ]
  }
];

for (const t of TARGETS) {
  const outDir = path.dirname(t.outfile);
  fs.mkdirSync(outDir, { recursive: true });

  try {
    fs.copyFileSync(path.join(ROOT, t.staticDir, 'index.html'), path.join(outDir, 'index.html'));
  } catch {}

  const css = t.styles.map(s => fs.readFileSync(path.join(ROOT, s), 'utf8')).join('\n\n');
  fs.writeFileSync(path.join(outDir, 'styles.css'), css + '\n', 'utf8');

  build({
    entryPoints: [path.join(ROOT, t.entry)],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2020'],
    outfile: t.outfile,
    minify: true,
    sourcemap: false
  });
  console.log('  Built:', path.relative(DIST, t.outfile));
}
"

echo ">>> Done! Output in $DIST_DIR"
