import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  credentialManagerService,
  credentialManagerTarget,
  isExpired,
  parseCredentialsBlob,
  parseCredentialsText,
  readCredentialsFile,
  stateFromText,
} from '../credentials';

const NOW = 1_800_000_000_000;

const BLOB = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'sk-ant-oat01-abc',
    refreshToken: 'sk-ant-ort01-def',
    expiresAt: NOW + 3_600_000,
    scopes: ['user:inference', 'user:profile', 7],
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_20x',
  },
});

test('parseCredentialsText keeps only the fields the extension needs', () => {
  const credentials = parseCredentialsBlob(BLOB);
  assert.deepEqual(credentials, {
    accessToken: 'sk-ant-oat01-abc',
    expiresAt: NOW + 3_600_000,
    scopes: ['user:inference', 'user:profile'],
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_20x',
  });
  assert.deepEqual(parseCredentialsText('{}'), { ok: true });
  assert.deepEqual(parseCredentialsText('{"claudeAiOauth":{"accessToken":" "}}'), { ok: true });
  assert.deepEqual(parseCredentialsText('not json'), { ok: false });
  assert.deepEqual(parseCredentialsText('[]'), { ok: false });
});

test('isExpired applies a one minute margin and ignores a zero expiry', () => {
  const credentials = parseCredentialsBlob(BLOB)!;
  assert.equal(isExpired(credentials, NOW), false);
  assert.equal(isExpired(credentials, NOW + 3_600_000 - 30_000), true);
  assert.equal(parseCredentialsBlob(BLOB.replace(String(NOW + 3_600_000), '0'))?.expiresAt, undefined);
  assert.equal(isExpired({ ...credentials, expiresAt: undefined }, NOW), false);
});

test('stateFromText classifies ok, expired, missing and unreadable', () => {
  assert.equal(stateFromText(BLOB, 'file', NOW).kind, 'ok');
  assert.equal(stateFromText(BLOB, 'file', NOW + 7_200_000).kind, 'expired');
  assert.equal(stateFromText(undefined, 'file', NOW).kind, 'missing');
  assert.equal(stateFromText('{"claudeAiOauth":null}', 'file', NOW).kind, 'missing');
  assert.equal(stateFromText('{{', 'file', NOW).kind, 'error');
});

test('credentialManagerService mirrors the Claude Code naming and the target adds the fixed user', () => {
  assert.equal(credentialManagerService(undefined, undefined), 'Claude Code-credentials');
  assert.equal(credentialManagerService('C:\\p', ''), 'Claude Code-credentials');
  const dir = 'C:\\Users\\t\\.claude-profiles\\pessoal';
  const hash = createHash('sha256').update(dir.normalize('NFC')).digest('hex').slice(0, 8);
  assert.equal(credentialManagerService(dir, undefined), `Claude Code-credentials-${hash}`);
  assert.equal(credentialManagerService(dir, dir), `Claude Code-credentials-${hash}`);
  assert.equal(credentialManagerService('C:\\other', dir), `Claude Code-credentials-${hash}`);
  assert.equal(credentialManagerService(dir, undefined, '-staging'), `Claude Code-staging-credentials-${hash}`);
  assert.equal(credentialManagerTarget('Claude Code-credentials'), 'Claude Code-credentials/claude-code-user');
  assert.equal(credentialManagerTarget('Claude Code-credentials', '#m'), 'Claude Code-credentials#m/claude-code-user');
});

test('readCredentialsFile retries transient states and reports missing files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cas-cred-'));
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  try {
    const file = path.join(dir, '.credentials.json');
    assert.equal((await readCredentialsFile(file, NOW, sleep)).kind, 'missing');
    assert.deepEqual(sleeps, [100]);
    await fs.writeFile(file, BLOB);
    const state = await readCredentialsFile(file, NOW, sleep);
    assert.equal(state.kind, 'ok');
    assert.equal(state.source, 'file');
    await fs.writeFile(file, '{"claudeAiOauth":');
    const broken = await readCredentialsFile(file, NOW, sleep);
    assert.equal(broken.kind, 'error');
    assert.equal(sleeps.length, 3);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
