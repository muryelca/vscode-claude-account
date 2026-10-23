import * as fs from 'node:fs/promises';
import { AccountInfo, readClaudeConfig } from './claudeConfig';
import { CredentialState, credentialManagerService, readCredentialsFile } from './credentials';
import { PowerShellRunner, readCredentialManager } from './credman';
import { CONFIG_DIR_VAR, EnvVars, SECURE_STORAGE_DIR_VAR } from './env';
import { Profile, ProfilePaths } from './profiles';
import { UsageSnapshot, fetchUsage, markRenewed, parseUsage, usageFailureLabel } from './usage';
import { acquireLock, decideLiveFetch, holdFor, lockPath, readSharedState, releaseLock, sharedStatePath, writeSharedState } from './usageCoordinator';

export interface MonitorDeps {
  readonly platform: NodeJS.Platform;
  readonly fetchImpl: typeof fetch;
  readonly runPowerShell: PowerShellRunner;
  readonly log: (message: string) => void;
  readonly now: () => Date;
  readonly sharedDir: string;
  readonly liveQueries: boolean;
  readonly liveMinIntervalMs: number;
  readonly forceCredentialManager?: boolean;
}

export interface AccountSnapshot {
  readonly account?: AccountInfo;
  readonly credential: CredentialState;
  readonly loggedIn: boolean;
  readonly usage?: UsageSnapshot;
  readonly usageError?: string;
  readonly usageNote?: string;
  readonly mismatch?: string;
  readonly refreshedAt: Date;
}

export function emailMismatch(profile: Profile, account: AccountInfo | undefined): string | undefined {
  if (!profile.email || !account?.email) {
    return undefined;
  }
  if (profile.email.toLowerCase() === account.email.toLowerCase()) {
    return undefined;
  }
  return `Signed in here as ${account.email}, but profile "${profile.name}" expects ${profile.email}`;
}

function newest(...candidates: Array<UsageSnapshot | undefined>): UsageSnapshot | undefined {
  let best: UsageSnapshot | undefined;
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const time = candidate.fetchedAt?.getTime() ?? 0;
    if (!best || time > (best.fetchedAt?.getTime() ?? 0)) {
      best = candidate;
    }
  }
  return best;
}

async function mtimeOrUndefined(file: string): Promise<number | undefined> {
  try {
    return (await fs.stat(file)).mtimeMs;
  } catch {
    return undefined;
  }
}

async function readCredentials(paths: ProfilePaths, envVars: EnvVars, useCredentialManager: boolean, deps: MonitorDeps, nowMs: number): Promise<CredentialState> {
  if (useCredentialManager) {
    const service = credentialManagerService(envVars[CONFIG_DIR_VAR], envVars[SECURE_STORAGE_DIR_VAR]);
    deps.log(`reading credentials from Credential Manager (${service})`);
    const fromManager = await readCredentialManager(service, deps.runPowerShell, nowMs);
    if (fromManager.kind !== 'missing') {
      return fromManager;
    }
    deps.log('no Credential Manager entry, trying the credentials file');
  }
  return readCredentialsFile(paths.credentialsFile, nowMs);
}

export async function readAccountSnapshot(
  profile: Profile,
  paths: ProfilePaths,
  envVars: EnvVars,
  deps: MonitorDeps,
  manual: boolean = false,
): Promise<AccountSnapshot> {
  const now = deps.now();
  const nowMs = now.getTime();
  const config = await readClaudeConfig(paths.configFile);
  if (config.error) {
    deps.log(`warning while reading ${paths.configFile}: ${config.error}`);
  }
  const useCredentialManager = deps.platform === 'win32' && (config.usesCredentialManager || deps.forceCredentialManager === true);
  const credential = await readCredentials(paths, envVars, useCredentialManager, deps, nowMs);
  deps.log(`credentials via ${credential.source}: ${credential.kind}${credential.kind === 'error' ? ` (${credential.message})` : ''}`);
  const loggedIn = credential.kind === 'ok' || credential.kind === 'expired' || config.account !== undefined;

  const stateFile = sharedStatePath(deps.sharedDir, paths.configDir);
  const shared = await readSharedState(stateFile);
  const sharedUsage = shared?.raw !== undefined ? parseUsage(shared.raw, shared.fetchedAtMs ? new Date(shared.fetchedAtMs) : undefined, 'live') : undefined;
  let usage = newest(config.cachedUsage, sharedUsage);
  let usageError: string | undefined;
  let usageNote: string | undefined;

  const credentialsMtimeMs = await mtimeOrUndefined(paths.credentialsFile);
  const decision = decideLiveFetch({
    now: nowMs,
    liveEnabled: deps.liveQueries,
    manual,
    credentialOk: credential.kind === 'ok',
    newestKnownFetchedAtMs: usage?.fetchedAt?.getTime(),
    state: shared,
    credentialsMtimeMs,
    minIntervalMs: deps.liveMinIntervalMs,
  });
  if (!decision.fetch) {
    usageNote = decision.reason;
    deps.log(`no live request: ${decision.reason}`);
  } else if (credential.kind === 'ok') {
    const lock = lockPath(deps.sharedDir, paths.configDir);
    if (!(await acquireLock(lock, nowMs))) {
      usageNote = 'another window is fetching usage';
      deps.log(usageNote);
    } else {
      try {
        deps.log(`fetching live usage (${decision.reason})`);
        const result = await fetchUsage(credential.credentials.accessToken, deps.fetchImpl);
        if (result.ok) {
          const live = parseUsage(result.raw, now, 'live');
          if (live) {
            usage = live;
            await writeSharedState(stateFile, { fetchedAtMs: nowMs, raw: result.raw, lastAttemptMs: nowMs });
            deps.log(`live usage: session ${live.session?.percent ?? '?'}%, week ${live.weekly?.percent ?? '?'}%`);
          } else {
            usageError = usageFailureLabel('bad-response');
            await writeSharedState(stateFile, { ...shared, lastAttemptMs: nowMs, ...holdFor('bad-response', undefined, nowMs, credentialsMtimeMs) });
            deps.log(usageError);
          }
        } else {
          usageError = usageFailureLabel(result.category, result.status);
          await writeSharedState(stateFile, { ...shared, lastAttemptMs: nowMs, ...holdFor(result.category, result.retryAfterMs, nowMs, credentialsMtimeMs) });
          deps.log(`usage request failed: ${usageError}`);
        }
      } catch (error) {
        usageError = `unexpected error while fetching usage (${(error as Error).name})`;
        deps.log(usageError);
      } finally {
        await releaseLock(lock);
      }
    }
  }

  if (!loggedIn) {
    usage = undefined;
  } else if (usage) {
    usage = markRenewed(usage, now);
  }
  return {
    account: config.account,
    credential,
    loggedIn,
    usage,
    usageError,
    usageNote,
    mismatch: emailMismatch(profile, config.account),
    refreshedAt: now,
  };
}
