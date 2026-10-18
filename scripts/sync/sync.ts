import * as p from '@clack/prompts';
import { readdir, readFile, writeFile, mkdir, copyFile } from 'fs/promises';
import { join } from 'path';
import {
  TEMPLATE_DIR,
  TEMPLATE_PLUGINS_DIR,
  TEMPLATE_OBSIDIAN_DIR,
  DATA_FILES,
  PLUGIN_DIR_CONDITIONS,
  DIR_OPTIONS,
  SETTINGS_ITEMS,
  pathExists,
  copyRecursive,
  copyAny,
  cancel,
  multiselectWithToggle,
  loadConfig,
  discoverPlugins,
  discoverVaults,
  selectVaults,
  getTemplateVersion,
  statusHint,
  renderInSyncNote,
  renderReport,
} from '../lib/cli.ts';
import { compareVault, compareItem, listItems } from '../lib/compare.ts';
import type { VaultReport } from '../lib/types.ts';

async function main() {
  // Step 1: Load config
  const config = await loadConfig();

  // Step 2: Intro
  const templateVersion = await getTemplateVersion();
  p.intro(`  sync  —  Obsidian Template Vault  (template ${templateVersion})`);

  // Step 3: Discover plugins and target vaults
  const plugins = await discoverPlugins();
  const vaults = await discoverVaults();

  if (vaults.length === 0) {
    p.outro('No target vaults found.');
    process.exit(0);
  }

  // Step 4: Vault selection
  const selectedVaults = await selectVaults({
    vaults,
    defaults: config.defaultVaults ?? [],
    createMissing: true,
  });

  // Step 5: Compare the template with each selected vault
  const items = await listItems();
  const cs = p.spinner();
  cs.start('Comparing template with selected vaults...');
  const reports: VaultReport[] = [];
  for (const vault of selectedVaults) {
    reports.push({ vault, results: await compareVault(vault, items) });
  }
  cs.stop('Comparison complete.');
  p.note(renderInSyncNote(reports), 'Currently in sync');

  // Step 6: Plugin multiselect
  const selectedPluginIds = await multiselectWithToggle({
    message: 'Select plugins to sync',
    options: plugins.map((plugin) => ({
      value: plugin.id,
      label: plugin.name,
      hint: `v${plugin.version} · ${statusHint(reports, 'plugin', plugin.id)}`,
    })),
    initialValues: config.defaultPlugins ?? [],
    required: true,
  });
  if (p.isCancel(selectedPluginIds)) cancel();

  // Step 6b: Directory sync selection
  const autoDirs = PLUGIN_DIR_CONDITIONS
    .filter((c) => selectedPluginIds.includes(c.pluginId))
    .map((c) => c.dir);

  if (autoDirs.length > 0) {
    p.log.info(
      `Auto-included directories (based on plugin selection):\n${autoDirs.map((d) => `  ${d}`).join('\n')}`
    );
  }

  const selectedDirs = await p.multiselect({
    message: 'Select content directories to sync  (a = toggle all)',
    options: DIR_OPTIONS.map((dir) => ({ value: dir, label: dir, hint: statusHint(reports, 'dir', dir) })),
    initialValues: config.defaultDirs ?? ['--Attachments--', '--Configurations--/Obsidian Template', 'Bases', 'Notes'],
    required: false,
  });
  if (p.isCancel(selectedDirs)) cancel();

  const finalDirs = [...new Set([...(selectedDirs ?? []), ...autoDirs])];

  // Step 6c: Obsidian settings sync selection
  const selectedSettings = await multiselectWithToggle({
    message: 'Select Obsidian settings to sync',
    options: SETTINGS_ITEMS.map((item) => ({
      value: item,
      label: item,
      hint: `${item.endsWith('.json') ? 'file' : 'directory'} · ${statusHint(reports, 'setting', item)}`,
    })),
    initialValues: config.defaultSettings ?? [],
  });
  if (p.isCancel(selectedSettings)) cancel();

  // Step 7: data.json opt-in
  let syncDataJson = config.syncDataJson ?? false;
  if (!syncDataJson) {
    const answer = await p.confirm({
      message: 'Overwrite existing data.json if it exists (plugin settings)?',
      initialValue: false,
    });
    if (p.isCancel(answer)) cancel();
    syncDataJson = answer;
  }

  // Step 8: Build sync plan
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
        if (!entry.isFile()) continue;
        if (!syncDataJson && DATA_FILES.has(entry.name)) {
          const destExists = await pathExists(join(destDir, entry.name));
          if (destExists) {
            filesToSkip.push(entry.name);
          } else {
            filesToCopy.push(entry.name);
          }
        } else {
          filesToCopy.push(entry.name);
        }
      }

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

  if (finalDirs.length > 0) {
    const userDirs = finalDirs.filter((d) => !autoDirs.includes(d));
    const parts = [];
    if (userDirs.length > 0) parts.push(userDirs.join(', '));
    if (autoDirs.length > 0) parts.push(`+auto: ${autoDirs.join(', ')}`);
    p.log.info(`Directories: ${parts.join('  ')}`);
  }

  if ((selectedSettings ?? []).length > 0) {
    p.log.info(`Settings:    ${selectedSettings.join(', ')}`);
  }

  const proceed = await p.confirm({ message: 'Proceed with sync?', initialValue: true });
  if (p.isCancel(proceed) || !proceed) cancel();

  // Step 10: Execute sync
  const s = p.spinner();
  s.start('Syncing...');

  const communityPluginUpdates = new Map();

  // Sync plugins
  for (const entry of plan) {
    s.message(`Syncing plugin ${entry.plugin.name} → ${entry.vault.name}`);
    await mkdir(entry.destDir, { recursive: true });

    for (const file of entry.filesToCopy) {
      await copyFile(join(entry.srcDir, file), join(entry.destDir, file));
    }

    for (const subDir of entry.subDirs) {
      await copyRecursive(join(entry.srcDir, subDir), join(entry.destDir, subDir));
    }

    if (entry.addToCommunityPlugins) {
      const key = entry.vault.name;
      const current = communityPluginUpdates.get(key) ?? [...entry.existingCommunityPlugins];
      if (!current.includes(entry.plugin.id)) current.push(entry.plugin.id);
      communityPluginUpdates.set(key, current);
    }
  }

  for (const vault of selectedVaults) {
    const updated = communityPluginUpdates.get(vault.name);
    if (updated) {
      await writeFile(vault.communityPluginsPath, JSON.stringify(updated, null, 2));
    }
  }

  // Sync content directories
  for (const vault of selectedVaults) {
    for (const dir of finalDirs) {
      const src = join(TEMPLATE_DIR, dir);
      const dest = join(vault.root, dir);
      if (await pathExists(src)) {
        s.message(`Syncing directory ${dir} → ${vault.name}`);
        await copyRecursive(src, dest);
      }
    }
  }

  // Sync Obsidian settings
  for (const vault of selectedVaults) {
    for (const item of (selectedSettings ?? [])) {
      const src = join(TEMPLATE_OBSIDIAN_DIR, item);
      const dest = join(vault.root, '.obsidian', item);
      if (await pathExists(src)) {
        s.message(`Syncing .obsidian/${item} → ${vault.name}`);
        await copyAny(src, dest);
      }
    }
  }

  s.stop('Sync complete.');

  // Verify: the synced items should now match the template
  const synced = items.filter(
    (item) =>
      (item.kind === 'plugin' && selectedPluginIds.includes(item.id)) ||
      (item.kind === 'dir' && finalDirs.some((d) => d.toLowerCase() === item.id.toLowerCase())) ||
      (item.kind === 'setting' && (selectedSettings ?? []).includes(item.id))
  );
  for (const vault of selectedVaults) {
    const results = [];
    for (const item of synced) results.push(await compareItem(vault, item));
    const notMatching = results.filter((r) => r.status !== 'in sync');
    if (notMatching.length === 0) {
      p.log.success(`${vault.name}: all ${results.length} synced item(s) now match the template.`);
    } else {
      p.log.warn(renderReport(vault, templateVersion, notMatching));
    }
  }

  // Step 11: Outro
  p.outro(
    `Done! Synced ${selectedPlugins.length} plugin(s), ${finalDirs.length} director${finalDirs.length === 1 ? 'y' : 'ies'}, and ${(selectedSettings ?? []).length} setting(s) across ${selectedVaults.length} vault(s). Template ${templateVersion}.`
  );
}

main().catch((err) => {
  p.log.error(String(err));
  process.exit(1);
});
