import assert from 'node:assert/strict';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { REAL_SHAPE } from './fixtures';
import { installVscodeStub } from './vscodeStub';

const root = fsSync.mkdtempSync(path.join(os.tmpdir(), 'cas-ext-'));
const home = path.join(root, 'home');
const personalDir = path.join(root, 'profiles', 'pessoal');
fsSync.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
fsSync.writeFileSync(path.join(home, '.claude', 'settings.json'), '{"model":"opus"}');
fsSync.writeFileSync(
  path.join(home, '.claude.json'),
  JSON.stringify({ hasCompletedOnboarding: true, oauthAccount: { emailAddress: 'empresa@example.com', accountUuid: 'u1' } }),
);
fsSync.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt: Date.now() + 3_600_000, scopes: [] } }));

const { events, context, config } = installVscodeStub(
  {
    'claudeAccount.profiles': [
      { name: 'Empresa', email: 'empresa@example.com' },
      { name: 'Pessoal', email: 'pessoal@example.com', configDir: personalDir },
    ],
    'claudeAccount.defaultProfile': 'Empresa',
    'claudeAccount.usage.refreshIntervalSeconds': 'abc',
  },
  path.join(root, 'global-storage'),
);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const extension = require('../extension') as typeof import('../extension');

function makeDeps(env: NodeJS.ProcessEnv) {
  let calls = 0;
  return {
    deps: {
      home,
      platform: 'win32' as NodeJS.Platform,
      env,
      fetchImpl: (async () => {
        calls += 1;
        return new Response(JSON.stringify(REAL_SHAPE), { status: 200 });
      }) as typeof fetch,
      runPowerShell: async () => 'MISSING',
      now: Date.now,
    },
    calls: () => calls,
  };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 80));

test('activation applies the stored profile to process.env before any await and mirrors it to terminals', async () => {
  context.workspaceState.store.set('claudeAccount.profileName', 'Pessoal');
  const env: NodeJS.ProcessEnv = { PATH: 'x' };
  const controller = extension.createAccountController(context as never, makeDeps(env).deps);
  try {
    assert.equal(env.CLAUDE_CONFIG_DIR, personalDir);
    assert.equal(env.CLAUDE_SECURESTORAGE_CONFIG_DIR, personalDir);
    assert.equal(context.environmentVariableCollection.values.get('CLAUDE_CONFIG_DIR'), personalDir);
    assert.equal(context.environmentVariableCollection.values.get('CLAUDE_ACCOUNT_SWITCHER'), '1');
    assert.equal(controller.currentProfileName(), 'Pessoal');
  } finally {
    controller.dispose();
    context.workspaceState.store.clear();
    context.environmentVariableCollection.values.clear();
  }
});

test('the default profile restores the inherited environment and discards values injected by a terminal of this extension', async () => {
  const env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: personalDir, CLAUDE_SECURESTORAGE_CONFIG_DIR: personalDir, CLAUDE_ACCOUNT_SWITCHER: '1' };
  const controller = extension.createAccountController(context as never, makeDeps(env).deps);
  try {
    assert.equal(controller.currentProfileName(), 'Empresa');
    assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
    assert.equal(env.CLAUDE_SECURESTORAGE_CONFIG_DIR, undefined);
    assert.equal(context.environmentVariableCollection.values.size, 0);
  } finally {
    controller.dispose();
    context.environmentVariableCollection.values.clear();
  }
});

