import * as p from '@clack/prompts';
import {
  PLUGIN_DIR_CONDITIONS,
  DIR_OPTIONS,
  SETTINGS_ITEMS,
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
import { listItems } from '../lib/compare.ts';
import { executeSync, buildSyncPlan } from '../lib/sync.ts';
import type { VaultReport } from '../lib/types.ts';

function parseArgs() {
  const args = process.argv.slice(2);
  const flags = new Set<string>();
  const flagValues = new Set<string>();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg && arg.startsWith('--')) {
      flags.add(arg);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flagValues.add(next);
      }
    }
  }

  function value(flag: string): string | undefined {
    const i = args.indexOf(flag);
    const next = i >= 0 ? args[i + 1] : undefined;
    return next && !next.startsWith('--') ? next : undefined;
  }

  function list(flag: string): string[] | undefined {
    const v = value(flag);
    return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  }

  return {
    nonInteractive: flags.has('--non-interactive'),
    vaults: list('--vaults'),
    plugins: list('--plugins'),
    dirs: list('--dirs'),
    settings: list('--settings'),
    dataJson: flags.has('--data-json'),
    json: flags.has('--json'),
    dryRun: flags.has('--dry-run'),
  };
}

async function main() {
  const args = parseArgs();
  const config = await loadConfig();
  const templateVersion = await getTemplateVersion();

  const plugins = await discoverPlugins();
  const vaults = await discoverVaults();

  if (vaults.length === 0) {
    console.error('No target vaults found.');
    process.exit(1);
  }

  let selectedVaults;
  let selectedPluginIds: string[];
  let selectedDirs: string[];
  let selectedSettings: string[];
  let syncDataJson: boolean;

  if (args.nonInteractive) {
    // Non-interactive mode: resolve from args and config
    if (args.vaults) {
      selectedVaults = [];
      for (const name of args.vaults) {
        const found = vaults.find((v) => v.name === name);
        if (found) {
          selectedVaults.push(found);
        } else {
          console.error(`Vault not found: ${name}`);
          process.exit(1);
        }
      }
    } else if (config.defaultVaults && config.defaultVaults.length > 0) {
      selectedVaults = vaults.filter((v) => config.defaultVaults!.includes(v.name));
    } else {
      selectedVaults = vaults;
    }

    if (args.plugins) {
      selectedPluginIds = args.plugins;
      const unknown = selectedPluginIds.filter((id) => !plugins.find((p) => p.id === id));
      if (unknown.length > 0) {
        console.error(`Unknown plugin(s): ${unknown.join(', ')}`);
        process.exit(1);
      }
    } else {
      selectedPluginIds = config.defaultPlugins ?? [];
    }

    if (args.dirs) {
      selectedDirs = args.dirs;
    } else {
      selectedDirs = config.defaultDirs ?? ['--Attachments--', '--Configurations--/Obsidian Template', 'Bases', 'Notes'];
    }

    if (args.settings) {
      selectedSettings = args.settings;
    } else {
      selectedSettings = config.defaultSettings ?? [];
    }

    syncDataJson = args.dataJson || (config.syncDataJson ?? false);
  } else {
    // Interactive mode
    p.intro(`  sync  —  Obsidian Template Vault  (template ${templateVersion})`);

    selectedVaults = await selectVaults({
      vaults,
      defaults: config.defaultVaults ?? [],
      createMissing: true,
    });

    const items = await listItems();
    const cs = p.spinner();
    cs.start('Comparing template with selected vaults...');
    const reports: VaultReport[] = [];
    for (const vault of selectedVaults) {
      reports.push({ vault, results: await listItems().then(() => []) }); // placeholder, will recompare
    }
    // Actually compare properly
    const { compareVault } = await import('../lib/compare.ts');
    for (const vault of selectedVaults) {
      reports.push({ vault, results: await compareVault(vault, items) });
    }
    cs.stop('Comparison complete.');
    p.note(renderInSyncNote(reports), 'Currently in sync');

    const pluginResult = await multiselectWithToggle({
      message: 'Select plugins to sync',
      options: plugins.map((plugin) => ({
        value: plugin.id,
        label: plugin.name,
        hint: `v${plugin.version} · ${statusHint(reports, 'plugin', plugin.id)}`,
      })),
      initialValues: config.defaultPlugins ?? [],
      required: true,
    });
    if (p.isCancel(pluginResult)) cancel();
    selectedPluginIds = pluginResult;

    const autoDirs = PLUGIN_DIR_CONDITIONS
      .filter((c) => selectedPluginIds.includes(c.pluginId))
      .map((c) => c.dir);

    if (autoDirs.length > 0) {
      p.log.info(
        `Auto-included directories (based on plugin selection):\n${autoDirs.map((d) => `  ${d}`).join('\n')}`
      );
    }

    const dirResult = await p.multiselect({
      message: 'Select content directories to sync  (a = toggle all)',
      options: DIR_OPTIONS.map((dir) => ({ value: dir, label: dir, hint: statusHint(reports, 'dir', dir) })),
      initialValues: config.defaultDirs ?? ['--Attachments--', '--Configurations--/Obsidian Template', 'Bases', 'Notes'],
      required: false,
    });
    if (p.isCancel(dirResult)) cancel();
    selectedDirs = dirResult ?? [];

    const settingResult = await multiselectWithToggle({
      message: 'Select Obsidian settings to sync',
      options: SETTINGS_ITEMS.map((item) => ({
        value: item,
        label: item,
        hint: `${item.endsWith('.json') ? 'file' : 'directory'} · ${statusHint(reports, 'setting', item)}`,
      })),
      initialValues: config.defaultSettings ?? [],
    });
    if (p.isCancel(settingResult)) cancel();
    selectedSettings = settingResult ?? [];

    syncDataJson = config.syncDataJson ?? false;
    if (!syncDataJson) {
      const answer = await p.confirm({
        message: 'Overwrite existing data.json if it exists (plugin settings)?',
        initialValue: false,
      });
      if (p.isCancel(answer)) cancel();
      syncDataJson = answer;
    }

    // Merge auto-dirs
    const finalDirsInteractive = [...new Set([...(selectedDirs ?? []), ...autoDirs])];

    // Build plan for display
    const plan = await buildSyncPlan({
      vaults: selectedVaults,
      plugins,
      pluginIds: selectedPluginIds,
      dirs: finalDirsInteractive,
      settings: selectedSettings ?? [],
      syncDataJson,
    });

    p.log.info(`Will sync ${selectedPluginIds.length} plugin(s) to ${selectedVaults.length} vault(s):\n`);

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

    if (finalDirsInteractive.length > 0) {
      const userDirs = finalDirsInteractive.filter((d) => !autoDirs.includes(d));
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

    // Use finalDirsInteractive for the rest of the flow
    selectedDirs = finalDirsInteractive;
  }

  const autoDirs = PLUGIN_DIR_CONDITIONS
    .filter((c) => selectedPluginIds.includes(c.pluginId))
    .map((c) => c.dir);
  const finalDirs = [...new Set([...selectedDirs, ...autoDirs])];

  const selectedPlugins = plugins.filter((pl) => selectedPluginIds.includes(pl.id));

  if (args.dryRun) {
    const plan = await buildSyncPlan({
      vaults: selectedVaults,
      plugins,
      pluginIds: selectedPluginIds,
      dirs: finalDirs,
      settings: selectedSettings ?? [],
      syncDataJson,
    });
    const output = {
      templateVersion,
      vaults: selectedVaults.map((v) => v.name),
      plugins: selectedPlugins.map((p) => ({ id: p.id, name: p.name, version: p.version })),
      directories: finalDirs,
      settings: selectedSettings ?? [],
      syncDataJson,
      plan: plan.map((e) => ({
        vault: e.vault.name,
        plugin: e.plugin.id,
        filesToCopy: e.filesToCopy,
        filesToSkip: e.filesToSkip,
        subDirs: e.subDirs,
        addToCommunityPlugins: e.addToCommunityPlugins,
      })),
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  const s = p.spinner?.() ?? { start: () => {}, stop: () => {}, message: () => {} };
  if (!args.nonInteractive) s.start('Syncing...');

  const result = await executeSync({
    vaults: selectedVaults,
    plugins,
    pluginIds: selectedPluginIds,
    dirs: finalDirs,
    settings: selectedSettings ?? [],
    syncDataJson,
  });

  if (!args.nonInteractive) s.stop('Sync complete.');

  // Output results
  if (args.json) {
    console.log(JSON.stringify({
      templateVersion,
      preSync: result.preReports.map((r) => ({
        vault: r.vault.name,
        inSync: r.inSync,
        total: r.total,
      })),
      postSync: result.postReports.map(({ vault, results }) => ({
        vault: vault.name,
        allMatch: results.every((r) => r.status === 'in sync'),
        items: results.map(({ kind, id, label, status, templateVersion, vaultVersion, files }) => ({
          kind,
          id,
          label,
          status,
          templateVersion,
          vaultVersion,
          files: { match: files.match, differs: files.differs, missing: files.missing, extra: files.extra },
        })),
      })),
    }, null, 2));
  } else {
    if (args.nonInteractive) {
      console.log(`Synced ${selectedPlugins.length} plugin(s), ${finalDirs.length} director${finalDirs.length === 1 ? 'y' : 'ies'}, and ${(selectedSettings ?? []).length} setting(s) across ${selectedVaults.length} vault(s).`);
    }
    for (const { vault, results } of result.postReports) {
      const notMatching = results.filter((r) => r.status !== 'in sync');
      if (notMatching.length === 0) {
        const msg = `${vault.name}: all ${results.length} synced item(s) now match the template.`;
        if (args.nonInteractive) {
          console.log(`  ✓ ${msg}`);
        } else {
          p.log.success(msg);
        }
      } else {
        if (args.nonInteractive) {
          console.log(`  ✗ ${vault.name}: ${notMatching.length} item(s) still not in sync:`);
          for (const r of notMatching) {
            console.log(`      ${r.kind} ${r.label}: ${r.status}`);
          }
        } else {
          p.log.warn(renderReport(vault, templateVersion, notMatching));
        }
      }
    }
  }

  if (!args.nonInteractive) {
    p.outro(
      `Done! Synced ${selectedPlugins.length} plugin(s), ${finalDirs.length} director${finalDirs.length === 1 ? 'y' : 'ies'}, and ${(selectedSettings ?? []).length} setting(s) across ${selectedVaults.length} vault(s). Template ${templateVersion}.`
    );
  }
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
