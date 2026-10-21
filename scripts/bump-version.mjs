#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(__dirname, '..', 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const currentVersion = pkg.version;

function git(args) {
  return execSync(`git ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function isGitRepo() {
  try {
    git('rev-parse --is-inside-work-tree');
    return true;
  } catch {
    return false;
  }
}

if (!isGitRepo()) {
  console.log('[bump] Not a git repository. Skipping auto-bump.');
  process.exit(0);
}

let lastBumpCommit = '';
try {
  lastBumpCommit = git(`log -1 --format=%H -S "\\"version\\": \\"${currentVersion}\\"" -- package.json`);
} catch {}

if (!lastBumpCommit) {
  console.log(`[bump] No prior commit found that introduced version ${currentVersion}. Skipping bump (commit it first, then bump on next package).`);
  process.exit(0);
}

const range = `${lastBumpCommit}..HEAD`;
let log = '';
try {
  log = git(`log --format=%B%x1e ${range}`);
} catch {
  log = '';
}

const commits = log.split('\x1e').map((s) => s.trim()).filter(Boolean);

if (commits.length === 0) {
  console.log(`[bump] No commits since v${currentVersion}. Skipping.`);
  process.exit(0);
}

const breakingRe = /^[a-z]+(\([^)]+\))?!:/;
let bumpType = 'minor';
const reasons = [];

for (const c of commits) {
  const subject = c.split('\n')[0];
  if (breakingRe.test(subject)) {
    bumpType = 'major';
    reasons.push(`breaking marker in "${subject}"`);
    break;
  }
  if (/^BREAKING CHANGE:/m.test(c)) {
    bumpType = 'major';
    reasons.push(`BREAKING CHANGE footer in "${subject}"`);
    break;
  }
}

const parts = currentVersion.split('.').map(Number);
if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
  console.error(`[bump] Unexpected version format: ${currentVersion}`);
  process.exit(1);
}
const [maj, min] = parts;
const newVersion = bumpType === 'major' ? `${maj + 1}.0.0` : `${maj}.${min + 1}.0`;

pkg.version = newVersion;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

console.log(`[bump] ${commits.length} commit(s) since v${currentVersion}.`);
console.log(`[bump] Bump type: ${bumpType.toUpperCase()}${reasons.length ? ` (${reasons.join('; ')})` : ''}`);
console.log(`[bump] ${currentVersion} -> ${newVersion}`);
console.log(`[bump] package.json updated. Remember to commit it.`);
