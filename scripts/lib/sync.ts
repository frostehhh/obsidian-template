import { readFile, writeFile, mkdir, rename, rm, rmdir } from 'fs/promises';
import { dirname, join } from 'path';
import { pathExists } from './cli.ts';
import { compareVault, compareItem, listItems, itemPaths, isDataFile, hashFile } from './compare.ts';
import { loadLock, saveLock, emptyLock, itemKey } from './lock.ts';
import { loadPolicy, vaultRelPath } from './policy.ts';
import type { Policy } from './policy.ts';
import { decide, resolve, applyProtection } from './reconcile.ts';
import type { Action, FileDecision } from './reconcile.ts';
import type {
  ConflictPolicy,
  Item,
  ItemResult,
  Lock,
  PluginInfo,
  SyncConfig,
  TemplateSource,
  Vault,
} from './types.ts';

export interface ItemPlan {
  vault: Vault;
  item: Item;
  srcRel: string;
  destRoot: string;
  decisions: FileDecision[];
  // True when the vault has a lock entry (or --assume supplied a base) for this item.
  baseKnown: boolean;
  addToCommunityPlugins: boolean;
}

export interface SyncOptions {
  vaults: Vault[];
  plugins: PluginInfo[];
  pluginIds: string[];
  dirs: string[];
  settings: string[];
  syncDataJson: boolean;
  source: TemplateSource;
  onConflict?: ConflictPolicy;
  // Base for items that have no lock entry yet, read from this template version (e.g. a vault known to be at 0.2.0).
  assume?: TemplateSource;
}

export interface SyncPreReport {
  vault: Vault;
  inSync: number;
  total: number;
}

export interface SyncPostReport {
  vault: Vault;
  results: ItemResult[];
}

export interface SyncConflict {
  vault: Vault;
  item: Item;
  file: string;
}

export interface SyncResult {
  plan: ItemPlan[];
  preReports: SyncPreReport[];
  postReports: SyncPostReport[];
  conflicts: SyncConflict[];
}

export interface ResolvedVaultConfig {
  pluginIds: string[];
  dirs: string[];
  settings: string[];
  syncDataJson: boolean;
}

export function resolveVaultConfig(
  vaultConfig: SyncConfig,
  repoConfig: SyncConfig,
  cliArgs: {
    plugins?: string[];
    dirs?: string[];
    settings?: string[];
    dataJson?: boolean;
  }
): ResolvedVaultConfig {
  const pluginIds = cliArgs.plugins ?? vaultConfig.defaultPlugins ?? repoConfig.defaultPlugins ?? [];
  const dirs = cliArgs.dirs ?? vaultConfig.defaultDirs ?? repoConfig.defaultDirs ?? ['--Attachments--', '--Configurations--/Obsidian Template', 'Bases', 'Notes'];
  const settings = cliArgs.settings ?? vaultConfig.defaultSettings ?? repoConfig.defaultSettings ?? [];
  const syncDataJson = cliArgs.dataJson ?? vaultConfig.syncDataJson ?? repoConfig.syncDataJson ?? false;

  return { pluginIds, dirs, settings, syncDataJson };
}

// Items selected for sync, in listing order. Directories match case-insensitively (ExcaliBrain).
export function selectItems(items: Item[], options: Pick<SyncOptions, 'pluginIds' | 'dirs' | 'settings'>): Item[] {
  const dirs = options.dirs.map((d) => d.toLowerCase());
  return items.filter(
    (item) =>
      (item.kind === 'plugin' && options.pluginIds.includes(item.id)) ||
      (item.kind === 'dir' && dirs.includes(item.id.toLowerCase())) ||
      (item.kind === 'setting' && options.settings.includes(item.id))
  );
}

async function vaultHashOf(destRoot: string, file: string): Promise<string | undefined> {
  try {
    return await hashFile(join(destRoot, file));
  } catch {
    return undefined;
  }
}

