import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { isSyncNameAllowed, prepareProfileDir, seedConfigContent, shouldStripConfigKey, syncFileByMtime } from '../claudeDir';

async function makeBase(): Promise<{ root: string; baseDir: string; baseConfigFile: string; profileDir: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cas-dir-'));
  const baseDir = path.join(root, '.claude');
  await fs.mkdir(path.join(baseDir, 'projects', 'slug'), { recursive: true });
  await fs.mkdir(path.join(baseDir, 'skills'), { recursive: true });
  await fs.mkdir(path.join(baseDir, 'backups'), { recursive: true });
  await fs.writeFile(path.join(baseDir, 'projects', 'slug', 'session.jsonl'), '{}');
  await fs.writeFile(path.join(baseDir, 'settings.json'), '{"model":"opus"}');
  await fs.writeFile(path.join(baseDir, 'CLAUDE.md'), '# rules');
  await fs.writeFile(path.join(baseDir, 'config.json'), '{"primaryApiKey":"sk-ant-secret"}');
  await fs.writeFile(path.join(baseDir, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"secret"}}');
  const baseConfigFile = path.join(root, '.claude.json');
  await fs.writeFile(
    baseConfigFile,
    JSON.stringify({
      hasCompletedOnboarding: true,
      oauthAccount: { emailAddress: 'a@b.c' },
      cachedUsageUtilization: { x: 1 },
      modelAccessCache: {},
      primaryApiKey: 'sk-ant-x',
      customApiKeyResponses: { approved: ['x'] },
      projects: { p: 1 },
    }),
  );
  return { root, baseDir, baseConfigFile, profileDir: path.join(root, 'profiles', 'pessoal') };
}

test('shouldStripConfigKey removes the account, api keys and every cache', () => {
  for (const key of ['oauthAccount', 'cachedUsageUtilization', 'modelAccessCache', 'primaryApiKey', 'customApiKeyResponses', 'claudeCodeFirstTokenDate']) {
    assert.equal(shouldStripConfigKey(key), true, key);
  }
  assert.equal(shouldStripConfigKey('projects'), false);
  assert.equal(shouldStripConfigKey('hasCompletedOnboarding'), false);
  assert.equal(shouldStripConfigKey('mcpServers'), false);
});

test('seedConfigContent keeps the rest of the config', () => {
  const seeded = JSON.parse(seedConfigContent('{"oauthAccount":{},"userID":"u","cachedStatsigGates":{},"mcpServers":{"a":1}}') ?? '{}');
  assert.deepEqual(seeded, { userID: 'u', mcpServers: { a: 1 } });
  assert.equal(seedConfigContent('nope'), undefined);
  assert.equal(seedConfigContent('[1]'), undefined);
});

test('isSyncNameAllowed rejects credentials, config files and paths', () => {
  assert.equal(isSyncNameAllowed('settings.json'), true);
  assert.equal(isSyncNameAllowed('CLAUDE.md'), true);
  for (const name of ['.credentials.json', '.claude.json', 'config.json', '.config.json', '../x', 'a/b', 'a\\b', '', '..']) {
    assert.equal(isSyncNameAllowed(name), false, name);
  }
});

