import { relative, sep } from 'path';
import { loadConfig, loadVaultConfig } from './cli.ts';
import { createMatcher } from './glob.ts';
import { isValidRange } from './semver.ts';
import { itemKey } from './lock.ts';
import type { Item, SyncConfig, Vault } from './types.ts';

// What a vault's owner (and the repo config) says sync must leave alone, on top of the template.
export interface Policy {
  protect: string[];
  exclude: string[];
  pin: string | undefined;
  isProtected(vaultRelPath: string): boolean;
  isExcluded(item: Item): boolean;
}

// protect and exclude add up across repo and vault config; pin: the vault wins.
export function mergePolicy(vaultConfig: SyncConfig, repoConfig: SyncConfig): Policy {
  const protect = [...new Set([...(repoConfig.protect ?? []), ...(vaultConfig.protect ?? [])])];
  const exclude = [...new Set([...(repoConfig.exclude ?? []), ...(vaultConfig.exclude ?? [])])];
  const pin = vaultConfig.pin ?? repoConfig.pin;
  if (pin !== undefined && !isValidRange(pin)) {
    throw new Error(`Invalid pin "${pin}". Use a version like 0.3.1, 0.2.x, ^0.3.0 or ~0.3.0.`);
  }
  const excluded = new Set(exclude.map((e) => e.toLowerCase()));
  const matchProtected = createMatcher(protect);
  return {
    protect,
    exclude,
    pin,
    isProtected: matchProtected,
    isExcluded: (item) => excluded.has(itemKey(item).toLowerCase()),
  };
}

export async function loadPolicy(vault: Vault): Promise<Policy> {
  return mergePolicy(await loadVaultConfig(vault.root), await loadConfig());
}

export const NO_POLICY: Policy = mergePolicy({}, {});

// Path of a file inside a vault, relative to the vault root with "/" separators.
export function vaultRelPath(vault: Vault, absolute: string): string {
  return relative(vault.root, absolute).split(sep).join('/');
}