async function planItem(
  vault: Vault,
  item: Item,
  lock: Lock | null,
  options: SyncOptions,
  policy: Policy,
  existingCommunityPlugins: string[]
): Promise<ItemPlan> {
  const { source, assume, syncDataJson } = options;
  const { srcRel, destRoot } = itemPaths(item, vault);
  const templateFiles = await source.list(srcRel);

  let base: Record<string, string> | undefined = lock?.items[itemKey(item)]?.files;
  if (!base && assume) {
    base = Object.fromEntries((await assume.list(srcRel)).map((f) => [f.file, f.hash]));
  }

  const templateHashes = new Map(templateFiles.map((f) => [f.file, f.hash]));
  const files = [...new Set([...templateHashes.keys(), ...Object.keys(base ?? {})])].sort();

  const decisions: FileDecision[] = [];
  for (const file of files) {
    const templateHash = templateHashes.get(file);
    const vaultHash = await vaultHashOf(destRoot, file);
    const isProtected = policy.isProtected(vaultRelPath(vault, join(destRoot, file)));

    if (isDataFile(item, file)) {
      // Per-vault state: copied when missing, overwritten only on request, never recorded in the lock.
      if (templateHash === undefined) continue;
      let action: Action = 'noop';
      if (vaultHash === undefined) action = 'add';
      else if (syncDataJson && vaultHash !== templateHash) action = 'update';
      decisions.push({ file, action: applyProtection(action, isProtected), templateHash, baseHash: undefined, vaultHash, tracked: false });
      continue;
    }

    const baseHash = base?.[file];
    const action = applyProtection(decide(templateHash, baseHash, vaultHash), isProtected);
    decisions.push({ file, action, templateHash, baseHash, vaultHash, tracked: true });
  }

  return {
    vault,
    item,
    srcRel,
    destRoot,
    decisions,
    baseKnown: base !== undefined,
    addToCommunityPlugins: item.kind === 'plugin' && !existingCommunityPlugins.includes(item.id),
  };
}

async function readCommunityPlugins(vault: Vault): Promise<string[]> {
  try {
    return JSON.parse(await readFile(vault.communityPluginsPath, 'utf8'));
  } catch {
    return []; // Missing community-plugins.json — start fresh
  }
}

// Decides what sync would do, without writing anything. Honors each vault's exclude and protect settings.
export async function buildSyncPlan(options: SyncOptions): Promise<ItemPlan[]> {
  const selected = selectItems(await listItems(options.source), options);
  const plan: ItemPlan[] = [];

  for (const vault of options.vaults) {
    const policy = await loadPolicy(vault);
    const existingCommunityPlugins = await readCommunityPlugins(vault);
    const lock = await loadLock(vault);
    for (const item of selected) {
      if (policy.isExcluded(item)) continue;
      plan.push(await planItem(vault, item, lock, options, policy, existingCommunityPlugins));
    }
  }
  return plan;
}

// JSON-friendly view of a plan: files grouped by action per item.
export function describePlan(plan: ItemPlan[]) {
  return plan.map((entry) => {
    const by = (action: Action) => entry.decisions.filter((d) => d.action === action).map((d) => d.file || entry.item.id);
    return {
      kind: entry.item.kind,
      id: entry.item.id,
      baseKnown: entry.baseKnown,
      add: by('add'),
      update: by('update'),
      delete: by('delete'),
      keep: by('keep'),
      protected: by('protected'),
      conflict: by('conflict'),
      addToCommunityPlugins: entry.addToCommunityPlugins,
    };
  });
}

export function countActions(plan: ItemPlan[]): Record<Action, number> {
  const counts: Record<Action, number> = { noop: 0, add: 0, update: 0, delete: 0, keep: 0, conflict: 0, protected: 0 };
  for (const entry of plan) for (const d of entry.decisions) counts[d.action] += 1;
  return counts;
}

async function removeEmptyParents(file: string, stopAt: string): Promise<void> {
  let dir = dirname(file);
  while (dir.length > stopAt.length && dir.startsWith(stopAt)) {
    try {
      await rmdir(dir);
    } catch {
      return; // not empty (or already gone)
    }
    dir = dirname(dir);
  }
}

interface Staged {
  tmp: string;
  dest: string;
}

