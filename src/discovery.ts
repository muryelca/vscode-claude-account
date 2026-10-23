import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { readClaudeConfig } from './claudeConfig';
import { defaultConfigDir, samePath } from './profiles';

export interface DiscoveredAccount {
  readonly configDir?: string;
  readonly displayDir: string;
  readonly email?: string;
  readonly organizationName?: string;
  readonly signedIn: boolean;
}

export const PROFILES_ROOT = '.claude-profiles';
const PERSONAL_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'me.com', 'yahoo.com', 'proton.me', 'protonmail.com']);

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function readAccount(configDir: string | undefined, configFile: string, displayDir: string): Promise<DiscoveredAccount> {
  const info = await readClaudeConfig(configFile);
  return {
    configDir,
    displayDir,
    email: info.account?.email,
    organizationName: info.account?.organizationName,
    signedIn: info.account?.email !== undefined,
  };
}

async function candidateDirs(home: string): Promise<string[]> {
  const found: string[] = [];
  const profilesRoot = path.join(home, PROFILES_ROOT);
  if (await isDirectory(profilesRoot)) {
    for (const name of await fs.readdir(profilesRoot)) {
      const dir = path.join(profilesRoot, name);
      if (await isDirectory(dir)) {
        found.push(dir);
      }
    }
  }
  try {
    for (const name of await fs.readdir(home)) {
      if (/^\.claude[-_.].+/i.test(name) && name !== PROFILES_ROOT && !name.endsWith('.json')) {
        const dir = path.join(home, name);
        if (await isDirectory(dir)) {
          found.push(dir);
        }
      }
    }
  } catch {
    return found;
  }
  return found;
}

export async function discoverAccounts(home: string, inheritedConfigDir?: string): Promise<DiscoveredAccount[]> {
  const accounts: DiscoveredAccount[] = [];
  const baseDir = inheritedConfigDir ? path.resolve(inheritedConfigDir) : defaultConfigDir(home);
  const baseConfigFile = inheritedConfigDir ? path.join(baseDir, '.claude.json') : path.join(home, '.claude.json');
  accounts.push(await readAccount(inheritedConfigDir ? baseDir : undefined, baseConfigFile, baseDir));
  for (const dir of await candidateDirs(home)) {
    if (samePath(dir, baseDir)) {
      continue;
    }
    const configFile = path.join(dir, '.claude.json');
    try {
      await fs.access(configFile);
    } catch {
      continue;
    }
    accounts.push(await readAccount(dir, configFile, dir));
  }
  return accounts;
}

export function isPersonalEmail(email: string | undefined): boolean {
  const domain = email?.split('@')[1]?.toLowerCase();
  return domain !== undefined && PERSONAL_DOMAINS.has(domain);
}

function capitalize(text: string): string {
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : text;
}

export function suggestProfileName(account: Pick<DiscoveredAccount, 'email' | 'organizationName'>, taken: readonly string[]): string {
  let base: string;
  if (!account.email) {
    base = 'Account';
  } else if (isPersonalEmail(account.email)) {
    base = 'Personal';
  } else if (account.organizationName && !account.organizationName.includes('@')) {
    base = account.organizationName;
  } else {
    base = capitalize(account.email.split('@')[1]?.split('.')[0] ?? 'Work');
  }
  return uniqueName(base, taken);
}

export function uniqueName(base: string, taken: readonly string[]): string {
  const lower = new Set(taken.map((name) => name.toLowerCase()));
  if (!lower.has(base.toLowerCase())) {
    return base;
  }
  for (let index = 2; ; index += 1) {
    const candidate = `${base} ${index}`;
    if (!lower.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
}

export function slugify(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'account';
}

export function newProfileDir(home: string, name: string, takenDirs: readonly string[]): string {
  const root = path.join(home, PROFILES_ROOT);
  const base = slugify(name);
  let candidate = path.join(root, base);
  for (let index = 2; takenDirs.some((dir) => samePath(dir, candidate)); index += 1) {
    candidate = path.join(root, `${base}-${index}`);
  }
  return candidate;
}

export function toConfigDirSetting(home: string, dir: string | undefined): string | undefined {
  if (!dir) {
    return undefined;
  }
  const relative = path.relative(home, dir);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
    return `~/${relative.split(path.sep).join('/')}`;
  }
  return dir;
}
