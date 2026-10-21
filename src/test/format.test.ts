import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StatusView, escapeMarkdown, formatAge, formatResetsAt, planLabel, severityFor, statusBarText, statusSeverity, tooltipMarkdown } from '../format';
import { UsageSnapshot } from '../usage';

const NOW = new Date(2026, 9, 21, 15, 0, 0);

const USAGE: UsageSnapshot = {
  session: { kind: 'session', label: 'Sessão (5h)', percent: 12.4, resetsAt: new Date(2026, 9, 21, 16, 0, 0) },
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
  assert.equal(statusBarText(view({ usage: { ...USAGE, fetchedAt: new Date(NOW.getTime() - 2 * 3_600_000) }, pendingReload: true })), '$(account) Pessoal  5h 12%  7d 34%  $(history)  $(debug-restart) recarregar');
  assert.equal(statusBarText(view({ usage: undefined, loggedIn: false, credential: { kind: 'missing', source: 'file' } })), '$(account) Pessoal  $(warning) sem login');
  assert.equal(statusBarText(view({ usage: undefined, credential: { kind: 'expired', source: 'file', credentials: { accessToken: 't', scopes: [] } } })), '$(account) Pessoal  $(warning) sessão expirada');
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

test('formatResetsAt and formatAge speak pt-BR relative to now, including past windows', () => {
  assert.equal(formatResetsAt(new Date(2026, 9, 21, 16, 0), NOW), 'renova hoje às 16:00');
  assert.equal(formatResetsAt(new Date(2026, 9, 22, 7, 30), NOW), 'renova amanhã às 07:30');
  assert.match(formatResetsAt(new Date(2026, 9, 24, 7, 0), NOW), /^renova s[aá]b\.? às 07:00$/);
  assert.equal(formatResetsAt(new Date(2026, 9, 29, 7, 0), NOW), 'renova 29/10 às 07:00');
  assert.equal(formatResetsAt(new Date(2026, 9, 21, 9, 0), NOW), 'renovou hoje às 09:00');
  assert.equal(formatResetsAt(new Date(2026, 9, 20, 9, 0), NOW), 'renovou em 20/10 às 09:00');
  assert.equal(formatAge(new Date(NOW.getTime() - 10_000), NOW), 'agora');
  assert.equal(formatAge(new Date(NOW.getTime() - 120_000), NOW), 'há 2 min');
  assert.equal(formatAge(new Date(NOW.getTime() - 3 * 3_600_000), NOW), 'há 3 h');
  assert.equal(formatAge(new Date(NOW.getTime() - 50 * 3_600_000), NOW), 'há 2 d');
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
      mismatch: 'Login neste diretório é a@b.c',
      overrideWarnings: ['CLAUDE_CODE_OAUTH_TOKEN está definida'],
    }),
  );
  assert.match(markdown, /^\*\*Pessoal\*\* · pessoal@example.com · Acme \\\[Renew\\\]\\\(command:workbench.action.terminal.sendSequence\\\) · Max 20x/);
  assert.doesNotMatch(markdown, /[^\\]\[Renew\]\(command:/);
  assert.match(markdown, /Sessão \\\(5h\\\): \*\*12%\*\* · renova hoje às 16:00/);
  assert.match(markdown, /Fable \\\(7d\\\): \*\*3%\*\*/);
  assert.match(markdown, /Créditos extras: desativados/);
  assert.match(markdown, /Uso consultado ao vivo, há 2 min/);
  assert.match(markdown, /Última consulta falhou: HTTP 500/);
  assert.match(markdown, /Recarregue a janela/);
  assert.match(markdown, /\$\(alert\) Login neste diretório é a@b.c/);
  assert.match(markdown, /\$\(alert\) CLAUDE\\_CODE\\_OAUTH\\_TOKEN está definida/);
  assert.match(markdown, /Diretório: `C:\\p`/);
  assert.match(markdown, /command:claudeAccount.switch/);

  const missing = tooltipMarkdown(view({ usage: undefined, loggedIn: false, credential: { kind: 'missing', source: 'file' } }));
  assert.match(missing, /Uso indisponível/);
  assert.match(missing, /sem login\. Abra o Claude Code nesta janela e entre com pessoal@example.com/);

  const renewed = tooltipMarkdown(view({ usage: { ...USAGE, source: 'cache', fetchedAt: undefined, session: { ...USAGE.session!, percent: 0, renewed: true, resetsAt: new Date(2026, 9, 21, 9, 0) } } }));
  assert.match(renewed, /\*\*0%\*\* · renovou hoje às 09:00 \(janela renovada, sem dado novo\)/);
  assert.match(renewed, /Uso do cache do Claude Code, idade desconhecida \$\(history\) dado antigo/);
});
