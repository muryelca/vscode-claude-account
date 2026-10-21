import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { samePath } from './profiles';

export interface PrepareOptions {
  readonly baseDir: string;
  readonly baseConfigFile: string;
  readonly profileDir: string;
  readonly syncFiles: readonly string[];
  readonly platform?: NodeJS.Platform;
  readonly now?: () => number;
  readonly log: (message: string) => void;
}

export interface PrepareReport {
  readonly createdDir: boolean;
  readonly junctionsCreated: readonly string[];
  readonly junctionsKept: number;
  readonly seeded: boolean;
  readonly synced: readonly string[];
  readonly warnings: readonly string[];
  readonly skipped: boolean;
}

export type SyncDirection = 'base->profile' | 'profile->base' | 'none' | 'skipped';

export const JUNCTION_EXCLUSIONS: ReadonlySet<string> = new Set(['backups']);
export const SYNC_DENYLIST: ReadonlySet<string> = new Set(['.credentials.json', '.claude.json', '.config.json', 'config.json']);
export const STRIPPED_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'oauthAccount',
  'primaryApiKey',
  'customApiKeyResponses',
  'claudeCodeFirstTokenDate',
  'penguinModeOrgEnabled',
  'claudeAiMcpEverConnected',
  'hasRemoteEnvironment',
  'additionalModelOptionsAnsweredAt',
]);

const MTIME_TOLERANCE_MS = 1000;
const FUTURE_MTIME_TOLERANCE_MS = 5 * 60_000;
const LOCK_NAME = '.claude-account-switcher.lock';
const LOCK_STALE_MS = 30_000;

export function shouldStripConfigKey(key: string): boolean {
  return STRIPPED_CONFIG_KEYS.has(key) || /cache/i.test(key);
}

export function isSyncNameAllowed(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed === '' || trimmed === '.' || trimmed === '..') {
    return false;
  }
  if (/[\\/]/.test(trimmed) || trimmed.includes('..')) {
    return false;
  }
  return !SYNC_DENYLIST.has(trimmed);
}

export function seedConfigContent(baseText: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(baseText);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const seeded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!shouldStripConfigKey(key)) {
      seeded[key] = value;
    }
  }
  return JSON.stringify(seeded, null, 2);
}

async function lstatOrNull(target: string) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function statOrNull(target: string) {
  try {
    return await fs.stat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function normalizeLinkTarget(target: string): string {
  return target.replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '');
}

function contains(parent: string, child: string, platform: NodeJS.Platform): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  const normalized = platform === 'win32' ? relative.toLowerCase() : relative;
  return normalized === '' || (!normalized.startsWith('..') && !path.isAbsolute(normalized));
}

function overlaps(a: string, b: string, platform: NodeJS.Platform): boolean {
  return contains(a, b, platform) || contains(b, a, platform);
}

async function removeLink(link: string, platform: NodeJS.Platform): Promise<void> {
  if (platform === 'win32') {
    await fs.rmdir(link);
  } else {
    await fs.unlink(link);
  }
}

function contentLooksValid(name: string, content: Buffer): boolean {
  if (content.length === 0) {
    return false;
  }
  if (!name.toLowerCase().endsWith('.json')) {
    return true;
  }
  try {
    JSON.parse(content.toString('utf8'));
    return true;
  } catch {
    return false;
  }
}

