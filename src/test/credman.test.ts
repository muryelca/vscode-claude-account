import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PowerShellRunner, decodeCredentialBlob, decodeTextBlob, readCredentialManager, readTargets } from '../credman';

const JSON_BLOB = '{"claudeAiOauth":{"accessToken":"tok","expiresAt":9999999999999,"scopes":[]}}';

function runnerFor(entries: Record<string, Buffer>, seen: string[][] = []): PowerShellRunner {
  return async (_script, env) => {
    const targets = env.CLAUDE_ACCOUNT_CRED_TARGETS.split('\n');
    seen.push(targets);
    return targets.map((target) => (entries[target] ? `OK ${entries[target].toString('base64')}` : 'MISSING')).join('\r\n') + '\r\n';
  };
}

test('decodeCredentialBlob accepts utf8 and utf16le payloads and rejects non JSON', () => {
  assert.equal(decodeCredentialBlob(Buffer.from(JSON_BLOB, 'utf8').toString('base64')), JSON_BLOB);
  assert.equal(decodeCredentialBlob(Buffer.from(`${JSON_BLOB}\0`, 'utf16le').toString('base64')), JSON_BLOB);
  assert.equal(decodeCredentialBlob(''), undefined);
  assert.equal(decodeCredentialBlob(Buffer.from('garbage').toString('base64')), undefined);
  assert.equal(decodeTextBlob(Buffer.from('abc\0', 'utf16le')), 'abc');
  assert.equal(decodeTextBlob(Buffer.from('abc', 'utf8')), 'abc');
});

test('readTargets maps every requested target to its blob or undefined', async () => {
  const blobs = await readTargets(['a', 'b', 'c'], runnerFor({ a: Buffer.from('x'), c: Buffer.from('z') }));
  assert.deepEqual(
    blobs.map((blob) => blob?.toString('utf8')),
    ['x', undefined, 'z'],
  );
});

test('readCredentialManager reads the single entry under <service>/claude-code-user', async () => {
  const seen: string[][] = [];
  const state = await readCredentialManager('Claude Code-credentials-abcd1234', runnerFor({ 'Claude Code-credentials-abcd1234/claude-code-user': Buffer.from(JSON_BLOB, 'utf8') }, seen), 1_000);
  assert.deepEqual(seen, [['Claude Code-credentials-abcd1234#m/claude-code-user', 'Claude Code-credentials-abcd1234/claude-code-user#m', 'Claude Code-credentials-abcd1234/claude-code-user']]);
  assert.equal(state.kind, 'ok');
  assert.equal(state.source, 'credential-manager');
});

test('readCredentialManager reassembles chunked entries from the manifest', async () => {
  const service = 'Claude Code-credentials';
  const payload = Buffer.from(JSON_BLOB, 'utf8').toString('base64');
  const chunks = [payload.slice(0, 40), payload.slice(40, 80), payload.slice(80)];
  const entries: Record<string, Buffer> = { [`${service}#m/claude-code-user`]: Buffer.from(JSON.stringify({ n: 3, l: payload.length }), 'utf8') };
  chunks.forEach((chunk, index) => {
    entries[`${service}#${index}/claude-code-user`] = Buffer.from(chunk, 'utf8');
  });
  const seen: string[][] = [];
  const state = await readCredentialManager(service, runnerFor(entries, seen), 1_000);
  assert.equal(state.kind, 'ok');
  assert.deepEqual(seen[1], [`${service}#0/claude-code-user`, `${service}#1/claude-code-user`, `${service}#2/claude-code-user`]);

  const inconsistent = { ...entries, [`${service}#m/claude-code-user`]: Buffer.from(JSON.stringify({ n: 3, l: payload.length + 1 }), 'utf8') };
  const broken = await readCredentialManager(service, runnerFor(inconsistent));
  assert.equal(broken.kind, 'error');
  assert.match(broken.kind === 'error' ? broken.message : '', /inconsistent/);

  const incomplete = { ...entries };
  delete incomplete[`${service}#2/claude-code-user`];
  const missingChunk = await readCredentialManager(service, runnerFor(incomplete));
  assert.equal(missingChunk.kind, 'error');
});

test('readCredentialManager reports missing and PowerShell failures without leaking the script', async () => {
  const missing = await readCredentialManager('x', runnerFor({}));
  assert.equal(missing.kind, 'missing');
  const failed = await readCredentialManager('x', async () => {
    throw new Error('code 1, powershell not found');
  });
  assert.equal(failed.kind, 'error');
  assert.equal(failed.kind === 'error' ? failed.message : '', 'Credential Manager: code 1, powershell not found');
});
