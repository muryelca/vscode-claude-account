import * as fs from 'node:fs/promises';
import { UsageSnapshot, cachedUsageFromConfig } from './usage';

export interface AccountInfo {
  readonly email?: string;
  readonly organizationName?: string;
  readonly accountUuid?: string;
  readonly rateLimitTier?: string;
}

export interface ClaudeConfigInfo {
  readonly exists: boolean;
  readonly account?: AccountInfo;
  readonly usesCredentialManager: boolean;
  readonly cachedUsage?: UsageSnapshot;
  readonly error?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function parseClaudeConfig(text: string): ClaudeConfigInfo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { exists: true, usesCredentialManager: false, error: `invalid JSON: ${(error as Error).message}` };
  }
  const root = asRecord(parsed);
  if (!root) {
    return { exists: true, usesCredentialManager: false, error: 'content is not an object' };
  }
  const oauth = asRecord(root.oauthAccount);
  const account: AccountInfo | undefined = oauth
    ? {
        email: asString(oauth.emailAddress),
        organizationName: asString(oauth.organizationName),
        accountUuid: asString(oauth.accountUuid),
        rateLimitTier: asString(oauth.userRateLimitTier) ?? asString(oauth.organizationRateLimitTier),
      }
    : undefined;
  const features = asRecord(root.cachedGrowthBookFeatures);
  const cachedRecord = asRecord(root.cachedUsageUtilization);
  const cacheOwner = cachedRecord ? asString(cachedRecord.accountUuid) : undefined;
  const cacheBelongsToAnotherAccount = Boolean(cacheOwner && account?.accountUuid && cacheOwner !== account.accountUuid);
  return {
    exists: true,
    account,
    usesCredentialManager: features?.tengu_windows_credman === true,
    cachedUsage: cacheBelongsToAnotherAccount ? undefined : cachedUsageFromConfig(root),
  };
}

export async function readClaudeConfig(file: string): Promise<ClaudeConfigInfo> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { exists: false, usesCredentialManager: false };
    }
    return { exists: false, usesCredentialManager: false, error: `${file}: ${(error as Error).message}` };
  }
  return parseClaudeConfig(text);
}
