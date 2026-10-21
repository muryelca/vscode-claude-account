import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { expandHome, normalizeProfiles, profilePaths, resolveActiveProfile } from '../profiles';

const HOME = path.resolve('C:/Users/tester');

test('expandHome resolves ~ and ~/ against the home directory', () => {
  assert.equal(expandHome('~', HOME), HOME);
  assert.equal(expandHome('~/.claude-profiles/pessoal', HOME), path.join(HOME, '.claude-profiles', 'pessoal'));
  assert.equal(expandHome('C:/x', HOME), 'C:/x');
});

test('normalizeProfiles drops invalid entries, deduplicates names and treats ~/.claude as the default', () => {
  const profiles = normalizeProfiles(
    [
      { name: 'Empresa', email: 'a@b.com' },
      { name: 'Empresa', email: 'dup@b.com' },
      { name: '  ', configDir: '~/x' },
      'texto',
      { name: 'Explicit', configDir: '~/.claude' },
      { name: 'Pessoal', email: ' p@g.com ', configDir: '~/.claude-profiles/pessoal' },
    ],
    HOME,
  );
  assert.deepEqual(
    profiles.map((p) => [p.name, p.email, p.configDir]),
    [
      ['Empresa', 'a@b.com', undefined],
      ['Explicit', undefined, undefined],
      ['Pessoal', 'p@g.com', path.join(HOME, '.claude-profiles', 'pessoal')],
    ],
  );
});

test('resolveActiveProfile prefers the stored name, then the default, then the first', () => {
  const profiles = normalizeProfiles([{ name: 'A' }, { name: 'B' }], HOME);
  assert.equal(resolveActiveProfile(profiles, 'B', 'A')?.profile.name, 'B');
  const stale = resolveActiveProfile(profiles, 'Sumiu', 'B');
  assert.equal(stale?.profile.name, 'B');
  assert.equal(stale?.reason, 'default');
  assert.equal(stale?.staleStoredName, 'Sumiu');
  assert.equal(resolveActiveProfile(profiles, undefined, 'Nope')?.reason, 'first');
  assert.equal(resolveActiveProfile([], 'A', 'A'), undefined);
});

test('profilePaths puts .claude.json in the home for the default profile and inside the dir otherwise', () => {
  const byDefault = profilePaths({ name: 'Empresa' }, {}, HOME);
  assert.equal(byDefault.configDir, path.join(HOME, '.claude'));
  assert.equal(byDefault.configFile, path.join(HOME, '.claude.json'));
  assert.equal(byDefault.credentialsFile, path.join(HOME, '.claude', '.credentials.json'));
  assert.equal(byDefault.isDefault, true);

  const inherited = profilePaths({ name: 'Empresa' }, { configDir: 'D:/claude-cfg' }, HOME);
  assert.equal(inherited.configDir, path.resolve('D:/claude-cfg'));
  assert.equal(inherited.configFile, path.join(path.resolve('D:/claude-cfg'), '.claude.json'));
  assert.equal(inherited.isDefault, true);

  const custom = profilePaths({ name: 'Pessoal', configDir: path.join(HOME, 'p') }, {}, HOME);
  assert.equal(custom.configFile, path.join(HOME, 'p', '.claude.json'));
  assert.equal(custom.credentialsFile, path.join(HOME, 'p', '.credentials.json'));
  assert.equal(custom.isDefault, false);
});
