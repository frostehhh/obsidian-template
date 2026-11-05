import { readFile, writeFile, mkdir, rename, rm, rmdir } from 'fs/promises';
import { dirname, join } from 'path';
import { pathExists } from './cli.ts';
import { compareVault, compareItem, listItems, itemPaths, isDataFile, hashFile } from './compare.ts';
import { loadLock, saveLock, emptyLock, itemKey } from './lock.ts';
import { deepEqual, formatLike, merge3, patchCovers, resolveMerge } from './jsonmerge.ts';
import type { Merge3Result } from './jsonmerge.ts';
import { listMigrations, planMigrations, runMigrations, applyPatches } from './migrations.ts';
import { parseVersion } from './semver.ts';
import { gitSource } from './source.ts';
import { loadPolicy, vaultRelPath } from './policy.ts';
import type { Policy } from './policy.ts';
import { decide, resolve, applyProtection } from './reconcile.ts';
import type { Action, FileDecision } from './reconcile.ts';
import type {
  ConflictPolicy,
  Item,
  ItemResult,
  Lock,
  LockItem,
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
  // Key path inside a merged data.json ("a.b.c")
  detail?: string;
}

export function conflictLabel(c: SyncConflict): string {
  return `${c.file || c.item.id}${c.detail ? ` [${c.detail}]` : ''}`;
}

// Per-vault work besides items: migrations still to run and the vault's patches.
export interface VaultExtras {
  vault: Vault;
  // Migration versions to run, in order
  migrations: string[];
  // Written to the lock's migrations list after a successful run
  record: string[];
  patches: Record<string, unknown>;
}

