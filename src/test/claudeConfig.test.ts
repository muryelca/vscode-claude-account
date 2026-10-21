import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { parseClaudeConfig, readClaudeConfig } from '../claudeConfig';
import { REAL_SHAPE } from './fixtures';

const CONFIG = {
  oauthAccount: {
    accountUuid: 'acc-1',
    emailAddress: 'pessoal@example.com',
    organizationName: 'Pessoal Org',
    userRateLimitTier: 'default_claude_max_5x',
  },
  cachedGrowthBookFeatures: { tengu_windows_credman: true },
  cachedUsageUtilization: { fetchedAtMs: 1792594476016, accountUuid: 'acc-1', utilization: REAL_SHAPE },
};

test('parseClaudeConfig extracts the account, the credential manager flag and the cached usage', () => {
  const info = parseClaudeConfig(JSON.stringify(CONFIG));
  assert.equal(info.account?.email, 'pessoal@example.com');
  assert.equal(info.account?.organizationName, 'Pessoal Org');
  assert.equal(info.account?.rateLimitTier, 'default_claude_max_5x');
  assert.equal(info.usesCredentialManager, true);
  assert.equal(info.cachedUsage?.session?.percent, 2);
});

test('parseClaudeConfig drops a cache that belongs to another account and tolerates bad JSON', () => {
  const foreign = parseClaudeConfig(JSON.stringify({ ...CONFIG, cachedUsageUtilization: { ...CONFIG.cachedUsageUtilization, accountUuid: 'acc-2' } }));
  assert.equal(foreign.cachedUsage, undefined);
  const broken = parseClaudeConfig('{');
  assert.equal(broken.exists, true);
  assert.match(broken.error ?? '', /JSON inválido/);
  assert.equal(parseClaudeConfig('[]').error, 'conteúdo não é um objeto');
});

test('readClaudeConfig reports a missing file without throwing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cas-cfg-'));
  try {
    const file = path.join(dir, '.claude.json');
    assert.deepEqual(await readClaudeConfig(file), { exists: false, usesCredentialManager: false });
    await fs.writeFile(file, JSON.stringify({ oauthAccount: { emailAddress: 'x@y.z' } }));
    assert.equal((await readClaudeConfig(file)).account?.email, 'x@y.z');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
