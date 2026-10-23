export type UsageKind = 'session' | 'weekly' | 'scoped';
export type UsageSource = 'live' | 'cache';

export interface UsageBucket {
  readonly kind: UsageKind;
  readonly label: string;
  readonly percent: number;
  readonly resetsAt?: Date;
  readonly renewed?: boolean;
}

export interface UsageSnapshot {
  readonly session?: UsageBucket;
  readonly weekly?: UsageBucket;
  readonly scoped: readonly UsageBucket[];
  readonly extraUsageEnabled?: boolean;
  readonly fetchedAt?: Date;
  readonly source: UsageSource;
}

export type UsageFailureCategory = 'invalid-token' | 'timeout' | 'network' | 'unauthorized' | 'rate-limited' | 'server' | 'bad-response';

export type UsageFetchResult =
  | { readonly ok: true; readonly raw: unknown }
  | { readonly ok: false; readonly category: UsageFailureCategory; readonly status?: number; readonly retryAfterMs?: number };

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const OAUTH_BETA_HEADER = 'oauth-2025-04-20';
export const USAGE_TIMEOUT_MS = 5_000;

export const SESSION_LABEL = 'Session (5h)';
export const WEEKLY_LABEL = 'Week (7d)';

const TOKEN_PATTERN = /^[\x21-\x7e]+$/;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asDate(value: unknown): Date | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function bucketFromLegacy(value: unknown, label: string, kind: UsageKind): UsageBucket | undefined {
  const record = asRecord(value);
  const percent = record ? asNumber(record.utilization) : undefined;
  if (!record || percent === undefined) {
    return undefined;
  }
  return { kind, label, percent, resetsAt: asDate(record.resets_at) };
}

function scopedLabel(limit: Record<string, unknown>): string {
  const scope = asRecord(limit.scope);
  const model = scope ? asRecord(scope.model) : undefined;
  const name = model ? asString(model.display_name) ?? asString(model.id) : undefined;
  return `${name ?? 'Model'} (7d)`;
}

export function usageFailureLabel(category: UsageFailureCategory, status?: number): string {
  switch (category) {
    case 'invalid-token':
      return 'malformed token';
    case 'timeout':
      return 'usage request timed out';
    case 'network':
      return 'cannot reach the Claude API';
    case 'unauthorized':
      return `token rejected (${status ?? 401})`;
    case 'rate-limited':
      return 'usage rate limit reached (429)';
    case 'server':
      return `Claude API returned ${status ?? 'an error'}`;
    case 'bad-response':
      return 'unexpected usage response';
    default:
      return 'usage request failed';
  }
}

export function parseUsage(raw: unknown, fetchedAt: Date | undefined, source: UsageSource): UsageSnapshot | undefined {
  const root = asRecord(raw);
  if (!root) {
    return undefined;
  }
  let session: UsageBucket | undefined;
  let weekly: UsageBucket | undefined;
  const scoped: UsageBucket[] = [];
  const limits = Array.isArray(root.limits) ? root.limits : [];
  for (const entry of limits) {
    const limit = asRecord(entry);
    const percent = limit ? asNumber(limit.percent) : undefined;
    if (!limit || percent === undefined) {
      continue;
    }
    const resetsAt = asDate(limit.resets_at);
    switch (limit.kind) {
      case 'session':
        session ??= { kind: 'session', label: SESSION_LABEL, percent, resetsAt };
        break;
      case 'weekly_all':
        weekly ??= { kind: 'weekly', label: WEEKLY_LABEL, percent, resetsAt };
        break;
      case 'weekly_scoped':
        scoped.push({ kind: 'scoped', label: scopedLabel(limit), percent, resetsAt });
        break;
      default:
        break;
    }
  }
  session ??= bucketFromLegacy(root.five_hour, SESSION_LABEL, 'session');
  weekly ??= bucketFromLegacy(root.seven_day, WEEKLY_LABEL, 'weekly');
  if (scoped.length === 0) {
    const opus = bucketFromLegacy(root.seven_day_opus, 'Opus (7d)', 'scoped');
    const sonnet = bucketFromLegacy(root.seven_day_sonnet, 'Sonnet (7d)', 'scoped');
    for (const bucket of [opus, sonnet]) {
      if (bucket) {
        scoped.push(bucket);
      }
    }
  }
  if (!session && !weekly && scoped.length === 0) {
    return undefined;
  }
  const extra = asRecord(root.extra_usage);
  const extraUsageEnabled = extra && typeof extra.is_enabled === 'boolean' ? extra.is_enabled : undefined;
  return { session, weekly, scoped, extraUsageEnabled, fetchedAt, source };
}

export function cachedUsageFromConfig(config: Record<string, unknown>): UsageSnapshot | undefined {
  const cached = asRecord(config.cachedUsageUtilization);
  if (!cached) {
    return undefined;
  }
  const fetchedAtMs = asNumber(cached.fetchedAtMs);
  return parseUsage(cached.utilization, fetchedAtMs !== undefined && fetchedAtMs > 0 ? new Date(fetchedAtMs) : undefined, 'cache');
}

function renewBucket(bucket: UsageBucket | undefined, now: Date): UsageBucket | undefined {
  if (!bucket || !bucket.resetsAt || bucket.resetsAt.getTime() > now.getTime()) {
    return bucket;
  }
  return { ...bucket, percent: 0, renewed: true };
}

export function markRenewed(usage: UsageSnapshot, now: Date): UsageSnapshot {
  return {
    ...usage,
    session: renewBucket(usage.session, now),
    weekly: renewBucket(usage.weekly, now),
    scoped: usage.scoped.map((bucket) => renewBucket(bucket, now) as UsageBucket),
  };
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

export async function fetchUsage(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = USAGE_TIMEOUT_MS,
): Promise<UsageFetchResult> {
  if (!TOKEN_PATTERN.test(accessToken)) {
    return { ok: false, category: 'invalid-token' };
  }
  let response: Response;
  try {
    response = await fetchImpl(USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': OAUTH_BETA_HEADER,
        Accept: 'application/json',
        'Cache-Control': 'no-cache',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = (error as Error).name;
    return { ok: false, category: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network' };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, category: 'unauthorized', status: response.status };
  }
  if (response.status === 429) {
    return { ok: false, category: 'rate-limited', status: 429, retryAfterMs: parseRetryAfter(response.headers.get('retry-after')) };
  }
  if (!response.ok) {
    return { ok: false, category: 'server', status: response.status };
  }
  try {
    return { ok: true, raw: await response.json() };
  } catch {
    return { ok: false, category: 'bad-response', status: response.status };
  }
}
