import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';

export interface OAuthCredentials {
  readonly accessToken: string;
  readonly expiresAt?: number;
  readonly scopes: readonly string[];
  readonly subscriptionType?: string;
  readonly rateLimitTier?: string;
}

export type CredentialSource = 'file' | 'credential-manager';

export type CredentialState =
  | { readonly kind: 'ok'; readonly credentials: OAuthCredentials; readonly source: CredentialSource }
  | { readonly kind: 'expired'; readonly credentials: OAuthCredentials; readonly source: CredentialSource }
  | { readonly kind: 'missing'; readonly source: CredentialSource }
  | { readonly kind: 'error'; readonly source: CredentialSource; readonly message: string };

export const EXPIRY_MARGIN_MS = 60_000;
export const CREDENTIAL_MANAGER_USER = 'claude-code-user';

const TRANSIENT_CODES = new Set(['EBUSY', 'EPERM', 'EAGAIN', 'EACCES']);
const READ_ATTEMPTS = 3;

export type ParsedCredentials = { readonly ok: true; readonly credentials?: OAuthCredentials } | { readonly ok: false };

export function parseCredentialsText(text: string): ParsedCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false };
  }
  const oauth = (parsed as Record<string, unknown>).claudeAiOauth;
  if (typeof oauth !== 'object' || oauth === null) {
    return { ok: true };
  }
  const record = oauth as Record<string, unknown>;
  if (typeof record.accessToken !== 'string' || record.accessToken.trim() === '') {
    return { ok: true };
  }
  return {
    ok: true,
    credentials: {
      accessToken: record.accessToken,
      expiresAt: typeof record.expiresAt === 'number' && record.expiresAt > 0 ? record.expiresAt : undefined,
      scopes: Array.isArray(record.scopes) ? record.scopes.filter((scope): scope is string => typeof scope === 'string') : [],
      subscriptionType: typeof record.subscriptionType === 'string' ? record.subscriptionType : undefined,
      rateLimitTier: typeof record.rateLimitTier === 'string' ? record.rateLimitTier : undefined,
    },
  };
}

export function parseCredentialsBlob(text: string): OAuthCredentials | undefined {
  const parsed = parseCredentialsText(text);
  return parsed.ok ? parsed.credentials : undefined;
}

export function isExpired(credentials: OAuthCredentials, now: number = Date.now(), marginMs: number = EXPIRY_MARGIN_MS): boolean {
  return credentials.expiresAt !== undefined && credentials.expiresAt <= now + marginMs;
}

export function credentialManagerService(
  configDirEnv: string | undefined,
  secureStorageEnv: string | undefined,
  fileSuffix: string = '',
): string {
  const isDefaultDir = secureStorageEnv !== undefined ? secureStorageEnv === '' : !configDirEnv;
  const dirForHash = (secureStorageEnv !== undefined ? secureStorageEnv : configDirEnv ?? '').normalize('NFC');
  const suffix = isDefaultDir ? '' : `-${createHash('sha256').update(dirForHash).digest('hex').slice(0, 8)}`;
  return `Claude Code${fileSuffix}-credentials${suffix}`;
}

export function credentialManagerTarget(service: string, entrySuffix: string = ''): string {
  return `${service}${entrySuffix}/${CREDENTIAL_MANAGER_USER}`;
}

export function stateFromText(text: string | undefined, source: CredentialSource, now: number = Date.now()): CredentialState {
  if (text === undefined) {
    return { kind: 'missing', source };
  }
  const parsed = parseCredentialsText(text);
  if (!parsed.ok) {
    return { kind: 'error', source, message: 'conteúdo das credenciais não é JSON' };
  }
  if (!parsed.credentials) {
    return { kind: 'missing', source };
  }
  if (isExpired(parsed.credentials, now)) {
    return { kind: 'expired', credentials: parsed.credentials, source };
  }
  return { kind: 'ok', credentials: parsed.credentials, source };
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function readCredentialsFile(file: string, now: number = Date.now(), sleep: (ms: number) => Promise<void> = wait): Promise<CredentialState> {
  let lastError = 'leitura falhou';
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await sleep(100 * attempt);
    }
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'desconhecido';
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        if (attempt === 0) {
          continue;
        }
        return { kind: 'missing', source: 'file' };
      }
      if (TRANSIENT_CODES.has(code)) {
        lastError = `arquivo ocupado (${code})`;
        continue;
      }
      return { kind: 'error', source: 'file', message: `falha ao ler as credenciais (${code})` };
    }
    const state = stateFromText(text, 'file', now);
    if (state.kind === 'error') {
      lastError = state.message;
      continue;
    }
    return state;
  }
  return { kind: 'error', source: 'file', message: lastError };
}
