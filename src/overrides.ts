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
      warnings.push(`${name} está definida no ambiente do VS Code e vence o login do perfil`);
    }
  }
  if (!input.inheritedDiscarded && input.env.CLAUDE_CONFIG_DIR) {
    warnings.push('CLAUDE_CONFIG_DIR já vinha definida no ambiente do VS Code; o perfil padrão usa esse diretório');
  }
  const names = settingEntryNames(input.environmentVariablesSetting);
  for (const name of [...TOKEN_VARIABLES, ...DIRECTORY_VARIABLES]) {
    if (names.includes(name)) {
      warnings.push(`claudeCode.environmentVariables define ${name}, que vale para todas as janelas e vence esta extensão`);
    }
  }
  if (typeof input.processWrapperSetting === 'string' && input.processWrapperSetting.trim() !== '') {
    warnings.push('claudeCode.claudeProcessWrapper está definido; o wrapper pode trocar o ambiente do CLI');
  }
  if (input.settingsJsonText) {
    try {
      const parsed = JSON.parse(input.settingsJsonText) as unknown;
      if (typeof parsed === 'object' && parsed !== null && typeof (parsed as Record<string, unknown>).apiKeyHelper === 'string') {
        warnings.push('apiKeyHelper em settings.json do Claude Code vence o login do perfil');
      }
    } catch {
      return warnings;
    }
  }
  return warnings;
}