export interface SyncResult {
  plan: ItemPlan[];
  extras: VaultExtras[];
  preReports: SyncPreReport[];
  postReports: SyncPostReport[];
  conflicts: SyncConflict[];
  // Migration and patch log lines
  notes: string[];
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

// Template versions read from git to find the base of a data.json merge (a tag per version, cached).
const baseSources = new Map<string, TemplateSource | null>();

function sourceAtVersion(version: string): TemplateSource | null {
  if (!parseVersion(version)) return null; // "working-tree" and the like cannot be reproduced
  let source = baseSources.get(version);
  if (source === undefined) {
    try {
      source = gitSource(`v${version}`);
    } catch {
      source = null; // tag not available in this checkout
    }
    baseSources.set(version, source);
  }
  return source;
}

async function readJsonOrUndefined(read: () => Promise<Buffer | string> | string): Promise<unknown> {
  try {
    return JSON.parse((await read()).toString());
  } catch {
    return undefined;
  }
}

// Key-level three-way merge of a plugin's data.json. Base: the template version whose data.json was last merged
// (lock), or --assume. Without a base (or when the tag is missing) it is empty: keys only in the template are added,
// keys only in the vault stay, and keys that differ are conflicts. Returns null if either side is not valid JSON.
async function planDataMerge(
  options: SyncOptions,
  lockItem: LockItem | undefined,
  srcRel: string,
  destRoot: string,
  file: string,
  patch: unknown
): Promise<{ merge: Merge3Result; changed: boolean } | null> {
  const template = await readJsonOrUndefined(() => options.source.read(srcRel, file));
  const vaultText = await readFile(join(destRoot, file), 'utf8');
  const vault = await readJsonOrUndefined(() => vaultText);
  if (template === undefined || vault === undefined) return null;

  const baseSource = lockItem?.dataVersion ? sourceAtVersion(lockItem.dataVersion) : (options.assume ?? null);
  const base = baseSource ? ((await readJsonOrUndefined(() => baseSource.read(srcRel, file))) ?? {}) : {};

  const result = merge3(base, template, vault);
  // Keys the vault's own patch decides are not conflicts: the patch is reapplied after the sync.
  const conflicts = patch === undefined ? result.conflicts : result.conflicts.filter((c) => !patchCovers(patch, c.path));
  return { merge: { ...result, conflicts }, changed: !deepEqual(result.merged, vault) };
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
      // Per-vault state, never recorded in the lock. Copied when missing. With syncDataJson, data.json is merged
      // key by key (template changes since the last merge go in, the vault's own settings stay).
      if (templateHash === undefined) continue;
      const decision: FileDecision = { file, action: 'noop', templateHash, baseHash: undefined, vaultHash, tracked: false };
      if (vaultHash === undefined) {
        decision.action = 'add';
      } else if (syncDataJson && file === 'data.json' && vaultHash !== templateHash) {
        const patch = policy.patches[vaultRelPath(vault, join(destRoot, file))];
        const planned = await planDataMerge(options, lock?.items[itemKey(item)], srcRel, destRoot, file, patch);
        if (planned) {
          decision.merge = planned.merge;
          decision.action = planned.merge.conflicts.length > 0 ? 'conflict' : planned.changed ? 'update' : 'noop';
        } else {
          decision.action = 'conflict'; // not valid JSON on one side: nothing to merge key by key
        }
      }
      decision.action = applyProtection(decision.action, isProtected);
      decisions.push(decision);
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

// Migrations still to run for a vault (from the source's migrations/ directory) and the vault's patches.
export async function buildVaultExtras(vault: Vault, source: TemplateSource, assume?: TemplateSource): Promise<VaultExtras> {
  const policy = await loadPolicy(vault);
  const { pending, record } = planMigrations(await listMigrations(source), await loadLock(vault), assume?.version, source.version);
  return { vault, migrations: pending, record, patches: policy.patches };
}

// JSON-friendly view of a plan: files grouped by action per item. Merged data.json keys that conflict are listed as "file [key]".
export function describePlan(plan: ItemPlan[]) {
  return plan.map((entry) => {
    const by = (action: Action) =>
      entry.decisions
        .filter((d) => d.action === action)
        .flatMap((d) =>
          action === 'conflict' && d.merge && d.merge.conflicts.length > 0
            ? d.merge.conflicts.map((c) => `${d.file} [${c.path.join('.')}]`)
            : [d.file || entry.item.id]
        );
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
export async function applyPlan(
  plan: ItemPlan[],
  source: TemplateSource,
  policy: ConflictPolicy,
  extras: VaultExtras[] = []
): Promise<{ conflicts: SyncConflict[]; notes: string[] }> {
  const conflicts: SyncConflict[] = [];
  const notes: string[] = [];
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
      let dataVersion = lock.items[itemKey(item)]?.dataVersion;
      for (const d of entry.decisions) {
        const target = join(destRoot, d.file);

        // data.json merged key by key: the vault wins conflicts unless the policy says take-template
        if (d.merge && d.action !== 'protected') {
          const text = await readFile(target, 'utf8');
          const final = resolveMerge(d.merge, policy === 'take-template');
          if (policy === 'skip') {
            for (const c of d.merge.conflicts) conflicts.push({ vault, item, file: d.file, detail: c.path.join('.') });
          }
          if (!deepEqual(final, JSON.parse(text))) {
            const tmp = `${target}.sync-tmp`;
            await writeFile(tmp, formatLike(text, final));
            staged.push({ tmp, dest: target });
          }
          // The next merge starts from this version, unless conflicts are left to be reported again
          if (!(policy === 'skip' && d.merge.conflicts.length > 0)) dataVersion = source.version;
          continue;
        }

        const resolution = resolve(d, policy);
        if (d.file === 'data.json' && !d.tracked) {
          const vaultNowEqualsTemplate = d.action === 'add' || (d.action === 'noop' && d.vaultHash === d.templateHash);
          if (vaultNowEqualsTemplate || (d.action === 'conflict' && policy !== 'skip')) dataVersion = source.version;
        }

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
      lock.items[itemKey(item)] = { templateVersion: source.version, files, ...(dataVersion ? { dataVersion } : {}) };

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

  // Migrations, then the vault's patches. They run after the files are in place and are idempotent, so a failure
  // here leaves the old lock and a rerun simply does them again.
  for (const extra of extras) {
    const lock = locks.get(extra.vault.name) ?? (await loadLock(extra.vault)) ?? emptyLock();
    locks.set(extra.vault.name, lock);
    vaults.set(extra.vault.name, extra.vault);
    const vaultPolicy = await loadPolicy(extra.vault);
    notes.push(...(await runMigrations(extra.vault, extra.migrations, source, vaultPolicy)));
    notes.push(...(await applyPatches(extra.vault, extra.patches, vaultPolicy)));
    lock.migrations = [...new Set([...(lock.migrations ?? []), ...extra.record])];
  }

  // The lock goes last: a run that failed earlier leaves the previous lock, so repeating it is safe.
  for (const [name, lock] of locks) {
    const vault = vaults.get(name);
    if (vault && (await pathExists(join(vault.root, '.obsidian')))) await saveLock(vault, lock);
  }

  return { conflicts, notes };
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
  const extras: VaultExtras[] = [];
  for (const vault of vaults) extras.push(await buildVaultExtras(vault, source, options.assume));
  const { conflicts, notes } = await applyPlan(plan, source, options.onConflict ?? 'skip', extras);

  // Post-sync verification. Vaults with nothing planned (everything excluded) still get an entry.
  const postReports = await verifyPlan(plan, source);
  for (const vault of vaults) {
    if (!postReports.some((r) => r.vault.name === vault.name)) postReports.push({ vault, results: [] });
  }

  return { plan, extras, preReports, postReports, conflicts, notes };
}
