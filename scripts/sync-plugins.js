import * as p from '@clack/prompts';
import { readdir, readFile, writeFile, mkdir, copyFile, stat } from 'fs/promises';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE_PLUGINS_DIR = join(REPO_ROOT, 'template', '.obsidian', 'plugins');
const OBSIDIAN_ROOT = dirname(REPO_ROOT);
const CONFIG_PATH = join(REPO_ROOT, 'sync-plugins.config.json');
const DATA_FILES = new Set(['data.json', 'genericPreviewCache.json']);

async function pathExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function copyRecursive(src, dest) {
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

function cancel(msg = 'Cancelled.') {
  p.cancel(msg);
  process.exit(0);
}

async function main() {
  // Step 1: Load config
  let config = {};
  try {
    config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  } catch {
    // No config file — fully interactive mode
  }

  // Step 2: Intro
  p.intro('  sync-plugins  —  Obsidian Template Vault');

  // Step 3: Discover plugins
  const pluginDirs = await readdir(TEMPLATE_PLUGINS_DIR);
  const plugins = [];
  for (const dir of pluginDirs) {
    try {
      const manifest = JSON.parse(
        await readFile(join(TEMPLATE_PLUGINS_DIR, dir, 'manifest.json'), 'utf8')
      );
      plugins.push({ id: dir, name: manifest.name, version: manifest.version });
    } catch {
      // Skip dirs without a valid manifest
    }
  }
  plugins.sort((a, b) => a.name.localeCompare(b.name));

  // Step 4: Plugin multiselect
  const selectedPluginIds = await p.multiselect({
    message: 'Select plugins to sync',
    options: plugins.map((plugin) => ({
      value: plugin.id,
      label: plugin.name,
      hint: `v${plugin.version}`,
    })),
    initialValues: config.defaultPlugins ?? [],
    required: true,
  });
  if (p.isCancel(selectedPluginIds)) cancel();

  // Step 5: Discover target vaults
  const siblings = await readdir(OBSIDIAN_ROOT, { withFileTypes: true });
  const vaults = [];
  for (const entry of siblings) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    if (entry.name === 'obsidian-template') continue;
    const pluginsDir = join(OBSIDIAN_ROOT, entry.name, '.obsidian', 'plugins');
    if (await pathExists(pluginsDir)) {
      vaults.push({
        name: entry.name,
        pluginsDir,
        communityPluginsPath: join(OBSIDIAN_ROOT, entry.name, '.obsidian', 'community-plugins.json'),
      });
    }
  }

  if (vaults.length === 0) {
    p.outro('No target vaults found.');
    process.exit(0);
  }

  // Step 6: Vault multiselect
  const MANUAL_SENTINEL = '__manual__';
  const selectedVaultNames = await p.multiselect({
    message: 'Select target vaults',
    options: [
      ...vaults.map((v) => ({ value: v.name, label: v.name })),
      { value: MANUAL_SENTINEL, label: 'Other (specify path)...' },
    ],
    initialValues: config.defaultVaults ?? [],
    required: true,
  });
  if (p.isCancel(selectedVaultNames)) cancel();

  // If user selected "Other", prompt for a directory path
  if (selectedVaultNames.includes(MANUAL_SENTINEL)) {
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
      p.cancel('No .obsidian folder found at that path. Is this an Obsidian vault?');
      process.exit(1);
    }
    const vaultName = resolvedPath.split('/').at(-1);
    const pluginsDir = join(resolvedPath, '.obsidian', 'plugins');
    vaults.push({
      name: vaultName,
      pluginsDir,
      communityPluginsPath: join(resolvedPath, '.obsidian', 'community-plugins.json'),
    });
    // Replace sentinel with the resolved vault name
    selectedVaultNames.splice(selectedVaultNames.indexOf(MANUAL_SENTINEL), 1, vaultName);
  }

  // Step 7: data.json opt-in
  let syncDataJson = config.syncDataJson ?? false;
  if (!syncDataJson) {
    const answer = await p.confirm({
      message: 'Also overwrite data.json (plugin settings)?',
      initialValue: false,
    });
    if (p.isCancel(answer)) cancel();
    syncDataJson = answer;
  }

  // Step 8: Build sync plan
  const selectedVaults = vaults.filter((v) => selectedVaultNames.includes(v.name));
  const selectedPlugins = plugins.filter((pl) => selectedPluginIds.includes(pl.id));

  const plan = [];
  for (const vault of selectedVaults) {
    let existingCommunityPlugins = [];
    try {
      existingCommunityPlugins = JSON.parse(
        await readFile(vault.communityPluginsPath, 'utf8')
      );
    } catch {
      // Missing community-plugins.json — start fresh
    }

    for (const plugin of selectedPlugins) {
      const srcDir = join(TEMPLATE_PLUGINS_DIR, plugin.id);
      const destDir = join(vault.pluginsDir, plugin.id);
      const allFiles = await readdir(srcDir, { withFileTypes: true });

      const filesToCopy = [];
      const filesToSkip = [];
      for (const entry of allFiles) {
        if (!entry.isFile()) continue; // directories handled by copyRecursive
        if (!syncDataJson && DATA_FILES.has(entry.name)) {
          filesToSkip.push(entry.name);
        } else {
          filesToCopy.push(entry.name);
        }
      }

      // Check for subdirectories (e.g. icons/ in obsidian-icon-folder)
      const subDirs = allFiles.filter((e) => e.isDirectory()).map((e) => e.name);

      plan.push({
        plugin,
        vault,
        srcDir,
        destDir,
        filesToCopy,
        filesToSkip,
        subDirs,
        addToCommunityPlugins: !existingCommunityPlugins.includes(plugin.id),
        existingCommunityPlugins,
      });
    }
  }

  // Step 9: Summary + confirmation
  p.log.info(`Will sync ${selectedPlugins.length} plugin(s) to ${selectedVaults.length} vault(s):\n`);

  for (const vault of selectedVaults) {
    const vaultPlan = plan.filter((e) => e.vault.name === vault.name);
    const toAdd = vaultPlan.filter((e) => e.addToCommunityPlugins).map((e) => e.plugin.id);
    const lines = vaultPlan.map((e) => {
      const fileCount = e.filesToCopy.length + e.subDirs.length;
      const skipped = e.filesToSkip.length > 0 ? `, skip ${e.filesToSkip.join(', ')}` : '';
      return `  ${e.plugin.name} (${fileCount} item(s)${skipped})`;
    });
    p.log.info(`→ ${vault.name}:\n${lines.join('\n')}`);
    if (toAdd.length > 0) {
      p.log.info(`  community-plugins.json: will add [${toAdd.join(', ')}]`);
    }
  }

  const proceed = await p.confirm({ message: 'Proceed with sync?', initialValue: true });
  if (p.isCancel(proceed) || !proceed) cancel();

  // Step 10: Execute sync
  const s = p.spinner();
  s.start('Syncing plugins...');

  let totalFiles = 0;
  const communityPluginUpdates = new Map(); // vault name → updated array

  for (const entry of plan) {
    s.message(`Syncing ${entry.plugin.name} → ${entry.vault.name}`);
    await mkdir(entry.destDir, { recursive: true });

    // Copy top-level files
    for (const file of entry.filesToCopy) {
      await copyFile(join(entry.srcDir, file), join(entry.destDir, file));
      totalFiles++;
    }

    // Copy subdirectories recursively
    for (const subDir of entry.subDirs) {
      await copyRecursive(join(entry.srcDir, subDir), join(entry.destDir, subDir));
      totalFiles++;
    }

    // Track community-plugins.json updates
    if (entry.addToCommunityPlugins) {
      const key = entry.vault.name;
      const current = communityPluginUpdates.get(key) ?? [...entry.existingCommunityPlugins];
      if (!current.includes(entry.plugin.id)) current.push(entry.plugin.id);
      communityPluginUpdates.set(key, current);
    }
  }

  // Write community-plugins.json updates
  for (const vault of selectedVaults) {
    const updated = communityPluginUpdates.get(vault.name);
    if (updated) {
      await writeFile(vault.communityPluginsPath, JSON.stringify(updated, null, 2));
    }
  }

  s.stop('Sync complete.');

  // Step 11: Outro
  p.outro(
    `Done! Synced ${selectedPlugins.length} plugin(s) across ${selectedVaults.length} vault(s).`
  );
}

main().catch((err) => {
  p.log.error(String(err));
  process.exit(1);
});
