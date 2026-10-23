import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  MANUAL_MIN_INTERVAL_MS,
  MAX_HOLD_MS,
  RATE_LIMIT_HOLD_MS,
  acquireLock,
  decideLiveFetch,
  holdFor,
  lockPath,
  profileKey,
  readSharedState,
  releaseLock,
  sharedStatePath,
  writeSharedState,
} from '../usageCoordinator';

const NOW = 1_800_000_000_000;
const FIVE_MIN = 5 * 60_000;

function decide(overrides: Partial<Parameters<typeof decideLiveFetch>[0]> = {}) {
  return decideLiveFetch({ now: NOW, liveEnabled: true, manual: false, credentialOk: true, minIntervalMs: FIVE_MIN, ...overrides });
}

test('decideLiveFetch only calls the API when live queries are on, the token is valid and data is old', () => {
  assert.equal(decide().fetch, true);
  assert.equal(decide({ liveEnabled: false }).reason, 'live usage disabled');
  assert.equal(decide({ credentialOk: false }).reason, 'no valid token');
  assert.equal(decide({ newestKnownFetchedAtMs: NOW - 60_000 }).reason, 'data is recent');
  assert.equal(decide({ newestKnownFetchedAtMs: NOW - FIVE_MIN - 1 }).fetch, true);
  assert.equal(decide({ state: { lastAttemptMs: NOW - 10_000 } }).reason, 'recent attempt');
});

test('decideLiveFetch honours holds and lets a manual request through at most once a minute', () => {
  assert.match(decide({ state: { holdUntilMs: NOW + 1000, holdReason: 'rate-limited' } }).reason, /on hold/);
  assert.equal(decide({ state: { holdUntilMs: NOW - 1, holdReason: 'rate-limited' } }).fetch, true);
  const unauthorized = { holdUntilMs: NOW + MAX_HOLD_MS, holdReason: 'unauthorized', holdCredentialsMtimeMs: 10 };
  assert.match(decide({ state: unauthorized, credentialsMtimeMs: 10 }).reason, /new sign-in/);
  assert.equal(decide({ state: unauthorized, credentialsMtimeMs: 11 }).fetch, true);
  assert.equal(decide({ manual: true, newestKnownFetchedAtMs: NOW - 1000 }).fetch, true);
  assert.equal(decide({ manual: true, state: { lastAttemptMs: NOW - MANUAL_MIN_INTERVAL_MS + 1 } }).reason, 'recent manual request');
});

test('holdFor maps failure categories to bounded holds', () => {
  assert.deepEqual(holdFor('rate-limited', undefined, NOW, 5), { holdUntilMs: NOW + RATE_LIMIT_HOLD_MS, holdReason: 'rate-limited' });
  assert.deepEqual(holdFor('rate-limited', 2 * MAX_HOLD_MS, NOW, 5), { holdUntilMs: NOW + MAX_HOLD_MS, holdReason: 'rate-limited' });
  assert.deepEqual(holdFor('unauthorized', undefined, NOW, 5), { holdUntilMs: NOW + MAX_HOLD_MS, holdReason: 'unauthorized', holdCredentialsMtimeMs: 5 });
  assert.equal(holdFor('network', undefined, NOW, 5).holdReason, 'network');
});

test('shared state and lock files live under a key derived from the config dir', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cas-coord-'));
  try {
    assert.equal(profileKey('C:\\P'), profileKey('c:\\p'));
    const file = sharedStatePath(root, 'C:\\p');
    assert.equal(await readSharedState(file), undefined);
    await writeSharedState(file, { fetchedAtMs: 1, raw: { a: 1 } });
    assert.deepEqual(await readSharedState(file), { fetchedAtMs: 1, raw: { a: 1 } });
    await fs.writeFile(file, 'broken');
    assert.equal(await readSharedState(file), undefined);

    const lock = lockPath(root, 'C:\\p');
    assert.equal(await acquireLock(lock, Date.now()), true);
    assert.equal(await acquireLock(lock, Date.now()), false);
    assert.equal(await acquireLock(lock, Date.now() + 60_000), true);
    await releaseLock(lock);
    await releaseLock(lock);
    assert.equal(await acquireLock(lock, Date.now()), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
