import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONFIG_DIR_VAR, SECURE_STORAGE_DIR_VAR, SENTINEL_VAR, applyToProcessEnv, captureInheritedEnv, envVarsFor, terminalVarsFor } from '../env';

test('envVarsFor sets both variables for a custom profile on Windows and only the config dir elsewhere', () => {
  const profile = { name: 'Pessoal', configDir: 'C:\\Users\\t\\.claude-profiles\\pessoal' };
  assert.deepEqual(envVarsFor(profile, {}, 'win32'), {
    [CONFIG_DIR_VAR]: profile.configDir,
    [SECURE_STORAGE_DIR_VAR]: profile.configDir,
  });
  assert.deepEqual(envVarsFor(profile, { secureStorageDir: 'keep' }, 'linux'), {
    [CONFIG_DIR_VAR]: profile.configDir,
    [SECURE_STORAGE_DIR_VAR]: 'keep',
  });
});

test('envVarsFor restores the inherited values for the default profile', () => {
  assert.deepEqual(envVarsFor({ name: 'Empresa' }, {}, 'win32'), {
    [CONFIG_DIR_VAR]: undefined,
    [SECURE_STORAGE_DIR_VAR]: undefined,
  });
  assert.deepEqual(envVarsFor({ name: 'Empresa' }, { configDir: 'D:/cfg', secureStorageDir: '' }, 'win32'), {
    [CONFIG_DIR_VAR]: 'D:/cfg',
    [SECURE_STORAGE_DIR_VAR]: '',
  });
});

test('terminalVarsFor adds the sentinel only when something is injected', () => {
  assert.deepEqual(terminalVarsFor({ [CONFIG_DIR_VAR]: 'C:\\p', [SECURE_STORAGE_DIR_VAR]: 'C:\\p' }), {
    [CONFIG_DIR_VAR]: 'C:\\p',
    [SECURE_STORAGE_DIR_VAR]: 'C:\\p',
    [SENTINEL_VAR]: '1',
  });
  assert.deepEqual(terminalVarsFor({ [CONFIG_DIR_VAR]: undefined, [SECURE_STORAGE_DIR_VAR]: undefined }), {
    [CONFIG_DIR_VAR]: undefined,
    [SECURE_STORAGE_DIR_VAR]: undefined,
    [SENTINEL_VAR]: undefined,
  });
});

test('applyToProcessEnv sets, deletes and reports only real changes', () => {
  const env: NodeJS.ProcessEnv = { OTHER: '1', [CONFIG_DIR_VAR]: 'old' };
  const first = applyToProcessEnv({ [CONFIG_DIR_VAR]: 'new', [SECURE_STORAGE_DIR_VAR]: 'new' }, env);
  assert.deepEqual(first, [`${CONFIG_DIR_VAR}=new`, `${SECURE_STORAGE_DIR_VAR}=new`]);
  assert.deepEqual(applyToProcessEnv({ [CONFIG_DIR_VAR]: 'new' }, env), []);
  const removed = applyToProcessEnv({ [CONFIG_DIR_VAR]: undefined, [SECURE_STORAGE_DIR_VAR]: undefined }, env);
  assert.deepEqual(removed, [`${CONFIG_DIR_VAR} removed`, `${SECURE_STORAGE_DIR_VAR} removed`]);
  assert.deepEqual(env, { OTHER: '1' });
});

test('captureInheritedEnv keeps a genuine inherited dir but discards values injected by this extension', () => {
  assert.deepEqual(captureInheritedEnv({ [CONFIG_DIR_VAR]: '', [SECURE_STORAGE_DIR_VAR]: '' }, [], 'win32'), { configDir: undefined, secureStorageDir: '' });
  assert.deepEqual(captureInheritedEnv({ [CONFIG_DIR_VAR]: 'D:\\cfg' }, ['C:\\p'], 'win32'), { configDir: 'D:\\cfg', secureStorageDir: undefined });
  const fromTerminal = captureInheritedEnv({ [CONFIG_DIR_VAR]: 'C:\\p', [SENTINEL_VAR]: '1' }, [], 'win32');
  assert.equal(fromTerminal.configDir, undefined);
  assert.match(fromTerminal.discardedReason ?? '', /terminal created by this extension/);
  const knownProfile = captureInheritedEnv({ [CONFIG_DIR_VAR]: 'c:\\P' }, ['C:\\p'], 'win32');
  assert.equal(knownProfile.configDir, undefined);
  assert.match(knownProfile.discardedReason ?? '', /profile of this extension/);
});
