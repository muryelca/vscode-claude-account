import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectAuthOverrides } from '../overrides';

test('detectAuthOverrides is quiet on a clean machine', () => {
  assert.deepEqual(detectAuthOverrides({ env: { PATH: 'x' }, inheritedDiscarded: false, environmentVariablesSetting: [], processWrapperSetting: '', settingsJsonText: '{"model":"opus"}' }), []);
});

test('detectAuthOverrides names every mechanism that outranks the profile login', () => {
  const warnings = detectAuthOverrides({
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'x', CLAUDE_CONFIG_DIR: 'D:\\cfg' },
    inheritedDiscarded: false,
    environmentVariablesSetting: [{ name: 'claude_config_dir', value: 'C:\\x' }, { name: 'ANTHROPIC_API_KEY', value: 'k' }, 'junk'],
    processWrapperSetting: 'C:\\wrap.exe',
    settingsJsonText: '{"apiKeyHelper":"cmd"}',
  });
  assert.deepEqual(
    warnings.map((warning) => warning.split(' ')[0]),
    ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'claudeCode.environmentVariables', 'claudeCode.environmentVariables', 'claudeCode.claudeProcessWrapper', 'apiKeyHelper'],
  );
  assert.equal(detectAuthOverrides({ env: { CLAUDE_CONFIG_DIR: 'C:\\p' }, inheritedDiscarded: true, environmentVariablesSetting: undefined, processWrapperSetting: undefined, settingsJsonText: '{' }).length, 0);
});
