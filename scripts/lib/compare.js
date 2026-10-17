import { readdir, readFile, stat } from 'fs/promises';
import { createHash } from 'crypto';
import { join, relative } from 'path';
import {
  TEMPLATE_DIR,
  TEMPLATE_PLUGINS_DIR,
  TEMPLATE_OBSIDIAN_DIR,
  DATA_FILES,
  PLUGIN_DIR_CONDITIONS,
  DIR_OPTIONS,
  SETTINGS_ITEMS,
  pathExists,
  discoverPlugins,
} from './cli.js';

// Statuses, ordered from best to worst for display.
export const STATUSES = ['in sync', 'outdated', 'partial', 'not synced'];

async function listFiles(root) {
  const files = [];
  async function walk(dir) {
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

async function hashFile(file) {
  return createHash('sha1').update(await readFile(file)).digest('hex');
}

// Compares a template path (file or directory) with its counterpart in a vault.
// skip(relPath) excludes files from the comparison, like sync does for plugin data.json.
async function compareTrees(srcRoot, destRoot, skip = () => false) {
  const result = { match: [], differs: [], missing: [], extra: [] };
  const srcFiles = (await listFiles(srcRoot)).filter((f) => !skip(f));
  const destExists = await pathExists(destRoot);
  const destFiles = destExists ? (await listFiles(destRoot)).filter((f) => !skip(f)) : [];
  const destSet = new Set(destFiles);

  for (const rel of srcFiles) {
    if (!destSet.has(rel)) {
      result.missing.push(rel);
      continue;
    }
    const [a, b] = await Promise.all([hashFile(join(srcRoot, rel)), hashFile(join(destRoot, rel))]);
    (a === b ? result.match : result.differs).push(rel);
  }
  const srcSet = new Set(srcFiles);
  result.extra = destFiles.filter((f) => !srcSet.has(f));
  return { ...result, destExists };
}

function statusOf(files) {
  const { match, differs, missing, destExists } = files;
  if (!destExists || (match.length === 0 && differs.length === 0 && missing.length > 0)) return 'not synced';
  if (differs.length > 0) return 'outdated';
  if (missing.length > 0) return 'partial';
  return 'in sync';
}

async function readVersion(manifestPath) {
  try {
    return JSON.parse(await readFile(manifestPath, 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

// Every item sync can copy: { kind: 'plugin' | 'dir' | 'setting', id, label }.
export async function listItems() {
  const items = [];
  for (const plugin of await discoverPlugins()) {
    items.push({ kind: 'plugin', id: plugin.id, label: plugin.name });
  }

  const dirs = [...DIR_OPTIONS, ...PLUGIN_DIR_CONDITIONS.map((c) => c.dir)];
  const seen = new Set();
  for (const dir of dirs) {
    if (seen.has(dir.toLowerCase())) continue;
    seen.add(dir.toLowerCase());
    if (await pathExists(join(TEMPLATE_DIR, dir))) items.push({ kind: 'dir', id: dir, label: dir });
  }

  for (const setting of SETTINGS_ITEMS) {
    if (await pathExists(join(TEMPLATE_OBSIDIAN_DIR, setting))) {
      items.push({ kind: 'setting', id: setting, label: setting });
    }
  }
  return items;
}

export async function compareItem(vault, item) {
  let files;
  let extra = {};
  if (item.kind === 'plugin') {
    const src = join(TEMPLATE_PLUGINS_DIR, item.id);
    const dest = join(vault.pluginsDir, item.id);
    files = await compareTrees(src, dest, (rel) => DATA_FILES.has(rel));
    extra = {
      templateVersion: await readVersion(join(src, 'manifest.json')),
      vaultVersion: await readVersion(join(dest, 'manifest.json')),
    };
  } else if (item.kind === 'dir') {
    files = await compareTrees(join(TEMPLATE_DIR, item.id), join(vault.root, item.id));
  } else {
    files = await compareTrees(join(TEMPLATE_OBSIDIAN_DIR, item.id), join(vault.root, '.obsidian', item.id));
  }
  return { ...item, ...extra, status: statusOf(files), files };
}

export async function compareVault(vault, items) {
  const list = items ?? (await listItems());
  const results = [];
  for (const item of list) results.push(await compareItem(vault, item));
  return results;
}

export function summarize(results) {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const r of results) counts[r.status] += 1;
  return counts;
}
