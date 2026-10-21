import { execFile } from 'node:child_process';
import { CREDENTIAL_MANAGER_USER, CredentialState, stateFromText } from './credentials';

export type PowerShellRunner = (script: string, env: Readonly<Record<string, string>>) => Promise<string>;

const TARGETS_ENV_VAR = 'CLAUDE_ACCOUNT_CRED_TARGETS';
const MAX_CHUNKS = 256;

export const READ_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  'Add-Type -TypeDefinition @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public static class ClaudeAccountCredRead {',
  '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
  '  public struct CREDENTIAL {',
  '    public uint Flags; public uint Type; public string TargetName; public string Comment;',
  '    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;',
  '    public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;',
  '    public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;',
  '  }',
  '  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]',
  '  private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);',
  '  [DllImport("advapi32.dll")]',
  '  private static extern void CredFree(IntPtr buffer);',
  '  public static byte[] Read(string target) {',
  '    IntPtr pointer;',
  '    if (!CredRead(target, 1, 0, out pointer)) { return null; }',
  '    try {',
  '      CREDENTIAL credential = (CREDENTIAL)Marshal.PtrToStructure(pointer, typeof(CREDENTIAL));',
  '      byte[] blob = new byte[credential.CredentialBlobSize];',
  '      if (credential.CredentialBlobSize > 0) { Marshal.Copy(credential.CredentialBlob, blob, 0, (int)credential.CredentialBlobSize); }',
  '      return blob;',
  '    } finally { CredFree(pointer); }',
  '  }',
  '}',
  '"@',
  `$targets = $env:${TARGETS_ENV_VAR} -split "\`n"`,
  'foreach ($target in $targets) {',
  '  $target = $target.Trim()',
  '  if ($target -eq "") { continue }',
  '  $blob = [ClaudeAccountCredRead]::Read($target)',
  '  if ($null -eq $blob) { Write-Output "MISSING" } else { Write-Output ("OK " + [Convert]::ToBase64String($blob)) }',
  '}',
].join('\n');

function describeExecError(error: NodeJS.ErrnoException & { signal?: string | null; killed?: boolean }, stderr: string): string {
  const parts: string[] = [];
  if (error.code !== undefined) {
    parts.push(`código ${String(error.code)}`);
  }
  if (error.signal) {
    parts.push(`sinal ${error.signal}`);
  }
  if (error.killed) {
    parts.push('tempo esgotado');
  }
  const firstLine = stderr.split(/\r?\n/).find((line) => line.trim() !== '');
  if (firstLine) {
    parts.push(firstLine.trim().slice(0, 160));
  }
  return parts.length ? parts.join(', ') : 'falha desconhecida';
}

export const runPowerShell: PowerShellRunner = (script, env) =>
  new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { env: { ...process.env, ...env }, windowsHide: true, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(describeExecError(error as NodeJS.ErrnoException, stderr)));
          return;
        }
        resolve(stdout);
      },
    );
  });

export function decodeTextBlob(bytes: Buffer): string {
  const looksUtf16 = bytes.length >= 2 && bytes[1] === 0;
  const text = looksUtf16 ? bytes.toString('utf16le') : bytes.toString('utf8');
  return text.replace(/\0+$/, '').trim();
}

export function decodeCredentialBlob(base64: string): string | undefined {
  const bytes = Buffer.from(base64.trim(), 'base64');
  if (bytes.length === 0) {
    return undefined;
  }
  for (const candidate of [bytes.toString('utf8'), bytes.toString('utf16le')]) {
    const text = candidate.replace(/\0+$/, '').trim();
    if (!text.startsWith('{')) {
      continue;
    }
    try {
      JSON.parse(text);
      return text;
    } catch {
      continue;
    }
  }
  return undefined;
}

export async function readTargets(targets: readonly string[], run: PowerShellRunner): Promise<Array<Buffer | undefined>> {
  const output = await run(READ_SCRIPT, { [TARGETS_ENV_VAR]: targets.join('\n') });
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
  return targets.map((_, index) => {
    const line = lines[index];
    if (!line || !line.startsWith('OK ')) {
      return undefined;
    }
    return Buffer.from(line.slice(3), 'base64');
  });
}

function parseManifest(text: string): { n: number; l?: number } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const n = typeof record.n === 'number' ? record.n : Number.NaN;
  if (!Number.isInteger(n) || n < 1 || n > MAX_CHUNKS) {
    return undefined;
  }
  return { n, l: typeof record.l === 'number' ? record.l : undefined };
}

export async function readCredentialManager(service: string, run: PowerShellRunner, now: number = Date.now()): Promise<CredentialState> {
  const user = CREDENTIAL_MANAGER_USER;
  const manifestTargets = [`${service}#m/${user}`, `${service}/${user}#m`];
  const mainTarget = `${service}/${user}`;
  try {
    const [serviceManifest, nameManifest, main] = await readTargets([...manifestTargets, mainTarget], run);
    const manifestBlob = serviceManifest ?? nameManifest;
    if (manifestBlob) {
      const manifest = parseManifest(decodeTextBlob(manifestBlob));
      if (!manifest) {
        return { kind: 'error', source: 'credential-manager', message: 'manifesto das credenciais em partes é inválido' };
      }
      const chunkTarget = (index: number) => (serviceManifest ? `${service}#${index}/${user}` : `${service}/${user}#${index}`);
      const chunks = await readTargets(Array.from({ length: manifest.n }, (_, index) => chunkTarget(index)), run);
      if (chunks.some((chunk) => chunk === undefined)) {
        return { kind: 'error', source: 'credential-manager', message: 'faltam partes das credenciais no Credential Manager' };
      }
      const joined = chunks.map((chunk) => decodeTextBlob(chunk as Buffer)).join('');
      if (manifest.l !== undefined && joined.length !== manifest.l) {
        return { kind: 'error', source: 'credential-manager', message: 'partes das credenciais inconsistentes' };
      }
      return stateFromText(Buffer.from(joined, 'base64').toString('utf8'), 'credential-manager', now);
    }
    if (main) {
      return stateFromText(decodeTextBlob(main), 'credential-manager', now);
    }
    return { kind: 'missing', source: 'credential-manager' };
  } catch (error) {
    return { kind: 'error', source: 'credential-manager', message: `Credential Manager: ${(error as Error).message}` };
  }
}