// Applies a plan to the vaults it names, all with the same source.
// Two phases: every new file is first written next to its destination (a failure here changes nothing),
// then files are renamed into place, deletions run, and the lock is written last.
export async function applyPlan(plan: ItemPlan[], source: TemplateSource, policy: ConflictPolicy): Promise<SyncConflict[]> {
  const conflicts: SyncConflict[] = [];
  const staged: Staged[] = [];
  const deletions: { target: string; destRoot: string }[] = [];
  const locks = new Map<string, Lock>();
  const vaults = new Map<string, Vault>();
  const pluginIds = new Map<string, string[]>();

  try {
    for (const entry of plan) {
      const { vault, item, srcRel, destRoot } = entry;
      vaults.set(vault.name, vault);
      const lock = locks.get(vault.name) ?? (await loadLock(vault)) ?? emptyLock();
      locks.set(vault.name, lock);

      const files: Record<string, string> = {};
      for (const d of entry.decisions) {
        const resolution = resolve(d, policy);
        const target = join(destRoot, d.file);

        if (resolution.conflict) conflicts.push({ vault, item, file: d.file });
        if (resolution.effect === 'write') {
          await mkdir(dirname(target), { recursive: true });
          const tmp = `${target}.sync-tmp`;
          await writeFile(tmp, await source.read(srcRel, d.file));
          staged.push({ tmp, dest: target });
        } else if (resolution.effect === 'delete') {
          deletions.push({ target, destRoot });
        }
        // Data files are written (when missing or forced) but not recorded.
        if (d.tracked && resolution.base !== undefined) files[d.file] = resolution.base;
      }
      lock.items[itemKey(item)] = { templateVersion: source.version, files };

      if (item.kind === 'plugin') {
        const ids = pluginIds.get(vault.name) ?? [];
        ids.push(item.id);
        pluginIds.set(vault.name, ids);
      }
    }
  } catch (error) {
    for (const s of staged) await rm(s.tmp, { force: true });
    throw error;
  }

  for (const s of staged) await rename(s.tmp, s.dest);
  for (const d of deletions) {
    await rm(d.target, { force: true });
    await removeEmptyParents(d.target, d.destRoot);
  }

  // community-plugins.json is read fresh, so a plan applied later does not clobber edits made since.
  for (const [name, ids] of pluginIds) {
    const vault = vaults.get(name);
    if (!vault) continue;
    const current = await readCommunityPlugins(vault);
    const updated = [...current, ...ids.filter((id) => !current.includes(id))];
    if (updated.length !== current.length) await writeFile(vault.communityPluginsPath, JSON.stringify(updated, null, 2));
  }

  // The lock goes last: a run that failed earlier leaves the previous lock, so repeating it is safe.
  for (const [name, lock] of locks) {
    const vault = vaults.get(name);
    if (vault && (await pathExists(join(vault.root, '.obsidian')))) await saveLock(vault, lock);
  }

  return conflicts;
}

// Compares the items of a plan with their vaults after it was applied.
export async function verifyPlan(plan: ItemPlan[], source: TemplateSource): Promise<SyncPostReport[]> {
  const reports: SyncPostReport[] = [];
  const byVault = new Map<string, { vault: Vault; items: Item[] }>();
  for (const entry of plan) {
    const group = byVault.get(entry.vault.name) ?? { vault: entry.vault, items: [] };
    group.items.push(entry.item);
    byVault.set(entry.vault.name, group);
  }
  for (const { vault, items } of byVault.values()) {
    const lock = await loadLock(vault);
    const policy = await loadPolicy(vault);
    const results: ItemResult[] = [];
    for (const item of items) results.push(await compareItem(vault, item, source, lock?.items[itemKey(item)], policy));
    reports.push({ vault, results });
  }
  return reports;
}

export async function executeSync(options: SyncOptions): Promise<SyncResult> {
  const { vaults, source } = options;
  const items = await listItems(source);

  // Pre-sync comparison
  const preReports: SyncPreReport[] = [];
  for (const vault of vaults) {
    const results = await compareVault(vault, source, items);
    preReports.push({ vault, inSync: results.filter((r) => r.status === 'in sync').length, total: results.length });
  }

  const plan = await buildSyncPlan(options);
  const conflicts = await applyPlan(plan, source, options.onConflict ?? 'skip');

  // Post-sync verification. Vaults with nothing planned (everything excluded) still get an entry.
  const postReports = await verifyPlan(plan, source);
  for (const vault of vaults) {
    if (!postReports.some((r) => r.vault.name === vault.name)) postReports.push({ vault, results: [] });
  }

  return { plan, preReports, postReports, conflicts };
}
