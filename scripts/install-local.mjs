#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) {
    console.error(`[install-local] ${command} ${args.join(' ')} saiu com ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

run('npm', ['run', 'package']);

const vsix = readdirSync(root)
  .filter((name) => name.endsWith('.vsix'))
  .map((name) => ({ name, mtime: statSync(resolve(root, name)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)[0];

if (!vsix) {
  console.error('[install-local] nenhum .vsix encontrado');
  process.exit(1);
}

console.log(`[install-local] instalando ${vsix.name}`);
run('code', ['--install-extension', resolve(root, vsix.name), '--force']);
console.log('[install-local] pronto; recarregue a janela do VS Code');