async function replaceFile(from: string, to: string, content: Buffer, sourceMtime: Date): Promise<void> {
  const existing = await statOrNull(to);
  if (existing?.isFile()) {
    await fs.copyFile(to, `${to}.bak`);
  }
  const temp = `${to}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  await fs.writeFile(temp, content);
  await fs.utimes(temp, sourceMtime, sourceMtime);
  await fs.rename(temp, to);
  void from;
}

export async function syncFileByMtime(
  baseFile: string,
  profileFile: string,
  warn: (message: string) => void = () => undefined,
  now: number = Date.now(),
): Promise<SyncDirection> {
  const [baseStat, profileStat] = await Promise.all([statOrNull(baseFile), statOrNull(profileFile)]);
  const name = path.basename(baseFile);
  if (!baseStat && !profileStat) {
    return 'none';
  }
  if (baseStat && !profileStat) {
    const content = await fs.readFile(baseFile);
    if (!contentLooksValid(name, content)) {
      warn(`${name}: cópia de origem vazia ou inválida; não copiado`);
      return 'skipped';
    }
    await replaceFile(baseFile, profileFile, content, baseStat.mtime);
    return 'base->profile';
  }
  if (!baseStat || !profileStat) {
    return 'none';
  }
  if (Math.abs(baseStat.mtimeMs - profileStat.mtimeMs) < MTIME_TOLERANCE_MS) {
    return 'none';
  }
  const [baseContent, profileContent] = await Promise.all([fs.readFile(baseFile), fs.readFile(profileFile)]);
  if (baseContent.equals(profileContent)) {
    return 'none';
  }
  const baseIsNewer = baseStat.mtimeMs > profileStat.mtimeMs;
  const source = baseIsNewer ? { file: baseFile, stat: baseStat, content: baseContent } : { file: profileFile, stat: profileStat, content: profileContent };
  const target = baseIsNewer ? { file: profileFile, stat: profileStat } : { file: baseFile, stat: baseStat };
  if (source.stat.mtimeMs > now + FUTURE_MTIME_TOLERANCE_MS) {
    warn(`${name}: a cópia mais nova tem data no futuro; não sincronizado`);
    return 'skipped';
  }
  if (!contentLooksValid(name, source.content)) {
    warn(`${name}: a cópia mais nova está vazia ou inválida; não sincronizado`);
    return 'skipped';
  }
  const targetNow = await statOrNull(target.file);
  if (!targetNow || Math.abs(targetNow.mtimeMs - target.stat.mtimeMs) >= MTIME_TOLERANCE_MS) {
    warn(`${name}: o arquivo mudou durante a sincronização; tente de novo`);
    return 'skipped';
  }
  await replaceFile(source.file, target.file, source.content, source.stat.mtime);
  return baseIsNewer ? 'base->profile' : 'profile->base';
}

interface JunctionOutcome {
  readonly created: boolean;
  readonly warning?: string;
}

async function ensureJunction(target: string, link: string, platform: NodeJS.Platform, log: (message: string) => void): Promise<JunctionOutcome> {
  const existing = await lstatOrNull(link);
  if (existing?.isSymbolicLink()) {
    const current = normalizeLinkTarget(await fs.readlink(link));
    if (samePath(current, target, platform)) {
      return { created: false };
    }
    log(`junction ${path.basename(link)} apontava para ${current}; recriando para ${target}`);
    await removeLink(link, platform);
  } else if (existing?.isDirectory()) {
    const entries = await fs.readdir(link);
    if (entries.length > 0) {
      return { created: false, warning: `${path.basename(link)}: é uma pasta real com conteúdo no perfil; não foi substituída por junction` };
    }
    await fs.rmdir(link);
  } else if (existing) {
    return { created: false, warning: `${path.basename(link)}: existe um arquivo com esse nome no perfil` };
  }
  await fs.symlink(target, link, 'junction');
  return { created: true };
}

async function acquirePrepareLock(profileDir: string, now: number): Promise<boolean> {
  const lock = path.join(profileDir, LOCK_NAME);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fs.mkdir(lock);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        return false;
      }
      try {
        const stat = await fs.stat(lock);
        if (now - stat.mtimeMs < LOCK_STALE_MS) {
          return false;
        }
        await fs.rmdir(lock);
      } catch {
        return false;
      }
    }
  }
  return false;
}

async function releasePrepareLock(profileDir: string): Promise<void> {
  try {
    await fs.rmdir(path.join(profileDir, LOCK_NAME));
  } catch {
    return;
  }
}

export async function prepareProfileDir(options: PrepareOptions): Promise<PrepareReport> {
  const platform = options.platform ?? process.platform;
  const now = options.now ?? Date.now;
  const warnings: string[] = [];
  const junctionsCreated: string[] = [];
  const synced: string[] = [];
  let junctionsKept = 0;
  let seeded = false;

  if (overlaps(options.baseDir, options.profileDir, platform)) {
    warnings.push(`o diretório do perfil (${options.profileDir}) coincide ou está dentro de ${options.baseDir}; nada foi feito`);
    return { createdDir: false, junctionsCreated, junctionsKept, seeded, synced, warnings, skipped: true };
  }

  const existedBefore = (await statOrNull(options.profileDir)) !== null;
  await fs.mkdir(options.profileDir, { recursive: true });
  if (!(await acquirePrepareLock(options.profileDir, now()))) {
    warnings.push('outra janela está preparando este perfil agora; tente de novo em instantes');
    return { createdDir: !existedBefore, junctionsCreated, junctionsKept, seeded, synced, warnings, skipped: true };
  }
  options.log(`${existedBefore ? 'verificando' : 'criando'} diretório do perfil ${options.profileDir}`);

  try {
    const baseStat = await statOrNull(options.baseDir);
    if (!baseStat?.isDirectory()) {
      warnings.push(`diretório base ${options.baseDir} não existe; nada para compartilhar`);
      return { createdDir: !existedBefore, junctionsCreated, junctionsKept, seeded, synced, warnings, skipped: false };
    }

    for (const name of await fs.readdir(options.baseDir)) {
      if (JUNCTION_EXCLUSIONS.has(name)) {
        continue;
      }
      const source = path.join(options.baseDir, name);
      const sourceStat = await lstatOrNull(source);
      if (!sourceStat) {
        continue;
      }
      let target = source;
      if (sourceStat.isSymbolicLink()) {
        try {
          target = await fs.realpath(source);
        } catch {
          continue;
        }
        if (!(await statOrNull(target))?.isDirectory()) {
          continue;
        }
      } else if (!sourceStat.isDirectory()) {
        continue;
      }
      if (overlaps(target, options.profileDir, platform)) {
        warnings.push(`${name}: o alvo (${target}) contém ou está dentro do perfil; ignorado`);
        continue;
      }
      try {
        const outcome = await ensureJunction(target, path.join(options.profileDir, name), platform, options.log);
        if (outcome.created) {
          junctionsCreated.push(name);
        } else if (outcome.warning) {
          warnings.push(outcome.warning);
        } else {
          junctionsKept += 1;
        }
      } catch (error) {
        warnings.push(`${name}: falha ao criar junction: ${(error as Error).message}`);
      }
    }

    const profileConfig = path.join(options.profileDir, '.claude.json');
    if (!(await statOrNull(profileConfig))) {
      const baseConfigStat = await statOrNull(options.baseConfigFile);
      if (baseConfigStat?.isFile()) {
        const content = seedConfigContent(await fs.readFile(options.baseConfigFile, 'utf8'));
        if (content) {
          await fs.writeFile(profileConfig, content, 'utf8');
          seeded = true;
          options.log(`semeado ${profileConfig} a partir de ${options.baseConfigFile} sem a conta, as chaves de API e os caches`);
        } else {
          warnings.push(`${options.baseConfigFile} não pôde ser lido como JSON; perfil começa sem .claude.json`);
        }
      }
    }

    for (const name of options.syncFiles) {
      if (!isSyncNameAllowed(name)) {
        warnings.push(`${name}: nome não permitido na sincronização; ignorado`);
        continue;
      }
      try {
        const direction = await syncFileByMtime(path.join(options.baseDir, name), path.join(options.profileDir, name), (message) => warnings.push(message), now());
        if (direction !== 'none' && direction !== 'skipped') {
          synced.push(`${name} (${direction})`);
        }
      } catch (error) {
        warnings.push(`${name}: falha ao sincronizar: ${(error as Error).message}`);
      }
    }
  } finally {
    await releasePrepareLock(options.profileDir);
  }

  options.log(
    `perfil pronto: ${junctionsCreated.length} junction(s) nova(s), ${junctionsKept} mantida(s), ${synced.length} arquivo(s) sincronizado(s), ${warnings.length} aviso(s)`,
  );
  return { createdDir: !existedBefore, junctionsCreated, junctionsKept, seeded, synced, warnings, skipped: false };
}
