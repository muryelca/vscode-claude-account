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
  return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(date);
}

export function formatResetsAt(resetsAt: Date, now: Date): string {
  const time = timeOf(resetsAt);
  if (resetsAt.getTime() <= now.getTime()) {
    return sameLocalDay(resetsAt, now) ? `renovou hoje às ${time}` : `renovou em ${new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' }).format(resetsAt)} às ${time}`;
  }
  if (sameLocalDay(resetsAt, now)) {
    return `renova hoje às ${time}`;
  }
  const tomorrow = new Date(now.getTime() + DAY_MS);
  if (sameLocalDay(resetsAt, tomorrow)) {
    return `renova amanhã às ${time}`;
  }
  if (resetsAt.getTime() - now.getTime() < 6 * DAY_MS) {
    const weekday = new Intl.DateTimeFormat('pt-BR', { weekday: 'short' }).format(resetsAt).replace('.', '');
    return `renova ${weekday} às ${time}`;
  }
  const day = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' }).format(resetsAt);
  return `renova ${day} às ${time}`;
}

export function formatAge(from: Date, now: Date): string {
  const seconds = Math.max(0, Math.round((now.getTime() - from.getTime()) / 1000));
  if (seconds < 60) {
    return 'agora';
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `há ${minutes} min`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `há ${hours} h`;
  }
  return `há ${Math.round(hours / 24)} d`;
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
    return 'sem login';
  }
  switch (view.credential?.kind) {
    case 'expired':
      return 'sessão expirada';
    case 'error':
      return 'erro ao ler credenciais';
    case 'missing':
      return 'credenciais não lidas';
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
    parts.push('$(debug-restart) recarregar');
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
  const renewed = bucket.renewed ? ' (janela renovada, sem dado novo)' : '';
  return `${escapeMarkdown(bucket.label)}: **${formatPercent(bucket.percent)}**${reset}${renewed}`;
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
    lines.push('Consultando o uso...');
  } else if (view.usage) {
    for (const bucket of allBuckets(view.usage)) {
      lines.push(bucketLine(bucket, view.now));
      lines.push('');
    }
    if (view.usage.extraUsageEnabled !== undefined) {
      lines.push(`Créditos extras: ${view.usage.extraUsageEnabled ? 'ativados' : 'desativados'}`);
      lines.push('');
    }
    const origin = view.usage.source === 'live' ? 'Uso consultado ao vivo' : 'Uso do cache do Claude Code';
    const age = view.usage.fetchedAt ? formatAge(view.usage.fetchedAt, view.now) : 'idade desconhecida';
    const stale = isStale(view.usage, view.now) ? ' $(history) dado antigo' : '';
    lines.push(`${origin}, ${age}${stale}`);
  } else {
    lines.push('Uso indisponível');
  }
  const credentialNote = credentialLabel(view);
  if (credentialNote) {
    const hint = !view.loggedIn
      ? `Abra o Claude Code nesta janela e entre com ${escapeMarkdown(view.profile.email ?? 'a conta deste perfil')}.`
      : view.credential?.kind === 'expired'
        ? 'O Claude Code renova a sessão sozinho quando você usa um chat nesta janela.'
        : view.credential?.kind === 'error'
          ? escapeMarkdown(view.credential.message)
          : 'A conta está registrada, mas o token não foi encontrado; o uso vem só do cache.';
    lines.push('');
    lines.push(`$(warning) ${credentialNote}. ${hint}`);
  }
  if (view.usageError) {
    lines.push('');
    lines.push(`Última consulta falhou: ${escapeMarkdown(view.usageError)}`);
  } else if (view.usageNote && view.usage?.source !== 'live') {
    lines.push('');
    lines.push(`Consulta ao vivo: ${escapeMarkdown(view.usageNote)}`);
  }
  if (view.pendingReload) {
    lines.push('');
    lines.push('$(debug-restart) Recarregue a janela: chats e terminais já abertos continuam na conta anterior até lá.');
  }
  lines.push('');
  lines.push('---');
  lines.push(`Diretório: \`${view.paths.configDir.replace(/`/g, "'")}\``);
  lines.push('');
  lines.push('[Trocar perfil](command:claudeAccount.switch) · [Atualizar uso](command:claudeAccount.refreshUsage) · [Menu](command:claudeAccount.menu)');
  return lines.join('\n');
}
