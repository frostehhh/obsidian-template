import * as p from '@clack/prompts';
import { readFileSync } from 'fs';
import { readdir, readFile, mkdir, copyFile, stat } from 'fs/promises';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TEMPLATE_DIR = join(REPO_ROOT, 'template');
export const TEMPLATE_PLUGINS_DIR = join(TEMPLATE_DIR, '.obsidian', 'plugins');
export const TEMPLATE_OBSIDIAN_DIR = join(TEMPLATE_DIR, '.obsidian');
export const OBSIDIAN_ROOT = dirname(REPO_ROOT);
export const CONFIG_PATH = join(REPO_ROOT, 'sync.config.json');

// What the template contains and which parts can be synced lives in state.json (refresh with `mise run state`).
export const STATE_PATH = join(REPO_ROOT, 'state.json');
export const STATE = JSON.parse(readFileSync(STATE_PATH, 'utf8'));

export const DATA_FILES = new Set(STATE.dataFiles);
export const PLUGIN_DIR_CONDITIONS = STATE.dirs.pluginLinked.map(({ plugin, dir }) => ({ pluginId: plugin, dir }));
export const DIR_OPTIONS = STATE.dirs.selectable;
export const SETTINGS_ITEMS = STATE.settings.syncable.map((s) => s.name);

export async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

export async function copyRecursive(src, dest) {
  const entries = await readdir(src, { withFileTypes: true });
  await mkdir(dest, { recursive: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyRecursive(srcPath, destPath);
    } else {
      await copyFile(srcPath, destPath);
    }
  }
}

export async function copyAny(src, dest) {
  const info = await stat(src);
  if (info.isDirectory()) {
    await copyRecursive(src, dest);
  } else {
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(src, dest);
  }
}

export function cancel(msg = 'Cancelled.') {
  p.cancel(msg);
  process.exit(0);
}

export async function multiselectWithToggle({ message, options, initialValues = [], required = false }) {
  while (true) {
    const result = await p.multiselect({
      message: `${message}  (a = toggle all)`,
      options,
      initialValues,
      required: false,
    });

    if (p.isCancel(result)) return result;

    if (required && result.length === 0) {
      p.log.warn('Please select at least one item.');
      continue;
    }

    return result;
  }
}

export async function loadConfig() {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  } catch {
    // No config file — fully interactive mode
    return {};
  }
}

// Plugins listed in state.json, with name and version read live from each manifest.
export async function discoverPlugins() {
  const plugins = [];
  for (const { id } of STATE.plugins) {
    try {
      const manifest = JSON.parse(await readFile(join(TEMPLATE_PLUGINS_DIR, id, 'manifest.json'), 'utf8'));
      plugins.push({ id, name: manifest.name, version: manifest.version });
    } catch {
      // Listed in state.json but missing from the template; `mise run state` reports it
    }
  }
  return plugins.sort((a, b) => a.name.localeCompare(b.name));
}

export function makeVault(name, root) {
  return {
    name,
    root,
    pluginsDir: join(root, '.obsidian', 'plugins'),
    communityPluginsPath: join(root, '.obsidian', 'community-plugins.json'),
  };
}

export async function discoverVaults() {
  const siblings = await readdir(OBSIDIAN_ROOT, { withFileTypes: true });
  const vaults = [];
  for (const entry of siblings) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    if (entry.name === 'obsidian-template') continue;
    const root = join(OBSIDIAN_ROOT, entry.name);
    if (await pathExists(join(root, '.obsidian', 'plugins'))) {
      vaults.push(makeVault(entry.name, root));
    }
  }
  return vaults;
}

const MANUAL_SENTINEL = '__manual__';

// Prompts for target vaults. Returns the selected vault objects.
// With createMissing, a manually entered path without .obsidian/ is initialised (sync); otherwise it must exist (compare).
export async function selectVaults({ vaults, defaults = [], createMissing = false }) {
  const selectedNames = await p.multiselect({
    message: 'Select target vaults',
    options: [
      ...vaults.map((v) => ({ value: v.name, label: v.name })),
      { value: MANUAL_SENTINEL, label: 'Other (specify path)...' },
    ],
    initialValues: defaults,
    required: true,
  });
  if (p.isCancel(selectedNames)) cancel();

  const all = [...vaults];
  if (selectedNames.includes(MANUAL_SENTINEL)) {
    const manualPath = await p.text({
      message: 'Enter the path to the vault directory',
      placeholder: '/path/to/vault',
      validate: (value) => {
        if (!value.trim()) return 'Path cannot be empty.';
      },
    });
    if (p.isCancel(manualPath)) cancel();

    const resolvedPath = resolve(manualPath.trim());
    if (!(await pathExists(join(resolvedPath, '.obsidian')))) {
      if (!createMissing) {
        p.log.error(`No .obsidian/ folder in ${resolvedPath}`);
        process.exit(1);
      }
      await mkdir(join(resolvedPath, '.obsidian', 'plugins'), { recursive: true });
      p.log.info(`Initialized .obsidian/ in ${resolvedPath}`);
    }
    const vaultName = resolvedPath.split('/').at(-1);
    all.push(makeVault(vaultName, resolvedPath));
    selectedNames.splice(selectedNames.indexOf(MANUAL_SENTINEL), 1, vaultName);
  }

  return all.filter((v) => selectedNames.includes(v.name));
}

