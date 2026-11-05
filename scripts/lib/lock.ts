import { readFile, writeFile, rename, mkdir } from 'fs/promises';
import { dirname, join } from 'path';
import { compareVersions, parseVersion } from './semver.ts';
import type { Item, Lock, Vault } from './types.ts';

export const LOCK_FILE = 'template.lock.json';

export function lockPath(vault: Vault): string {
  return join(vault.root, '.obsidian', LOCK_FILE);
}

export function itemKey(item: Pick<Item, 'kind' | 'id'>): string {
  return `${item.kind}:${item.id}`;
}

export function emptyLock(): Lock {
  return { lockVersion: 1, items: {} };
}

// Returns null when the vault has no lock yet (never synced with a version-aware sync).
export async function loadLock(vault: Vault): Promise<Lock | null> {
  let raw: string;
  try {
    raw = await readFile(lockPath(vault), 'utf8');
  } catch {
    return null;
  }
  const parsed = JSON.parse(raw) as Lock;
  if (parsed.lockVersion !== 1) throw new Error(`${lockPath(vault)}: unsupported lockVersion ${String(parsed.lockVersion)}`);
  return parsed;
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

// Atomic write: temp file in the same directory, then rename.
export async function saveLock(vault: Vault, lock: Lock): Promise<void> {
  const target = lockPath(vault);
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  await writeFile(tmp, serializeLock(lock));
  await rename(tmp, target);
}