test('prepareProfileDir creates junctions except backups, seeds .claude.json, syncs allowed files only', async () => {
  const { root, baseDir, baseConfigFile, profileDir } = await makeBase();
  const logs: string[] = [];
  try {
    const first = await prepareProfileDir({
      baseDir,
      baseConfigFile,
      profileDir,
      syncFiles: ['settings.json', 'CLAUDE.md', 'missing.json', 'config.json', '.credentials.json'],
      log: (m) => logs.push(m),
    });
    assert.equal(first.createdDir, true);
    assert.equal(first.skipped, false);
    assert.deepEqual([...first.junctionsCreated].sort(), ['projects', 'skills']);
    assert.equal(first.seeded, true);
    assert.deepEqual(first.synced, ['settings.json (base->profile)', 'CLAUDE.md (base->profile)']);
    assert.deepEqual(first.warnings, ['config.json: nome não permitido na sincronização; ignorado', '.credentials.json: nome não permitido na sincronização; ignorado']);

    assert.equal(await fs.readFile(path.join(profileDir, 'projects', 'slug', 'session.jsonl'), 'utf8'), '{}');
    assert.equal((await fs.lstat(path.join(profileDir, 'projects'))).isSymbolicLink(), true);
    await assert.rejects(fs.lstat(path.join(profileDir, 'backups')));
    const seeded = JSON.parse(await fs.readFile(path.join(profileDir, '.claude.json'), 'utf8'));
    assert.deepEqual(seeded, { hasCompletedOnboarding: true, projects: { p: 1 } });
    await assert.rejects(fs.stat(path.join(profileDir, '.credentials.json')));
    await assert.rejects(fs.stat(path.join(profileDir, 'config.json')));
    await assert.rejects(fs.stat(path.join(profileDir, '.claude-account-switcher.lock')));

    const second = await prepareProfileDir({ baseDir, baseConfigFile, profileDir, syncFiles: ['settings.json'], log: (m) => logs.push(m) });
    assert.equal(second.createdDir, false);
    assert.deepEqual(second.junctionsCreated, []);
    assert.equal(second.junctionsKept, 2);
    assert.equal(second.seeded, false);
    assert.deepEqual(second.synced, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('prepareProfileDir keeps a real non-empty folder, replaces an empty one and refuses overlapping directories', async () => {
  const { root, baseDir, baseConfigFile, profileDir } = await makeBase();
  try {
    await fs.mkdir(path.join(profileDir, 'projects', 'local'), { recursive: true });
    await fs.writeFile(path.join(profileDir, 'projects', 'local', 'x.jsonl'), '{}');
    await fs.mkdir(path.join(profileDir, 'skills'), { recursive: true });
    const report = await prepareProfileDir({ baseDir, baseConfigFile, profileDir, syncFiles: [], log: () => undefined });
    assert.deepEqual(report.junctionsCreated, ['skills']);
    assert.equal(report.warnings.length, 1);
    assert.match(report.warnings[0], /^projects: é uma pasta real com conteúdo/);
    assert.equal((await fs.lstat(path.join(profileDir, 'projects'))).isDirectory(), true);

    const same = await prepareProfileDir({ baseDir, baseConfigFile, profileDir: baseDir, syncFiles: [], log: () => undefined });
    assert.equal(same.skipped, true);
    const nested = await prepareProfileDir({ baseDir, baseConfigFile, profileDir: path.join(baseDir, 'profiles', 'x'), syncFiles: [], log: () => undefined });
    assert.equal(nested.skipped, true);
    assert.equal((await fs.readdir(baseDir)).includes('profiles'), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('prepareProfileDir yields when another window holds a fresh lock', async () => {
  const { root, baseDir, baseConfigFile, profileDir } = await makeBase();
  try {
    await fs.mkdir(path.join(profileDir, '.claude-account-switcher.lock'), { recursive: true });
    const blocked = await prepareProfileDir({ baseDir, baseConfigFile, profileDir, syncFiles: [], log: () => undefined });
    assert.equal(blocked.skipped, true);
    assert.match(blocked.warnings[0], /outra janela/);
    const stale = await prepareProfileDir({ baseDir, baseConfigFile, profileDir, syncFiles: [], now: () => Date.now() + 60_000, log: () => undefined });
    assert.equal(stale.skipped, false);
    assert.deepEqual([...stale.junctionsCreated].sort(), ['projects', 'skills']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('syncFileByMtime copies the newer side with a backup and refuses empty or broken JSON', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cas-sync-'));
  const warnings: string[] = [];
  const warn = (message: string) => warnings.push(message);
  try {
    const base = path.join(root, 'settings.json');
    const profile = path.join(root, 'profile', 'settings.json');
    await fs.mkdir(path.dirname(profile));
    assert.equal(await syncFileByMtime(base, profile, warn), 'none');
    await fs.writeFile(base, '{"v":1}');
    assert.equal(await syncFileByMtime(base, profile, warn), 'base->profile');
    assert.equal(await fs.readFile(profile, 'utf8'), '{"v":1}');
    assert.equal(await syncFileByMtime(base, profile, warn), 'none');

    await fs.writeFile(profile, '{"v":2}');
    const later = new Date(Date.now() + 10_000);
    await fs.utimes(profile, later, later);
    assert.equal(await syncFileByMtime(base, profile, warn), 'profile->base');
    assert.equal(await fs.readFile(base, 'utf8'), '{"v":2}');
    assert.equal(await fs.readFile(`${base}.bak`, 'utf8'), '{"v":1}');

    await fs.writeFile(profile, '');
    const evenLater = new Date(Date.now() + 20_000);
    await fs.utimes(profile, evenLater, evenLater);
    assert.equal(await syncFileByMtime(base, profile, warn), 'skipped');
    assert.equal(await fs.readFile(base, 'utf8'), '{"v":2}');

    await fs.writeFile(profile, '{"v":');
    await fs.utimes(profile, evenLater, evenLater);
    assert.equal(await syncFileByMtime(base, profile, warn), 'skipped');

    await fs.writeFile(profile, '{"v":3}');
    const farFuture = new Date(Date.now() + 3_600_000);
    await fs.utimes(profile, farFuture, farFuture);
    assert.equal(await syncFileByMtime(base, profile, warn), 'skipped');
    assert.equal(warnings.length, 3);

    await fs.unlink(base);
    assert.equal(await syncFileByMtime(base, profile, warn), 'none');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
