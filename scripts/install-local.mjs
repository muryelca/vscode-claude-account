#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) {
    console.error(`[install-local] ${command} ${args.join(' ')} exited with ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

function userDataDir() {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Code', 'User');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Code', 'User');
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Code', 'User');
}

function profileNames() {
  const storage = join(userDataDir(), 'globalStorage', 'storage.json');
  if (!existsSync(storage)) {
    return [];
  }
  try {
    const profiles = JSON.parse(readFileSync(storage, 'utf8')).userDataProfiles ?? [];
    return profiles.map((profile) => profile.name).filter((name) => typeof name === 'string' && name !== '');
  } catch {
    return [];
  }
}

run('npm', ['run', 'package']);

const vsix = readdirSync(root)
  .filter((name) => name.endsWith('.vsix'))
  .map((name) => ({ name, mtime: statSync(resolve(root, name)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)[0];

if (!vsix) {
  console.error('[install-local] no .vsix found');
  process.exit(1);
}

const target = resolve(root, vsix.name);
console.log(`[install-local] installing ${vsix.name} in the default profile`);
run('code', ['--install-extension', `"${target}"`, '--force']);
for (const profile of profileNames()) {
  console.log(`[install-local] installing ${vsix.name} in profile "${profile}"`);
  run('code', ['--install-extension', `"${target}"`, '--force', '--profile', `"${profile}"`]);
}
console.log('[install-local] done, reload your VS Code windows');
