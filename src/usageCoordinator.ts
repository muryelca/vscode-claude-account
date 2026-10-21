import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { UsageFailureCategory } from './usage';

export interface SharedUsageState {
  readonly fetchedAtMs?: number;
  readonly raw?: unknown;
  readonly lastAttemptMs?: number;
  readonly holdUntilMs?: number;
  readonly holdReason?: string;
  readonly holdCredentialsMtimeMs?: number;
}

export interface LiveDecisionInput {
  readonly now: number;
  readonly liveEnabled: boolean;
  readonly manual: boolean;
  readonly credentialOk: boolean;
  readonly newestKnownFetchedAtMs?: number;
  readonly state?: SharedUsageState;
  readonly credentialsMtimeMs?: number;
  readonly minIntervalMs: number;
}

export interface LiveDecision {
  readonly fetch: boolean;
  readonly reason: string;
}

export const DEFAULT_LIVE_MIN_INTERVAL_MS = 5 * 60_000;
export const MANUAL_MIN_INTERVAL_MS = 60_000;
export const LOCK_STALE_MS = 30_000;
export const RATE_LIMIT_HOLD_MS = 5 * 60_000;
export const MAX_HOLD_MS = 60 * 60_000;
export const NETWORK_HOLD_MS = 2 * 60_000;
export const SERVER_HOLD_MS = 5 * 60_000;

export function profileKey(configDir: string): string {
  return createHash('sha256').update(configDir.normalize('NFC').toLowerCase()).digest('hex').slice(0, 12);
}

export function sharedStatePath(sharedDir: string, configDir: string): string {
  return path.join(sharedDir, `${profileKey(configDir)}.json`);
}

export function lockPath(sharedDir: string, configDir: string): string {
  return path.join(sharedDir, `${profileKey(configDir)}.lock`);
}

export function decideLiveFetch(input: LiveDecisionInput): LiveDecision {
  if (!input.liveEnabled) {
    return { fetch: false, reason: 'consultas ao vivo desativadas' };
  }
  if (!input.credentialOk) {
    return { fetch: false, reason: 'sem token válido' };
  }
  const state = input.state;
  if (state?.holdReason === 'unauthorized') {
    const sameCredentials =
      state.holdCredentialsMtimeMs !== undefined && input.credentialsMtimeMs !== undefined && state.holdCredentialsMtimeMs === input.credentialsMtimeMs;
    if (sameCredentials) {
      return { fetch: false, reason: 'token recusado; aguardando novo login' };
    }
  } else if (state?.holdUntilMs !== undefined && state.holdUntilMs > input.now) {
    return { fetch: false, reason: `em espera até ${new Date(state.holdUntilMs).toISOString()} (${state.holdReason ?? 'falha anterior'})` };
  }
  const lastAttempt = state?.lastAttemptMs ?? 0;
  if (input.manual) {
    if (input.now - lastAttempt < MANUAL_MIN_INTERVAL_MS) {
      return { fetch: false, reason: 'consulta manual recente' };
    }
    return { fetch: true, reason: 'pedido manual' };
  }
  if (input.newestKnownFetchedAtMs !== undefined && input.now - input.newestKnownFetchedAtMs < input.minIntervalMs) {
    return { fetch: false, reason: 'dado recente' };
  }
  if (input.now - lastAttempt < input.minIntervalMs) {
    return { fetch: false, reason: 'tentativa recente' };
  }
  return { fetch: true, reason: 'dado antigo ou inexistente' };
}

export function holdFor(
  category: UsageFailureCategory,
  retryAfterMs: number | undefined,
  now: number,
  credentialsMtimeMs: number | undefined,
): Pick<SharedUsageState, 'holdUntilMs' | 'holdReason' | 'holdCredentialsMtimeMs'> {
  switch (category) {
    case 'unauthorized':
      return { holdUntilMs: now + MAX_HOLD_MS, holdReason: 'unauthorized', holdCredentialsMtimeMs: credentialsMtimeMs };
    case 'rate-limited':
      return { holdUntilMs: now + Math.min(MAX_HOLD_MS, retryAfterMs ?? RATE_LIMIT_HOLD_MS), holdReason: 'rate-limited' };
    case 'timeout':
    case 'network':
      return { holdUntilMs: now + NETWORK_HOLD_MS, holdReason: category };
    default:
      return { holdUntilMs: now + SERVER_HOLD_MS, holdReason: category };
  }
}

export async function readSharedState(file: string): Promise<SharedUsageState | undefined> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as SharedUsageState) : undefined;
  } catch {
    return undefined;
  }
}

export async function writeSharedState(file: string, state: SharedUsageState): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  await fs.writeFile(temp, JSON.stringify(state), 'utf8');
  await fs.rename(temp, file);
}

export async function acquireLock(lock: string, now: number): Promise<boolean> {
  await fs.mkdir(path.dirname(lock), { recursive: true });
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

export async function releaseLock(lock: string): Promise<void> {
  try {
    await fs.rmdir(lock);
  } catch {
    return;
  }
}