test('switching persists the choice, prepares the profile directory and offers a reload without blocking', async () => {
  const env: NodeJS.ProcessEnv = {};
  const harness = makeDeps(env);
  const controller = extension.createAccountController(context as never, harness.deps);
  try {
    controller.start();
    await settle();
    assert.equal(harness.calls(), 1);
    events.quickPickAnswers.push((items) => items.find((item) => item.label.includes('Pessoal')));
    const switchCommand = events.commands.get('claudeAccount.switch');
    assert.ok(switchCommand);
    await switchCommand();
    await settle();
    assert.equal(controller.currentProfileName(), 'Pessoal');
    assert.equal(context.workspaceState.store.get('claudeAccount.profileName'), 'Pessoal');
    assert.equal(env.CLAUDE_CONFIG_DIR, personalDir);
    assert.equal((await fs.lstat(path.join(personalDir, 'projects'))).isSymbolicLink(), true);
    const seeded = JSON.parse(await fs.readFile(path.join(personalDir, '.claude.json'), 'utf8'));
    assert.equal(seeded.oauthAccount, undefined);
    assert.ok(events.messages.some((message) => message.includes('Profile "Pessoal" is active in this window')));
    assert.ok(events.warnings.some((message) => message.includes('is not signed in on this machine yet')));
    assert.ok(events.statusTexts.at(-1)?.includes('signed out'));
    assert.ok(events.statusTexts.at(-1)?.includes('reload'));

    events.quickPickAnswers.push((items) => items.find((item) => item.label.includes('Empresa')));
    await switchCommand();
    await settle();
    assert.equal(controller.currentProfileName(), 'Empresa');
    assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
    assert.equal(context.workspaceState.store.get('claudeAccount.profileName'), 'Empresa');
    assert.ok(events.collectionCalls.includes('delete CLAUDE_CONFIG_DIR'));
  } finally {
    controller.dispose();
    context.workspaceState.store.clear();
  }
});

test('a fresh install prompts for setup, detects the signed-in account and saves the names the user picks', async () => {
  const savedProfiles = config['claudeAccount.profiles'];
  const savedDefault = config['claudeAccount.defaultProfile'];
  config['claudeAccount.profiles'] = undefined;
  config['claudeAccount.defaultProfile'] = undefined;
  const env: NodeJS.ProcessEnv = {};
  const controller = extension.createAccountController(context as never, makeDeps(env).deps);
  try {
    assert.equal(controller.currentProfileName(), 'Default');
    assert.equal(controller.needsSetup(), true);
    controller.start();
    await settle();
    assert.ok(events.messages.some((message) => message.includes('set up your Claude accounts')));

    events.quickPickAnswers.push(
      (items) => (items as Array<{ label: string; picked?: boolean }>).filter((item) => item.picked),
      (items) => (items as Array<{ label: string; id?: string }>).find((item) => item.id === 'add'),
      (items) => (items as Array<{ label: string; id?: string }>).find((item) => item.id === 'done'),
      (items) => items.find((item) => item.label === 'Empresa'),
    );
    events.inputBoxAnswers.push('Empresa', 'Pessoal');
    events.messageAnswers.push('Later');
    await controller.runSetup();
    await settle();

    assert.match(events.inputBoxPrompts[0], /empresa@example\.com/);
    assert.deepEqual(config['claudeAccount.profiles'], [
      { name: 'Empresa', email: 'empresa@example.com' },
      { name: 'Pessoal', configDir: '~/.claude-profiles/pessoal' },
    ]);
    assert.equal(config['claudeAccount.defaultProfile'], 'Empresa');
    assert.equal(context.globalState.store.get('claudeAccount.setupDismissed'), true);
    assert.equal(controller.needsSetup(), false);
    assert.equal(controller.currentProfileName(), 'Empresa');
    assert.ok(events.messages.some((message) => message.includes('2 account(s) set up') && message.includes('"Pessoal"')));
  } finally {
    controller.dispose();
    config['claudeAccount.profiles'] = savedProfiles;
    config['claudeAccount.defaultProfile'] = savedDefault;
    context.globalState.store.clear();
  }
});

test('an invalid refresh interval falls back to the default instead of a 1 ms timer', async () => {
  const env: NodeJS.ProcessEnv = {};
  const harness = makeDeps(env);
  config['claudeAccount.usage.refreshIntervalSeconds'] = 99999999999;
  const controller = extension.createAccountController(context as never, harness.deps);
  try {
    controller.start();
    await settle();
    await settle();
    assert.ok(harness.calls() <= 2);
  } finally {
    controller.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});
