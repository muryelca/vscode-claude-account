import { InheritedEnv, Profile, isDefaultProfile, samePath } from './profiles';

export const CONFIG_DIR_VAR = 'CLAUDE_CONFIG_DIR';
export const SECURE_STORAGE_DIR_VAR = 'CLAUDE_SECURESTORAGE_CONFIG_DIR';
export const SENTINEL_VAR = 'CLAUDE_ACCOUNT_SWITCHER';

export type EnvVars = Readonly<Record<string, string | undefined>>;

export interface InheritedEnvCapture extends InheritedEnv {
  readonly discardedReason?: string;
}

export function captureInheritedEnv(
  env: NodeJS.ProcessEnv = process.env,
  knownProfileDirs: readonly string[] = [],
  platform: NodeJS.Platform = process.platform,
): InheritedEnvCapture {
  const configDir = env[CONFIG_DIR_VAR] || undefined;
  const secureStorageDir = env[SECURE_STORAGE_DIR_VAR];
  if (env[SENTINEL_VAR]) {
    return { discardedReason: 'environment inherited from a terminal created by this extension' };
  }
  if (configDir && knownProfileDirs.some((dir) => samePath(dir, configDir, platform))) {
    return { discardedReason: `inherited CLAUDE_CONFIG_DIR points to a profile of this extension (${configDir})` };
  }
  return { configDir, secureStorageDir };
}

export function envVarsFor(
  profile: Profile,
  inherited: InheritedEnv,
  platform: NodeJS.Platform = process.platform,
): EnvVars {
  if (isDefaultProfile(profile)) {
    return {
      [CONFIG_DIR_VAR]: inherited.configDir,
      [SECURE_STORAGE_DIR_VAR]: inherited.secureStorageDir,
    };
  }
  const configDir = profile.configDir as string;
  return {
    [CONFIG_DIR_VAR]: configDir,
    [SECURE_STORAGE_DIR_VAR]: platform === 'win32' ? configDir : inherited.secureStorageDir,
  };
}

export function terminalVarsFor(vars: EnvVars): EnvVars {
  const injects = Object.values(vars).some((value) => value !== undefined);
  return { ...vars, [SENTINEL_VAR]: injects ? '1' : undefined };
}

export function applyToProcessEnv(vars: EnvVars, env: NodeJS.ProcessEnv = process.env): string[] {
  const changes: string[] = [];
  for (const [name, value] of Object.entries(vars)) {
    if (value === undefined) {
      if (env[name] !== undefined) {
        delete env[name];
        changes.push(`${name} removed`);
      }
      continue;
    }
    if (env[name] !== value) {
      env[name] = value;
      changes.push(`${name}=${value}`);
    }
  }
  return changes;
}
