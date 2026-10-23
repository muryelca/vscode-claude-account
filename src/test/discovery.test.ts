import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { discoverAccounts, isPersonalEmail, newProfileDir, slugify, suggestProfileName, toConfigDirSetting, uniqueName } from '../discovery';

test('discoverAccounts finds the default account and every signed-in profile directory', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cas-disc-'));
  try {
    await fs.mkdir(path.join(home, '.claude'), { recursive: true });
    await fs.writeFile(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'work@company.com', organizationName: 'Company' } }));
    await fs.mkdir(path.join(home, '.claude-profiles', 'personal'), { recursive: true });
    await fs.writeFile(path.join(home, '.claude-profiles', 'personal', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'me@gmail.com' } }));
    await fs.mkdir(path.join(home, '.claude-profiles', 'empty'), { recursive: true });
    await fs.mkdir(path.join(home, '.claude-client'), { recursive: true });
    await fs.writeFile(path.join(home, '.claude-client', '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }));

    const accounts = await discoverAccounts(home);
    assert.deepEqual(
      accounts.map((account) => [account.configDir ? path.relative(home, account.configDir) : '(default)', account.email ?? null, account.signedIn]),
      [
        ['(default)', 'work@company.com', true],
        [path.join('.claude-profiles', 'personal'), 'me@gmail.com', true],
        ['.claude-client', null, false],
      ],
    );
    assert.equal(accounts[0].organizationName, 'Company');
    assert.equal(accounts[0].displayDir, path.join(home, '.claude'));
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('discoverAccounts reports a fresh machine as one default directory that is not signed in', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cas-disc-'));
  try {
    const accounts = await discoverAccounts(home);
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].signedIn, false);
    assert.equal(accounts[0].configDir, undefined);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('suggestProfileName prefers Personal for consumer mail, the organization for work mail, and stays unique', () => {
  assert.equal(isPersonalEmail('me@gmail.com'), true);
  assert.equal(isPersonalEmail('me@company.com'), false);
  assert.equal(suggestProfileName({ email: 'me@gmail.com' }, []), 'Personal');
  assert.equal(suggestProfileName({ email: 'me@gmail.com' }, ['Personal']), 'Personal 2');
  assert.equal(suggestProfileName({ email: 'me@company.com', organizationName: 'Company Inc' }, []), 'Company Inc');
  assert.equal(suggestProfileName({ email: 'me@company.com', organizationName: "me@company.com's Organization" }, []), 'Company');
  assert.equal(suggestProfileName({}, []), 'Account');
  assert.equal(uniqueName('Work', ['work', 'Work 2']), 'Work 3');
});

test('slugify and newProfileDir build safe, unique directories under ~/.claude-profiles', () => {
  const home = path.resolve('/home/tester');
  assert.equal(slugify('Cliente São Paulo!'), 'cliente-sao-paulo');
  assert.equal(slugify('***'), 'account');
  assert.equal(newProfileDir(home, 'Personal', []), path.join(home, '.claude-profiles', 'personal'));
  assert.equal(newProfileDir(home, 'Personal', [path.join(home, '.claude-profiles', 'personal')]), path.join(home, '.claude-profiles', 'personal-2'));
  assert.equal(toConfigDirSetting(home, path.join(home, '.claude-profiles', 'personal')), '~/.claude-profiles/personal');
  assert.equal(toConfigDirSetting(home, undefined), undefined);
  assert.equal(toConfigDirSetting(home, path.resolve('/other/dir')), path.resolve('/other/dir'));
});
