const TOKEN_VARIABLES = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];
const DIRECTORY_VARIABLES = ['CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR'];

export interface OverrideCheckInput {
  readonly env: NodeJS.ProcessEnv;
  readonly inheritedDiscarded: boolean;
  readonly environmentVariablesSetting: unknown;
  readonly processWrapperSetting: unknown;
  readonly settingsJsonText?: string;
}

function settingEntryNames(setting: unknown): string[] {
  if (!Array.isArray(setting)) {
    return [];
  }
  return setting
    .map((entry) => (typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>).name : undefined))
    .filter((name): name is string => typeof name === 'string' && name.trim() !== '')
    .map((name) => name.trim().toUpperCase());
}

export function detectAuthOverrides(input: OverrideCheckInput): string[] {
  const warnings: string[] = [];
  for (const name of TOKEN_VARIABLES) {
    if (input.env[name]) {
      warnings.push(`${name} is set in the VS Code environment and overrides the profile sign-in`);
    }
  }
  if (!input.inheritedDiscarded && input.env.CLAUDE_CONFIG_DIR) {
    warnings.push('CLAUDE_CONFIG_DIR was already set in the VS Code environment, so the default profile uses that directory');
  }
  const names = settingEntryNames(input.environmentVariablesSetting);
  for (const name of [...TOKEN_VARIABLES, ...DIRECTORY_VARIABLES]) {
    if (names.includes(name)) {
      warnings.push(`claudeCode.environmentVariables sets ${name}, which applies to every window and overrides this extension`);
    }
  }
  if (typeof input.processWrapperSetting === 'string' && input.processWrapperSetting.trim() !== '') {
    warnings.push('claudeCode.claudeProcessWrapper is set, and the wrapper may change the CLI environment');
  }
  if (input.settingsJsonText) {
    try {
      const parsed = JSON.parse(input.settingsJsonText) as unknown;
      if (typeof parsed === 'object' && parsed !== null && typeof (parsed as Record<string, unknown>).apiKeyHelper === 'string') {
        warnings.push('apiKeyHelper in the Claude Code settings.json overrides the profile sign-in');
      }
    } catch {
      return warnings;
    }
  }
  return warnings;
}
