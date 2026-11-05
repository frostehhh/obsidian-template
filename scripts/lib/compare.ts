import { readdir, readFile, stat } from 'fs/promises';
import { join, relative } from 'path';
import {
  DATA_FILES,
  PLUGIN_DIR_CONDITIONS,
  DIR_OPTIONS,
  SETTINGS_ITEMS,
  pathExists,
  discoverPlugins,
} from './cli.ts';
import { hashContent } from './source.ts';
import { loadLock, itemKey } from './lock.ts';
import { loadPolicy, vaultRelPath, NO_POLICY } from './policy.ts';
import type { Policy } from './policy.ts';
import type { Item, ItemResult, LockItem, SourceFile, Status, TemplateSource, TreeComparison, Vault } from './types.ts';

// Statuses, ordered from best to worst for display.
export const STATUSES: Status[] = ['in sync', 'outdated', 'partial', 'not synced'];

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.push(relative(root, full));
    }
  }
  const info = await stat(root);
  if (info.isDirectory()) await walk(root);
  else files.push('');
  return files;
}

export async function hashFile(file: string): Promise<string> {
  return hashContent(await readFile(file));
}

// Where an item lives in the template (relative to template/) and in a vault.
export function itemPaths(item: Item, vault: Vault): { srcRel: string; destRoot: string } {
  if (item.kind === 'plugin') return { srcRel: `.obsidian/plugins/${item.id}`, destRoot: join(vault.pluginsDir, item.id) };
  if (item.kind === 'dir') return { srcRel: item.id, destRoot: join(vault.root, item.id) };
  return { srcRel: `.obsidian/${item.id}`, destRoot: join(vault.root, '.obsidian', item.id) };
}

// Plugin data files hold per-vault state and stay outside the lock (top level of the plugin directory only).
export function isDataFile(item: Item, rel: string): boolean {
  return item.kind === 'plugin' && DATA_FILES.has(rel);
}

// Compares template files with their counterpart in a vault.
// skip(relPath) excludes files from the comparison, like sync does for plugin data.json.
// base: the vault's lock entry, used to tell local overrides and stale files from real differences.
async function compareTrees(
  srcFiles: SourceFile[],
  destRoot: string,
  skip: (rel: string) => boolean = () => false,
  base?: Record<string, string>,
  // Protected files are the vault's own: differences count as local overrides.
  isProtected: (rel: string) => boolean = () => false
): Promise<TreeComparison> {
  const result = {
    match: [] as string[],
    differs: [] as string[],
    missing: [] as string[],
    extra: [] as string[],
    overridden: [] as string[],
    stale: [] as string[],
  };
  const src = srcFiles.filter((f) => !skip(f.file));
  const destExists = await pathExists(destRoot);
  const destFiles = destExists ? (await listFiles(destRoot)).filter((f) => !skip(f)) : [];
  const destSet = new Set(destFiles);

  for (const { file, hash } of src) {
    const baseHash = base?.[file];
    const unchangedInTemplate = (baseHash !== undefined && baseHash === hash) || isProtected(file);
    if (!destSet.has(file)) {
      (unchangedInTemplate ? result.overridden : result.missing).push(file);
      continue;
    }
    const vaultHash = await hashFile(join(destRoot, file));
    if (vaultHash === hash) result.match.push(file);
    else (unchangedInTemplate ? result.overridden : result.differs).push(file);
  }

  const srcSet = new Set(src.map((f) => f.file));
  const stale = new Set<string>();
  for (const [file, baseHash] of Object.entries(base ?? {})) {
    if (srcSet.has(file) || skip(file) || !destSet.has(file) || isProtected(file)) continue;
    if ((await hashFile(join(destRoot, file))) === baseHash) stale.add(file);
  }
  result.stale = [...stale].sort();
  result.extra = destFiles.filter((f) => !srcSet.has(f) && !stale.has(f));
  return { ...result, destExists };
}

function statusOf(files: TreeComparison): Status {
  const { match, differs, missing, stale, destExists } = files;
  if (!destExists || (match.length === 0 && differs.length === 0 && missing.length > 0)) return 'not synced';
  if (differs.length > 0 || stale.length > 0) return 'outdated';
  if (missing.length > 0) return 'partial';
  return 'in sync';
}

async function readVersion(source: TemplateSource | null, rel: string, vaultPath?: string): Promise<string | null> {
  try {
    const raw = source ? await source.read(rel, 'manifest.json') : await readFile(vaultPath ?? '', 'utf8');
    return JSON.parse(raw.toString()).version ?? null;
  } catch {
    return null;
  }
}

// Every item sync can copy: { kind: 'plugin' | 'dir' | 'setting', id, label }.
export async function listItems(source: TemplateSource): Promise<Item[]> {
  const items: Item[] = [];
  for (const plugin of await discoverPlugins(source)) {
    items.push({ kind: 'plugin', id: plugin.id, label: plugin.name });
  }

  const dirs = [...DIR_OPTIONS, ...PLUGIN_DIR_CONDITIONS.map((c) => c.dir)];
  const seen = new Set();
  for (const dir of dirs) {
    if (seen.has(dir.toLowerCase())) continue;
    seen.add(dir.toLowerCase());
    if ((await source.list(dir)).length > 0) items.push({ kind: 'dir', id: dir, label: dir });
  }

  for (const setting of SETTINGS_ITEMS) {
    if ((await source.list(`.obsidian/${setting}`)).length > 0) {
      items.push({ kind: 'setting', id: setting, label: setting });
    }
  }
  return items;
}

export async function compareItem(
  vault: Vault,
  item: Item,
  source: TemplateSource,
  lockItem?: LockItem,
  policy: Policy = NO_POLICY
): Promise<ItemResult> {
  const { srcRel, destRoot } = itemPaths(item, vault);
  const srcFiles = await source.list(srcRel);
  const files = await compareTrees(
    srcFiles,
    destRoot,
    (rel) => isDataFile(item, rel),
    lockItem?.files,
    (rel) => policy.isProtected(vaultRelPath(vault, join(destRoot, rel)))
  );
  let extra: { templateVersion?: string | null; vaultVersion?: string | null } = {};
  if (item.kind === 'plugin') {
    extra = {
      templateVersion: await readVersion(source, srcRel),
      vaultVersion: await readVersion(null, srcRel, join(destRoot, 'manifest.json')),
    };
  }
  return { ...item, ...extra, syncedVersion: lockItem?.templateVersion ?? null, status: statusOf(files), files };
}

export async function compareVault(vault: Vault, source: TemplateSource, items?: Item[]): Promise<ItemResult[]> {
  const policy = await loadPolicy(vault);
  const list = (items ?? (await listItems(source))).filter((item) => !policy.isExcluded(item));
  const lock = await loadLock(vault);
  const results: ItemResult[] = [];
  for (const item of list) results.push(await compareItem(vault, item, source, lock?.items[itemKey(item)], policy));
  return results;
}

export function summarize(results: ItemResult[]): Record<Status, number> {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
  for (const r of results) counts[r.status] += 1;
  return counts;
}
