export const REAL_SHAPE = {
  five_hour: { utilization: 2, resets_at: '2026-10-21T19:00:00.296449+00:00', limit_dollars: null },
  seven_day: { utilization: 1, resets_at: '2026-10-27T07:00:00.296469+00:00' },
  seven_day_opus: null,
  seven_day_sonnet: null,
  extra_usage: { is_enabled: false, currency: 'BRL' },
  limits: [
    { kind: 'session', group: 'session', percent: 2, severity: 'normal', resets_at: '2026-10-21T19:00:00.296449+00:00', scope: null, is_active: true },
    { kind: 'weekly_all', group: 'weekly', percent: 1, severity: 'normal', resets_at: '2026-10-27T07:00:00.296469+00:00', scope: null, is_active: false },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 0,
      severity: 'normal',
      resets_at: '2026-10-27T07:00:00+00:00',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
      is_active: false,
    },
  ],
  spend: { percent: 0 },
};

export const NOW_ISO = '2026-10-21T15:00:00Z';
