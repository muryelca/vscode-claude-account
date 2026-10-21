import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OAUTH_BETA_HEADER, USAGE_URL, cachedUsageFromConfig, fetchUsage, markRenewed, parseUsage, usageFailureLabel } from '../usage';
import { NOW_ISO, REAL_SHAPE } from './fixtures';

const NOW = new Date(NOW_ISO);

test('parseUsage prefers the limits array and labels scoped limits by model', () => {
  const usage = parseUsage(REAL_SHAPE, NOW, 'live');
  assert.equal(usage?.session?.percent, 2);
  assert.equal(usage?.session?.resetsAt?.toISOString(), '2026-10-21T19:00:00.296Z');
  assert.equal(usage?.weekly?.percent, 1);
  assert.deepEqual(usage?.scoped.map((bucket) => [bucket.label, bucket.percent]), [['Fable (7d)', 0]]);
  assert.equal(usage?.extraUsageEnabled, false);
  assert.equal(usage?.source, 'live');
  assert.equal(usage?.fetchedAt, NOW);
});

test('parseUsage falls back to the legacy five_hour and seven_day fields', () => {
  const usage = parseUsage(
    { five_hour: { utilization: 42.4, resets_at: 'bad date' }, seven_day: { utilization: 80 }, seven_day_opus: { utilization: 12 } },
    NOW,
    'cache',
  );
  assert.equal(usage?.session?.percent, 42.4);
  assert.equal(usage?.session?.resetsAt, undefined);
  assert.equal(usage?.weekly?.percent, 80);
  assert.deepEqual(usage?.scoped.map((bucket) => bucket.label), ['Opus (7d)']);
  assert.equal(parseUsage({}, NOW, 'live'), undefined);
  assert.equal(parseUsage('x', NOW, 'live'), undefined);
});

test('cachedUsageFromConfig reads the cache Claude Code keeps in .claude.json', () => {
  const usage = cachedUsageFromConfig({ cachedUsageUtilization: { fetchedAtMs: 1792594476016, accountUuid: 'u', utilization: REAL_SHAPE } });
  assert.equal(usage?.source, 'cache');
  assert.equal(usage?.fetchedAt?.getTime(), 1792594476016);
  assert.equal(usage?.session?.percent, 2);
  assert.equal(cachedUsageFromConfig({ cachedUsageUtilization: { utilization: REAL_SHAPE } })?.fetchedAt, undefined);
  assert.equal(cachedUsageFromConfig({}), undefined);
});

test('markRenewed zeroes the buckets whose window already reset', () => {
  const usage = parseUsage(REAL_SHAPE, NOW, 'cache')!;
  const later = markRenewed(usage, new Date('2026-10-22T00:00:00Z'));
  assert.equal(later.session?.percent, 0);
  assert.equal(later.session?.renewed, true);
  assert.equal(later.weekly?.percent, 1);
  assert.equal(later.weekly?.renewed, undefined);
  assert.equal(markRenewed(usage, NOW).session?.renewed, undefined);
});

test('fetchUsage sends the bearer token with the oauth beta header and categorizes failures', async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers as Record<string, string> });
    return new Response(JSON.stringify(REAL_SHAPE), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const ok = await fetchUsage('tok', fakeFetch);
  assert.equal(ok.ok, true);
  assert.equal(calls[0].url, USAGE_URL);
  assert.equal(calls[0].headers.Authorization, 'Bearer tok');
  assert.equal(calls[0].headers['anthropic-beta'], OAUTH_BETA_HEADER);

  assert.deepEqual(await fetchUsage('tok', (async () => new Response('nope', { status: 401 })) as typeof fetch), { ok: false, category: 'unauthorized', status: 401 });
  assert.deepEqual(await fetchUsage('tok', (async () => new Response('slow', { status: 429, headers: { 'retry-after': '120' } })) as typeof fetch), {
    ok: false,
    category: 'rate-limited',
    status: 429,
    retryAfterMs: 120_000,
  });
  assert.deepEqual(await fetchUsage('tok', (async () => new Response('x', { status: 503 })) as typeof fetch), { ok: false, category: 'server', status: 503 });
  assert.deepEqual(await fetchUsage('tok', (async () => new Response('not json', { status: 200 })) as typeof fetch), { ok: false, category: 'bad-response', status: 200 });
  assert.deepEqual(await fetchUsage('tok', (async () => {
    throw new Error('offline');
  }) as typeof fetch), { ok: false, category: 'network' });
  assert.deepEqual(await fetchUsage('tok', (async () => {
    throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
  }) as typeof fetch), { ok: false, category: 'timeout' });
  assert.deepEqual(await fetchUsage('tok with space', fakeFetch), { ok: false, category: 'invalid-token' });
  assert.equal(calls.length, 1);
});

test('usageFailureLabel speaks pt-BR without echoing internals', () => {
  assert.equal(usageFailureLabel('unauthorized', 403), 'token recusado (403)');
  assert.equal(usageFailureLabel('rate-limited'), 'limite de consultas de uso atingido (429)');
  assert.equal(usageFailureLabel('network'), 'sem conexão com a API do Claude');
});
