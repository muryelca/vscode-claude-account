import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { CONFIG_DIR_VAR, SECURE_STORAGE_DIR_VAR } from '../env';
import { MonitorDeps, emailMismatch, readAccountSnapshot } from '../monitor';
import { ProfilePaths } from '../profiles';
import { readSharedState, sharedStatePath } from '../usageCoordinator';
import { NOW_ISO, REAL_SHAPE } from './fixtures';

const NOW = new Date(NOW_ISO);

interface Harness {
  readonly dir: string;
  readonly paths: ProfilePaths;
  readonly deps: MonitorDeps & { logs: string[]; calls: number };
}

async function harness(overrides: Partial<MonitorDeps> = {}): Promise<Harness> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cas-mon-'));
  const logs: string[] = [];
  const deps = {
    platform: 'win32' as NodeJS.Platform,
    fetchImpl: (async () => {
      deps.calls += 1;
      return new Response(JSON.stringify(REAL_SHAPE), { status: 200 });
    }) as typeof fetch,
    runPowerShell: async () => 'MISSING',
    log: (message: string) => {
      logs.push(message);
    },
    now: () => NOW,
    sharedDir: path.join(dir, 'shared'),
    liveQueries: true,
    liveMinIntervalMs: 5 * 60_000,
    logs,
    calls: 0,
    ...overrides,
  };
  return {
    dir,
    paths: { configDir: dir, configFile: path.join(dir, '.claude.json'), credentialsFile: path.join(dir, '.credentials.json'), isDefault: false },
    deps,
  };
}

const VALID_CREDENTIALS = JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt: NOW.getTime() + 3_600_000, scopes: ['user:profile'] } });

test('emailMismatch compares case-insensitively and only when both sides are known', () => {
  assert.equal(emailMismatch({ name: 'P', email: 'A@b.c' }, { email: 'a@B.c' }), undefined);
  assert.equal(emailMismatch({ name: 'P' }, { email: 'x@y.z' }), undefined);
  assert.match(emailMismatch({ name: 'P', email: 'a@b.c' }, { email: 'x@y.z' }) ?? '', /x@y.z.*«P».*a@b.c/);
});

