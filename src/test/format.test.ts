import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StatusView, escapeMarkdown, formatAge, formatResetsAt, planLabel, severityFor, statusBarText, statusSeverity, tooltipMarkdown } from '../format';
import { UsageSnapshot } from '../usage';

const NOW = new Date(2026, 9, 21, 15, 0, 0);

const USAGE: UsageSnapshot = {
  session: { kind: 'session', label: 'Session (5h)', percent: 12.4, resetsAt: new Date(2026, 9, 21, 16, 0, 0) },
  weekly: { kind: 'weekly', label: 'Semana (7d)', percent: 34, resetsAt: new Date(2026, 9, 27, 7, 0, 0) },
  scoped: [{ kind: 'scoped', label: 'Fable (7d)', percent: 3 }],
  extraUsageEnabled: false,
  fetchedAt: new Date(NOW.getTime() - 90_000),
  source: 'live',
};

function view(overrides: Partial<StatusView> = {}): StatusView {
  return {
    profile: { name: 'Pessoal', email: 'pessoal@example.com', configDir: 'C:\\p' },
    paths: { configDir: 'C:\\p', configFile: 'C:\\p\\.claude.json', credentialsFile: 'C:\\p\\.credentials.json', isDefault: false },
    credential: { kind: 'ok', source: 'file', credentials: { accessToken: 't', scopes: [], subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' } },
    loggedIn: true,
    usage: USAGE,
    overrideWarnings: [],
    pendingReload: false,
    loading: false,
    warnAtPercent: 80,
    now: NOW,
    ...overrides,
  };
}

test('statusBarText shows the profile with the session and weekly percentages', () => {
  assert.equal(statusBarText(view()), '$(account) Pessoal  5h 12%  7d 34%');
  assert.equal(statusBarText(view({ loading: true, usage: undefined })), '$(account) Pessoal $(loading~spin)');
  assert.equal(statusBarText(view({ usage: { ...USAGE, fetchedAt: new Date(NOW.getTime() - 2 * 3_600_000) }, pendingReload: true })), '$(account) Pessoal  5h 12%  7d 34%  $(history)  $(debug-restart) reload');
  assert.equal(statusBarText(view({ usage: undefined, loggedIn: false, credential: { kind: 'missing', source: 'file' } })), '$(account) Pessoal  $(warning) signed out');
  assert.equal(statusBarText(view({ usage: undefined, credential: { kind: 'expired', source: 'file', credentials: { accessToken: 't', scopes: [] } } })), '$(account) Pessoal  $(warning) session expired');
  assert.equal(statusBarText(view({ credential: { kind: 'expired', source: 'file', credentials: { accessToken: 't', scopes: [] } } })), '$(account) Pessoal  5h 12%  7d 34%');
  assert.equal(statusBarText(view({ credential: { kind: 'missing', source: 'file' } })), '$(account) Pessoal  5h 12%  7d 34%');
  assert.equal(statusBarText(view({ mismatch: 'x' })), '$(account) Pessoal  5h 12%  7d 34%  $(alert)');
  assert.equal(statusBarText(view({ usage: { ...USAGE, scoped: [{ kind: 'scoped', label: 'Opus (7d)', percent: 99.6 }] } })), '$(account) Pessoal  5h 12%  7d 34%  Opus 100%');
});

test('severity follows the highest rounded bucket and the warning threshold', () => {
  assert.equal(severityFor(undefined, 80), 'normal');
  assert.equal(severityFor(79.4, 80), 'normal');
  assert.equal(severityFor(79.6, 80), 'warning');
  assert.equal(severityFor(99.5, 80), 'error');
  assert.equal(statusSeverity(view()), 'normal');
  assert.equal(statusSeverity(view({ usage: { ...USAGE, scoped: [{ kind: 'scoped', label: 'x', percent: 95 }] } })), 'warning');
  assert.equal(statusSeverity(view({ mismatch: 'x' })), 'warning');
  assert.equal(statusSeverity(view({ overrideWarnings: ['x'] })), 'warning');
  assert.equal(statusSeverity(view({ credential: { kind: 'error', source: 'file', message: 'boom' } })), 'warning');
});

test('formatResetsAt and formatAge speak plain English relative to now, including past windows', () => {
  assert.equal(formatResetsAt(new Date(2026, 9, 21, 16, 0), NOW), 'resets today at 4:00 PM');
  assert.equal(formatResetsAt(new Date(2026, 9, 22, 7, 30), NOW), 'resets tomorrow at 7:30 AM');
  assert.match(formatResetsAt(new Date(2026, 9, 24, 7, 0), NOW), /^resets Sat at 7:00 AM$/);
  assert.equal(formatResetsAt(new Date(2026, 9, 29, 7, 0), NOW), 'resets Oct 29 at 7:00 AM');
  assert.equal(formatResetsAt(new Date(2026, 9, 21, 9, 0), NOW), 'reset today at 9:00 AM');
  assert.equal(formatResetsAt(new Date(2026, 9, 20, 9, 0), NOW), 'reset on Oct 20 at 9:00 AM');
  assert.equal(formatAge(new Date(NOW.getTime() - 10_000), NOW), 'just now');
  assert.equal(formatAge(new Date(NOW.getTime() - 120_000), NOW), '2 min ago');
  assert.equal(formatAge(new Date(NOW.getTime() - 3 * 3_600_000), NOW), '3 h ago');
  assert.equal(formatAge(new Date(NOW.getTime() - 50 * 3_600_000), NOW), '2 d ago');
});

test('planLabel derives the plan from the subscription or the tier and hides unknown ids', () => {
  assert.equal(planLabel('max', 'default_claude_max_20x'), 'Max 20x');
  assert.equal(planLabel(undefined, 'default_claude_max_5x'), 'Max 5x');
  assert.equal(planLabel('pro', undefined), 'Pro');
  assert.equal(planLabel(undefined, 'weird_tier_7'), undefined);
  assert.equal(planLabel('unknown', undefined), undefined);
});

test('escapeMarkdown neutralizes links, code and emphasis', () => {
  assert.equal(escapeMarkdown('Acme [Renew](command:x)'), 'Acme \\[Renew\\]\\(command:x\\)');
  assert.equal(escapeMarkdown('a_b*c`d\nnext'), 'a\\_b\\*c\\`d next');
});

test('tooltipMarkdown lists the buckets, escapes external text and names the origin of the data', () => {
  const markdown = tooltipMarkdown(
    view({
      account: { email: 'pessoal@example.com', organizationName: 'Acme [Renew](command:workbench.action.terminal.sendSequence)' },
      usageError: 'HTTP 500',
      pendingReload: true,
      mismatch: 'Signed in here as a@b.c',
      overrideWarnings: ['CLAUDE_CODE_OAUTH_TOKEN is set'],
    }),
  );
  assert.match(markdown, /^\*\*Pessoal\*\* · pessoal@example.com · Acme \\\[Renew\\\]\\\(command:workbench.action.terminal.sendSequence\\\) · Max 20x/);
  assert.doesNotMatch(markdown, /[^\\]\[Renew\]\(command:/);
  assert.match(markdown, /Session \\\(5h\\\): \*\*12%\*\* · resets today at 4:00 PM/);
  assert.match(markdown, /Fable \\\(7d\\\): \*\*3%\*\*/);
  assert.match(markdown, /Extra usage: off/);
  assert.match(markdown, /Live usage, 2 min ago/);
  assert.match(markdown, /Last request failed: HTTP 500/);
  assert.match(markdown, /Reload the window/);
  assert.match(markdown, /\$\(alert\) Signed in here as a@b.c/);
  assert.match(markdown, /\$\(alert\) CLAUDE\\_CODE\\_OAUTH\\_TOKEN is set/);
  assert.match(markdown, /Directory: `C:\\p`/);
  assert.match(markdown, /command:claudeAccount.switch/);

  const missing = tooltipMarkdown(view({ usage: undefined, loggedIn: false, credential: { kind: 'missing', source: 'file' } }));
  assert.match(missing, /Usage unavailable/);
  assert.match(missing, /Signed out\. Open Claude Code in this window and sign in with pessoal@example.com/);

  const renewed = tooltipMarkdown(view({ usage: { ...USAGE, source: 'cache', fetchedAt: undefined, session: { ...USAGE.session!, percent: 0, renewed: true, resetsAt: new Date(2026, 9, 21, 9, 0) } } }));
  assert.match(renewed, /\*\*0%\*\* · reset today at 9:00 AM \(window reset, no new data yet\)/);
  assert.match(renewed, /Usage from the Claude Code cache, age unknown \$\(history\) stale/);
});
