import { CredentialState } from './credentials';
import { AccountInfo } from './claudeConfig';
import { Profile, ProfilePaths } from './profiles';
import { UsageBucket, UsageSnapshot } from './usage';

export type Severity = 'normal' | 'warning' | 'error';

export interface StatusView {
  readonly profile: Profile;
  readonly paths: ProfilePaths;
  readonly account?: AccountInfo;
  readonly credential?: CredentialState;
  readonly loggedIn: boolean;
  readonly usage?: UsageSnapshot;
  readonly usageError?: string;
  readonly usageNote?: string;
  readonly mismatch?: string;
  readonly overrideWarnings: readonly string[];
  readonly pendingReload: boolean;
  readonly loading: boolean;
  readonly warnAtPercent: number;
  readonly now: Date;
}

export const STALE_AFTER_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const LOCALE = 'en-US';
const PLAN_NAMES: Readonly<Record<string, string>> = { pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise' };

export function escapeMarkdown(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/[\\`*_{}[\]()#+!<>~|$]/g, (char) => `\\${char}`);
}

export function formatPercent(percent: number): string {
  return `${Math.round(percent)}%`;
}

export function severityFor(percent: number | undefined, warnAtPercent: number): Severity {
  if (percent === undefined) {
    return 'normal';
  }
  const rounded = Math.round(percent);
  if (rounded >= 100) {
    return 'error';
  }
  return rounded >= warnAtPercent ? 'warning' : 'normal';
}

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function timeOf(date: Date): string {
  return new Intl.DateTimeFormat(LOCALE, { hour: 'numeric', minute: '2-digit' }).format(date);
}

function dayOf(date: Date): string {
  return new Intl.DateTimeFormat(LOCALE, { month: 'short', day: 'numeric' }).format(date);
}

export function formatResetsAt(resetsAt: Date, now: Date): string {
  const time = timeOf(resetsAt);
  if (resetsAt.getTime() <= now.getTime()) {
    return sameLocalDay(resetsAt, now) ? `reset today at ${time}` : `reset on ${dayOf(resetsAt)} at ${time}`;
  }
  if (sameLocalDay(resetsAt, now)) {
    return `resets today at ${time}`;
  }
  if (sameLocalDay(resetsAt, new Date(now.getTime() + DAY_MS))) {
    return `resets tomorrow at ${time}`;
  }
  if (resetsAt.getTime() - now.getTime() < 6 * DAY_MS) {
    const weekday = new Intl.DateTimeFormat(LOCALE, { weekday: 'short' }).format(resetsAt);
    return `resets ${weekday} at ${time}`;
  }
  return `resets ${dayOf(resetsAt)} at ${time}`;
}

export function formatAge(from: Date, now: Date): string {
  const seconds = Math.max(0, Math.round((now.getTime() - from.getTime()) / 1000));
  if (seconds < 60) {
    return 'just now';
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} h ago`;
  }
  return `${Math.round(hours / 24)} d ago`;
}

export function planLabel(subscriptionType: string | undefined, rateLimitTier: string | undefined): string | undefined {
  const tierMatch = rateLimitTier?.match(/^default_claude_(pro|max|team|enterprise)(?:_(\d+x))?$/);
  const name = subscriptionType ? PLAN_NAMES[subscriptionType] : tierMatch ? PLAN_NAMES[tierMatch[1]] : undefined;
  const multiplier = tierMatch?.[2];
  if (!name) {
    return undefined;
  }
  return multiplier ? `${name} ${multiplier}` : name;
}

function credentialsOf(credential: CredentialState | undefined) {
  return credential && (credential.kind === 'ok' || credential.kind === 'expired') ? credential.credentials : undefined;
}

export function isStale(usage: UsageSnapshot | undefined, now: Date): boolean {
  return usage !== undefined && (usage.fetchedAt === undefined || now.getTime() - usage.fetchedAt.getTime() > STALE_AFTER_MS);
}

function allBuckets(usage: UsageSnapshot | undefined): UsageBucket[] {
  if (!usage) {
    return [];
  }
  return [usage.session, usage.weekly, ...usage.scoped].filter((bucket): bucket is UsageBucket => bucket !== undefined);
}

export function highestBucket(usage: UsageSnapshot | undefined): UsageBucket | undefined {
  let best: UsageBucket | undefined;
  for (const bucket of allBuckets(usage)) {
    if (!best || Math.round(bucket.percent) > Math.round(best.percent)) {
      best = bucket;
    }
  }
  return best;
}

export function credentialLabel(view: StatusView): string | undefined {
  if (!view.loggedIn) {
    return 'signed out';
  }
  switch (view.credential?.kind) {
    case 'expired':
      return 'session expired';
    case 'error':
      return 'credentials unreadable';
    case 'missing':
      return 'credentials not found';
    default:
      return undefined;
  }
}

function shortLabel(bucket: UsageBucket): string {
  if (bucket.kind === 'session') {
    return '5h';
  }
  if (bucket.kind === 'weekly') {
    return '7d';
  }
  return bucket.label.replace(/\s*\(7d\)$/, '');
}

export function statusBarText(view: StatusView): string {
  const parts: string[] = [`$(account) ${view.profile.name}`];
  if (view.loading) {
    parts.push('$(loading~spin)');
    return parts.join(' ');
  }
  if (view.usage?.session) {
    parts.push(`5h ${formatPercent(view.usage.session.percent)}`);
  }
  if (view.usage?.weekly) {
    parts.push(`7d ${formatPercent(view.usage.weekly.percent)}`);
  }
  const worst = highestBucket(view.usage);
  if (worst && worst.kind === 'scoped' && severityFor(worst.percent, view.warnAtPercent) !== 'normal') {
    parts.push(`${shortLabel(worst)} ${formatPercent(worst.percent)}`);
  }
  if (isStale(view.usage, view.now)) {
    parts.push('$(history)');
  }
  const credentialNote = credentialLabel(view);
  if (credentialNote && (!view.loggedIn || view.credential?.kind === 'error' || !view.usage)) {
    parts.push(`$(warning) ${credentialNote}`);
  }
  if (view.mismatch || view.overrideWarnings.length) {
    parts.push('$(alert)');
  }
  if (view.pendingReload) {
    parts.push('$(debug-restart) reload');
  }
  return parts.join('  ');
}

export function statusSeverity(view: StatusView): Severity {
  if (view.credential?.kind === 'error' || view.mismatch || view.overrideWarnings.length) {
    return 'warning';
  }
  return severityFor(highestBucket(view.usage)?.percent, view.warnAtPercent);
}

function bucketLine(bucket: UsageBucket, now: Date): string {
  const reset = bucket.resetsAt ? ` · ${formatResetsAt(bucket.resetsAt, now)}` : '';
  const renewed = bucket.renewed ? ' (window reset, no new data yet)' : '';
  return `${escapeMarkdown(bucket.label)}: **${formatPercent(bucket.percent)}**${reset}${renewed}`;
}

function credentialHint(view: StatusView): string {
  if (!view.loggedIn) {
    return `Open Claude Code in this window and sign in with ${escapeMarkdown(view.profile.email ?? "this profile's account")}.`;
  }
  switch (view.credential?.kind) {
    case 'expired':
      return 'Claude Code renews the session the next time you use a chat in this window.';
    case 'error':
      return escapeMarkdown(view.credential.message);
    default:
      return 'The account is registered but no token was found, so usage comes from the cache only.';
  }
}

export function tooltipMarkdown(view: StatusView): string {
  const lines: string[] = [];
  const credentials = credentialsOf(view.credential);
  const identity = [
    view.account?.email ?? view.profile.email,
    view.account?.organizationName,
    planLabel(credentials?.subscriptionType, credentials?.rateLimitTier ?? view.account?.rateLimitTier),
  ]
    .filter((part): part is string => Boolean(part))
    .map(escapeMarkdown)
    .join(' · ');
  lines.push(`**${escapeMarkdown(view.profile.name)}**${identity ? ` · ${identity}` : ''}`);
  lines.push('');
  if (view.mismatch) {
    lines.push(`$(alert) ${escapeMarkdown(view.mismatch)}`);
    lines.push('');
  }
  for (const warning of view.overrideWarnings) {
    lines.push(`$(alert) ${escapeMarkdown(warning)}`);
    lines.push('');
  }
  if (view.loading) {
    lines.push('Fetching usage...');
  } else if (view.usage) {
    for (const bucket of allBuckets(view.usage)) {
      lines.push(bucketLine(bucket, view.now));
      lines.push('');
    }
    if (view.usage.extraUsageEnabled !== undefined) {
      lines.push(`Extra usage: ${view.usage.extraUsageEnabled ? 'on' : 'off'}`);
      lines.push('');
    }
    const origin = view.usage.source === 'live' ? 'Live usage' : 'Usage from the Claude Code cache';
    const age = view.usage.fetchedAt ? formatAge(view.usage.fetchedAt, view.now) : 'age unknown';
    const stale = isStale(view.usage, view.now) ? ' $(history) stale' : '';
    lines.push(`${origin}, ${age}${stale}`);
  } else {
    lines.push('Usage unavailable');
  }
  const credentialNote = credentialLabel(view);
  if (credentialNote) {
    lines.push('');
    lines.push(`$(warning) ${credentialNote[0].toUpperCase()}${credentialNote.slice(1)}. ${credentialHint(view)}`);
  }
  if (view.usageError) {
    lines.push('');
    lines.push(`Last request failed: ${escapeMarkdown(view.usageError)}`);
  } else if (view.usageNote && view.usage?.source !== 'live') {
    lines.push('');
    lines.push(`Live usage: ${escapeMarkdown(view.usageNote)}`);
  }
  if (view.pendingReload) {
    lines.push('');
    lines.push('$(debug-restart) Reload the window: open chats and terminals keep the previous account until then.');
  }
  lines.push('');
  lines.push('---');
  lines.push(`Directory: \`${view.paths.configDir.replace(/`/g, "'")}\``);
  lines.push('');
  lines.push('[Switch profile](command:claudeAccount.switch) · [Refresh usage](command:claudeAccount.refreshUsage) · [Menu](command:claudeAccount.menu)');
  return lines.join('\n');
}
