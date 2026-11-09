import { readFile, writeFile, rename, mkdir } from 'fs/promises';
import { dirname, join } from 'path';
import { compareVersions, parseVersion } from './semver.ts';
import type { Item, Lock, LockV2, Vault } from './types.ts';

export const LOCK_FILE = 'template.lock.json';
export const LOCK_V1_BACKUP = 'template.lock.v1.json';

export function lockPath(vault: Vault): string {
  return join(vault.root, '.obsidian', LOCK_FILE);
}

export function itemKey(item: Pick<Item, 'kind' | 'id'>): string {
  return `${item.kind}:${item.id}`;
}

export function emptyLock(): Lock {
  return { lockVersion: 1, items: {} };
}

// Any lock version, or null when the vault has no lock.
export async function readLockFile(vault: Vault): Promise<Lock | LockV2 | null> {
  let raw: string;
  try {
    raw = await readFile(lockPath(vault), 'utf8');
  } catch {
    return null;
  }
  const parsed = JSON.parse(raw) as Lock | LockV2;
  if (parsed.lockVersion !== 1 && parsed.lockVersion !== 2) {
    throw new Error(`${lockPath(vault)}: unsupported lockVersion ${String((parsed as { lockVersion: unknown }).lockVersion)}`);
  }
  return parsed;
}

// v1 lock for the draft sync. A v2 lock belongs to vault-update and is refused.
export async function loadLock(vault: Vault): Promise<Lock | null> {
  const lock = await readLockFile(vault);
  if (lock?.lockVersion === 2) {
    throw new Error(
      `${vault.name} is managed by vault-update (lock v2 at ${lock.version}). The draft sync refuses to touch it; use the obsidian-template-vault-update skill.`
    );
  }
  return lock;
}

function sortedObject<T>(input: Record<string, T>, map: (value: T) => T = (v) => v): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(input).sort()) out[key] = map(input[key] as T);
  return out;
}

export function serializeLock(lock: Lock): string {
  const sorted: Lock = {
    lockVersion: 1,
    items: sortedObject(lock.items, (item) => ({
      templateVersion: item.templateVersion,
      files: sortedObject(item.files),
      ...(item.dataVersion ? { dataVersion: item.dataVersion } : {}),
    })),
  };
  if (lock.migrations) {
    sorted.migrations = [...new Set(lock.migrations)].sort((a, b) => {
      const pa = parseVersion(a);
      const pb = parseVersion(b);
      return pa && pb ? compareVersions(pa, pb) : a < b ? -1 : 1;
    });
  }
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

export function serializeLockV2(lock: LockV2): string {
  const out: LockV2 = {
    lockVersion: 2,
    commit: lock.commit,
    version: lock.version,
    items: [...new Set(lock.items)].sort(),
  };
  if (lock.pending && Object.keys(lock.pending).length > 0) {
    out.pending = sortedObject(lock.pending, (p) => ({ old: p.old, since: p.since }));
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

async function writeAtomic(target: string, content: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, target);
}

export async function saveLock(vault: Vault, lock: Lock): Promise<void> {
  await writeAtomic(lockPath(vault), serializeLock(lock));
}

export async function saveLockV2(vault: Vault, lock: LockV2): Promise<void> {
  await writeAtomic(lockPath(vault), serializeLockV2(lock));
}