test('readAccountSnapshot fetches live usage once and shares it with other windows through the state file', async () => {
  const { dir, paths, deps } = await harness();
  try {
    await fs.writeFile(paths.configFile, JSON.stringify({ oauthAccount: { emailAddress: 'pessoal@example.com', accountUuid: 'u1' } }));
    await fs.writeFile(paths.credentialsFile, VALID_CREDENTIALS);
    const first = await readAccountSnapshot({ name: 'Pessoal', email: 'pessoal@example.com' }, paths, { [CONFIG_DIR_VAR]: dir, [SECURE_STORAGE_DIR_VAR]: dir }, deps);
    assert.equal(first.credential.kind, 'ok');
    assert.equal(first.loggedIn, true);
    assert.equal(first.usage?.source, 'live');
    assert.equal(first.usage?.session?.percent, 2);
    assert.equal(first.mismatch, undefined);
    assert.equal(deps.calls, 1);
    const shared = await readSharedState(sharedStatePath(deps.sharedDir, dir));
    assert.equal(shared?.fetchedAtMs, NOW.getTime());

    const second = await readAccountSnapshot({ name: 'Pessoal' }, paths, {}, deps);
    assert.equal(second.usage?.source, 'live');
    assert.equal(second.usageNote, 'dado recente');
    assert.equal(deps.calls, 1);

    const manual = await readAccountSnapshot({ name: 'Pessoal' }, paths, {}, { ...deps, now: () => new Date(NOW.getTime() + 90_000) }, true);
    assert.equal(deps.calls, 2);
    assert.equal(manual.usageNote, undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('readAccountSnapshot prefers the Claude Code cache when it is fresh and never calls the API without live queries', async () => {
  const { dir, paths, deps } = await harness({ liveQueries: false });
  try {
    await fs.writeFile(
      paths.configFile,
      JSON.stringify({ oauthAccount: { emailAddress: 'x@y.z', accountUuid: 'u1' }, cachedUsageUtilization: { fetchedAtMs: NOW.getTime() - 60_000, accountUuid: 'u1', utilization: REAL_SHAPE } }),
    );
    await fs.writeFile(paths.credentialsFile, VALID_CREDENTIALS);
    const snapshot = await readAccountSnapshot({ name: 'Pessoal', email: 'pessoal@example.com' }, paths, {}, deps);
    assert.equal(snapshot.usage?.source, 'cache');
    assert.equal(snapshot.usageNote, 'consultas ao vivo desativadas');
    assert.match(snapshot.mismatch ?? '', /x@y.z/);
    assert.equal(deps.calls, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('readAccountSnapshot falls back to the cache, records holds and marks renewed windows', async () => {
  const { dir, paths, deps } = await harness({ fetchImpl: (async () => new Response('', { status: 401 })) as typeof fetch });
  try {
    const old = NOW.getTime() - 2 * 3_600_000;
    await fs.writeFile(
      paths.configFile,
      JSON.stringify({ oauthAccount: { emailAddress: 'x@y.z', accountUuid: 'u1' }, cachedUsageUtilization: { fetchedAtMs: old, accountUuid: 'u1', utilization: REAL_SHAPE } }),
    );
    await fs.writeFile(paths.credentialsFile, JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt: NOW.getTime() - 1, scopes: [] } }));
    const expired = await readAccountSnapshot({ name: 'Pessoal' }, paths, {}, deps);
    assert.equal(expired.credential.kind, 'expired');
    assert.equal(expired.usage?.source, 'cache');
    assert.equal(expired.usageNote, 'sem token válido');

    await fs.writeFile(paths.credentialsFile, VALID_CREDENTIALS);
    const rejected = await readAccountSnapshot({ name: 'Pessoal' }, paths, {}, deps);
    assert.equal(rejected.credential.kind, 'ok');
    assert.equal(rejected.usage?.source, 'cache');
    assert.equal(rejected.usageError, 'token recusado (401)');
    const shared = await readSharedState(sharedStatePath(deps.sharedDir, dir));
    assert.equal(shared?.holdReason, 'unauthorized');

    const held = await readAccountSnapshot({ name: 'Pessoal' }, paths, {}, deps);
    assert.equal(held.usageError, undefined);
    assert.match(held.usageNote ?? '', /token recusado; aguardando novo login/);

    const renewed = await readAccountSnapshot({ name: 'Pessoal' }, paths, {}, { ...deps, liveQueries: false, now: () => new Date('2026-10-22T00:00:00Z') });
    assert.equal(renewed.usage?.session?.renewed, true);
    assert.equal(renewed.usage?.session?.percent, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('readAccountSnapshot uses the Credential Manager when Claude Code says so and falls back to the file', async () => {
  const { dir, paths, deps } = await harness();
  try {
    await fs.writeFile(paths.configFile, JSON.stringify({ cachedGrowthBookFeatures: { tengu_windows_credman: true } }));
    const targets: string[] = [];
    const blob = Buffer.from(VALID_CREDENTIALS).toString('base64');
    const managed = await readAccountSnapshot({ name: 'Pessoal' }, paths, { [CONFIG_DIR_VAR]: dir, [SECURE_STORAGE_DIR_VAR]: dir }, {
      ...deps,
      runPowerShell: async (_script, env) => {
        const requested = env.CLAUDE_ACCOUNT_CRED_TARGETS.split('\n');
        targets.push(...requested);
        return requested.map((target) => (target.endsWith('/claude-code-user') && !target.includes('#') ? `OK ${blob}` : 'MISSING')).join('\n');
      },
    });
    assert.equal(managed.credential.kind, 'ok');
    assert.equal(managed.credential.source, 'credential-manager');
    assert.equal(managed.loggedIn, true);
    assert.match(targets[0], /^Claude Code-credentials-[0-9a-f]{8}#m\/claude-code-user$/);
    assert.equal(managed.usage?.source, 'live');

    await fs.writeFile(paths.credentialsFile, VALID_CREDENTIALS);
    const fallback = await readAccountSnapshot({ name: 'Pessoal' }, paths, {}, { ...deps, runPowerShell: async () => 'MISSING\nMISSING\nMISSING' });
    assert.equal(fallback.credential.source, 'file');
    assert.equal(fallback.credential.kind, 'ok');

    await fs.unlink(paths.credentialsFile);
    const nothing = await readAccountSnapshot({ name: 'Pessoal' }, paths, {}, { ...deps, platform: 'linux' });
    assert.equal(nothing.credential.kind, 'missing');
    assert.equal(nothing.loggedIn, false);
    assert.equal(nothing.usage, undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