// Template version: derived from the git tag, falling back to package.json outside a checkout.
export async function getTemplateVersion() {
  try {
    return execFileSync('git', ['describe', '--tags', '--always', '--dirty'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    try {
      return `v${JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8')).version}`;
    } catch {
      return 'unknown';
    }
  }
}

export function describeResult(r) {
  const { differs, missing, extra } = r.files;
  const parts = [];
  if (r.kind === 'plugin' && r.vaultVersion && r.templateVersion && r.vaultVersion !== r.templateVersion) {
    parts.push(`v${r.vaultVersion} -> v${r.templateVersion}`);
  }
  if (r.status === 'outdated' || r.status === 'partial') {
    if (differs.length > 0) parts.push(`${differs.length} differ`);
    if (missing.length > 0) parts.push(`${missing.length} missing`);
  }
  if (r.status === 'in sync' && extra.length > 0) parts.push(`+${extra.length} vault-only`);
  return parts.join(', ');
}

const KIND_LABELS = { plugin: 'plugins', dir: 'dirs', setting: 'settings' };

// Plain-text report for one vault. With verbose, lists the files behind each non-matching status.
export function renderReport(vault, templateVersion, results, { verbose = false } = {}) {
  const lines = [`vault: ${vault.name}   (template ${templateVersion})`];
  const width = Math.max(...results.map((r) => r.label.length), 10);
  for (const kind of Object.keys(KIND_LABELS)) {
    const group = results.filter((r) => r.kind === kind);
    group.forEach((r, i) => {
      const heading = i === 0 ? KIND_LABELS[kind] : '';
      const detail = describeResult(r);
      lines.push(`  ${heading.padEnd(9)} ${r.label.padEnd(width)}  ${r.status}${detail ? `   (${detail})` : ''}`);
      if (verbose && r.status !== 'not synced') {
        for (const status of ['differs', 'missing', 'extra']) {
          for (const file of r.files[status]) lines.push(`${' '.repeat(13)}${status}: ${file || r.id}`);
        }
      }
    });
  }
  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const summary = ['in sync', 'outdated', 'partial', 'not synced']
    .filter((s) => counts[s])
    .map((s) => `${counts[s]} ${s}`)
    .join(', ');
  lines.push(`Summary: ${summary || 'nothing to compare'}`);
  return lines.join('\n');
}

function findResult(results, kind, id) {
  return results.find((r) => r.kind === kind && r.id.toLowerCase() === id.toLowerCase());
}

// One-line comparison hint for a wizard option, aggregated over the selected vaults.
// reports: [{ vault, results }]
export function statusHint(reports, kind, id) {
  const found = reports.map(({ results }) => findResult(results, kind, id)).filter(Boolean);
  if (found.length === 0) return '';
  if (found.length === 1) {
    const detail = describeResult(found[0]);
    return `${found[0].status}${detail ? ` (${detail})` : ''}`;
  }
  const inSync = found.filter((r) => r.status === 'in sync').length;
  if (inSync === found.length) return 'in sync';
  if (found.every((r) => r.status === found[0].status)) return found[0].status;
  return `in sync in ${inSync}/${found.length} vaults`;
}

function wrapList(prefix, names, width = 76) {
  const lines = [];
  let line = prefix;
  names.forEach((name, i) => {
    const piece = i === names.length - 1 ? name : `${name},`;
    if (line.length + piece.length + 1 > width && line.trim() !== prefix.trim()) {
      lines.push(line);
      line = ' '.repeat(prefix.length);
    }
    line += (line.endsWith(' ') ? '' : ' ') + piece;
  });
  lines.push(line);
  return lines.join('\n');
}

// "Currently in sync" lines per vault, for the sync wizard.
export function renderInSyncNote(reports) {
  return reports
    .map(({ vault, results }) => {
      const inSync = results.filter((r) => r.status === 'in sync');
      if (inSync.length === 0) return `${vault.name}: nothing in sync yet`;
      const parts = Object.entries(KIND_LABELS)
        .map(([kind, label]) => {
          const names = inSync.filter((r) => r.kind === kind).map((r) => r.label);
          return names.length > 0 ? wrapList(`  ${label}:`, names) : null;
        })
        .filter(Boolean);
      return `${vault.name}: ${inSync.length}/${results.length} items in sync\n${parts.join('\n')}`;
    })
    .join('\n\n');
}
