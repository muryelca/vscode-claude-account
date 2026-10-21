import * as os from 'node:os';
import * as path from 'node:path';

export interface Profile {
  readonly name: string;
  readonly email?: string;
  readonly configDir?: string;
}

export interface InheritedEnv {
  readonly configDir?: string;
  readonly secureStorageDir?: string;
}

export interface ProfilePaths {
  readonly configDir: string;
  readonly configFile: string;
  readonly credentialsFile: string;
  readonly isDefault: boolean;
}

export interface ActiveProfileResolution {
  readonly profile: Profile;
  readonly reason: 'stored' | 'default' | 'first';
  readonly staleStoredName?: string;
}

export function expandHome(input: string, home: string = os.homedir()): string {
  const trimmed = input.trim();
  if (trimmed === '~') {
    return home;
  }
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(home, trimmed.slice(2));
  }
  return trimmed;
}

export function defaultConfigDir(home: string = os.homedir()): string {
  return path.join(home, '.claude');
}

export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function normalizeProfiles(raw: unknown, home: string = os.homedir()): Profile[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set<string>();
  const profiles: Profile[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    const email = typeof record.email === 'string' && record.email.trim() ? record.email.trim() : undefined;
    const rawDir = typeof record.configDir === 'string' ? record.configDir.trim() : '';
    const resolvedDir = rawDir ? path.resolve(expandHome(rawDir, home)) : undefined;
    const configDir = resolvedDir && !samePath(resolvedDir, defaultConfigDir(home)) ? resolvedDir : undefined;
    profiles.push({ name, email, configDir });
  }
  return profiles;
}

export function isDefaultProfile(profile: Profile): boolean {
  return profile.configDir === undefined;
}

export function profilePaths(profile: Profile, inherited: InheritedEnv, home: string = os.homedir()): ProfilePaths {
  if (!isDefaultProfile(profile)) {
    const configDir = profile.configDir as string;
    return {
      configDir,
      configFile: path.join(configDir, '.claude.json'),
      credentialsFile: path.join(configDir, '.credentials.json'),
      isDefault: false,
    };
  }
  const configDir = inherited.configDir ? path.resolve(inherited.configDir) : defaultConfigDir(home);
  const configFile = inherited.configDir ? path.join(configDir, '.claude.json') : path.join(home, '.claude.json');
  return {
    configDir,
    configFile,
    credentialsFile: path.join(configDir, '.credentials.json'),
    isDefault: true,
  };
}

export function findProfile(profiles: readonly Profile[], name: string | undefined): Profile | undefined {
  if (!name) {
    return undefined;
  }
  return profiles.find((profile) => profile.name === name);
}

export function resolveActiveProfile(
  profiles: readonly Profile[],
  storedName: string | undefined,
  defaultName: string | undefined,
): ActiveProfileResolution | undefined {
  if (profiles.length === 0) {
    return undefined;
  }
  const stored = findProfile(profiles, storedName);
  if (stored) {
    return { profile: stored, reason: 'stored' };
  }
  const fallback = findProfile(profiles, defaultName);
  if (fallback) {
    return { profile: fallback, reason: 'default', staleStoredName: storedName };
  }
  return { profile: profiles[0], reason: 'first', staleStoredName: storedName };
}
