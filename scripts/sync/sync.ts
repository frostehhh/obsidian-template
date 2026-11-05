import * as p from '@clack/prompts';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import {
  PLUGIN_DIR_CONDITIONS,
  DIR_OPTIONS,
  SETTINGS_ITEMS,
  cancel,
  multiselectWithToggle,
  loadConfig,
  loadVaultConfig,
  discoverPlugins,
  discoverVaults,
  selectVaults,
  parseConflictPolicy,
  statusHint,
  renderInSyncNote,
  renderReport,
} from '../lib/cli.ts';
import { resolveSource, gitSource } from '../lib/source.ts';
import { loadPolicy } from '../lib/policy.ts';
import { writePlanFile, applyPlanFile, appliedToJson, renderApplied, summarizePlan } from '../lib/planfile.ts';
import type { PlannedVault } from '../lib/planfile.ts';
import { executeSync, buildSyncPlan, buildVaultExtras, conflictLabel, describePlan, resolveVaultConfig } from '../lib/sync.ts';
import type { Vault, VaultReport } from '../lib/types.ts';

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
    from: value('--from'),
    assume: value('--assume'),
    onConflict: parseConflictPolicy(value('--on-conflict')),
    plan: value('--plan'),
    apply: value('--apply'),
    ignorePin: flags.has('--ignore-pin'),
  };
}

async function main() {
  const args = parseArgs();

  // --apply <file>: run a saved plan exactly as written; refuses if anything changed since it was made.
  if (args.apply) {
    const applied = await applyPlanFile(args.apply, args.onConflict);
    console.log(args.json ? JSON.stringify(appliedToJson(applied), null, 2) : renderApplied(applied));
    if (applied.some((a) => a.conflicts.length > 0)) process.exitCode = 1;
    return;
  }

  const config = await loadConfig();
  const source = resolveSource(args.from);
  // A pin keeps a vault within a version range, so each vault can have its own source.
  const sourceOf = async (vault: Vault) =>
    resolveSource(args.from, (await loadPolicy(vault)).pin, { ignorePin: args.ignorePin });
  const assume = args.assume ? gitSource(args.assume) : undefined;
  const templateVersion = source.label;

  const plugins = await discoverPlugins(source);
  const vaults = await discoverVaults();

  if (vaults.length === 0) {
    console.error('No target vaults found.');
    process.exit(1);
  }

  let selectedVaults;
  let vaultPlans: Array<{
    vault: Vault;
    pluginIds: string[];
    dirs: string[];
    settings: string[];
    syncDataJson: boolean;
  }> = [];

  if (args.nonInteractive) {
    // Non-interactive mode: resolve from args, vault-level config, and repo config
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
  } else {
    // Interactive mode — prompts per vault so vault-level config can be used as defaults
    p.intro(`  sync  —  Obsidian Template Vault  (template ${templateVersion})`);

    selectedVaults = await selectVaults({
      vaults,
      defaults: config.defaultVaults ?? [],
      createMissing: true,
    });

    const cs = p.spinner();
    cs.start('Comparing template with selected vaults...');
    const reports: VaultReport[] = [];
    const { compareVault } = await import('../lib/compare.ts');
    for (const vault of selectedVaults) {
      reports.push({ vault, results: await compareVault(vault, await sourceOf(vault)) });
    }
    cs.stop('Comparison complete.');
    p.note(renderInSyncNote(reports), 'Currently in sync');

    // Prompt per vault
    const vaultSelections: Array<{
      vault: (typeof selectedVaults)[number];
      pluginIds: string[];
      dirs: string[];
      settings: string[];
      syncDataJson: boolean;
    }> = [];

    for (const vault of selectedVaults) {
      p.log.info(`\n--- Configuring sync for ${vault.name} ---`);

      const vaultConfig = await loadVaultConfig(vault.root);
      const defaults = resolveVaultConfig(vaultConfig, config, {});

      const pluginResult = await multiselectWithToggle({
        message: `  Select plugins for ${vault.name}`,
        options: plugins.map((plugin) => ({
          value: plugin.id,
          label: plugin.name,
          hint: `v${plugin.version} · ${statusHint(reports, 'plugin', plugin.id)}`,
        })),
        initialValues: defaults.pluginIds,
        required: true,
      });
      if (p.isCancel(pluginResult)) cancel();

      const vaultAutoDirs = PLUGIN_DIR_CONDITIONS
        .filter((c) => pluginResult.includes(c.pluginId))
        .map((c) => c.dir);

      if (vaultAutoDirs.length > 0) {
        p.log.info(
          `  Auto-included directories: ${vaultAutoDirs.join(', ')}`
        );
      }

      const dirResult = await p.multiselect({
        message: `  Select directories for ${vault.name}`,
        options: DIR_OPTIONS.map((dir) => ({ value: dir, label: dir, hint: statusHint(reports, 'dir', dir) })),
        initialValues: defaults.dirs,
        required: false,
      });
      if (p.isCancel(dirResult)) cancel();

      const settingResult = await multiselectWithToggle({
        message: `  Select settings for ${vault.name}`,
        options: SETTINGS_ITEMS.map((item) => ({
          value: item,
          label: item,
          hint: `${item.endsWith('.json') ? 'file' : 'directory'} · ${statusHint(reports, 'setting', item)}`,
        })),
        initialValues: defaults.settings,
      });
      if (p.isCancel(settingResult)) cancel();

      let vaultSyncDataJson = defaults.syncDataJson;
      if (!vaultSyncDataJson) {
        const answer = await p.confirm({
          message: `  Overwrite data.json for ${vault.name}?`,
          initialValue: false,
        });
        if (p.isCancel(answer)) cancel();
        vaultSyncDataJson = answer;
      }

      const finalDirs = [...new Set([...(dirResult ?? []), ...vaultAutoDirs])];

      vaultSelections.push({
        vault,
        pluginIds: pluginResult,
        dirs: finalDirs,
        settings: settingResult ?? [],
        syncDataJson: vaultSyncDataJson,
      });
    }

    // Summary
    p.log.info(`\nWill sync to ${selectedVaults.length} vault(s):\n`);
    for (const { vault, pluginIds, dirs, settings } of vaultSelections) {
      p.log.info(`→ ${vault.name}:`);
      p.log.info(`  Plugins:     ${pluginIds.length > 0 ? pluginIds.join(', ') : 'none'}`);
      p.log.info(`  Directories: ${dirs.length > 0 ? dirs.join(', ') : 'none'}`);
      p.log.info(`  Settings:    ${settings.length > 0 ? settings.join(', ') : 'none'}`);
    }

    const proceed = await p.confirm({ message: 'Proceed with sync?', initialValue: true });
    if (p.isCancel(proceed) || !proceed) cancel();

    // Build vaultPlans from interactive selections
    vaultPlans = vaultSelections.map((vs) => ({
      vault: vs.vault,
      pluginIds: vs.pluginIds,
      dirs: vs.dirs,
      settings: vs.settings,
      syncDataJson: vs.syncDataJson,
    }));
  }

  if (args.nonInteractive) {
    vaultPlans = await Promise.all(selectedVaults.map(async (vault) => {
      const vaultConfig = await loadVaultConfig(vault.root);
      const resolved = resolveVaultConfig(vaultConfig, config, {
        plugins: args.plugins,
        dirs: args.dirs,
        settings: args.settings,
        dataJson: args.dataJson,
      });

      const unknown = resolved.pluginIds.filter((id) => !plugins.find((p) => p.id === id));
      if (unknown.length > 0) {
        console.error(`Vault ${vault.name}: unknown plugin(s): ${unknown.join(', ')}`);
        process.exit(1);
      }

      const autoDirs = PLUGIN_DIR_CONDITIONS
        .filter((c) => resolved.pluginIds.includes(c.pluginId))
        .map((c) => c.dir);
      const finalDirs = [...new Set([...resolved.dirs, ...autoDirs])];

      return { vault, ...resolved, dirs: finalDirs };
    }));
  }
  // Interactive mode: vaultPlans is already built inside the interactive block above

  if (args.dryRun || args.plan) {
    const planned: PlannedVault[] = [];
    const output = {
      templateVersion,
      vaults: [] as Array<{
        name: string;
        plugins: Array<{ id: string; name: string; version: string }>;
        directories: string[];
        settings: string[];
        syncDataJson: boolean;
        migrations: string[];
        patches: string[];
        plan: ReturnType<typeof describePlan>;
      }>,
    };

    for (const { vault, pluginIds, dirs, settings, syncDataJson: vaultSyncDataJson } of vaultPlans) {
      const selectedPlugins = plugins.filter((pl) => pluginIds.includes(pl.id));
      const vaultSource = await sourceOf(vault);
      const plan = await buildSyncPlan({
        vaults: [vault],
        plugins,
        pluginIds,
        dirs,
        settings,
        syncDataJson: vaultSyncDataJson,
        source: vaultSource,
        assume,
      });
      const extras = await buildVaultExtras(vault, vaultSource, assume);
      planned.push({ vault, source: vaultSource, plan, extras });
      output.vaults.push({
        migrations: extras.migrations,
        patches: Object.keys(extras.patches),
        name: vault.name,
        plugins: selectedPlugins.map((p) => ({ id: p.id, name: p.name, version: p.version })),
        directories: dirs,
        settings,
        syncDataJson: vaultSyncDataJson,
        plan: describePlan(plan),
      });
      if (!args.json && !args.nonInteractive) {
        p.log.info(`${vault.name} (template ${vaultSource.label}): ${summarizePlan(plan)}`);
      }
    }
    if (args.plan) {
      await writePlanFile(args.plan, planned);
      console.log(`Plan written to ${args.plan}. Apply it with: mise run sync -- --apply ${args.plan}`);
      for (const { vault, source: s, plan } of planned) console.log(`  ${vault.name} (template ${s.label}): ${summarizePlan(plan)}`);
      return;
    }
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  const s = p.spinner?.() ?? { start: () => {}, stop: () => {}, message: () => {} };
  if (!args.nonInteractive) s.start('Syncing...');

  const allPreReports = [];
  const allPostReports = [];
  const allConflicts = [];
  const allNotes: string[] = [];
  for (const { vault, pluginIds, dirs, settings, syncDataJson: vaultSyncDataJson } of vaultPlans) {
    const result = await executeSync({
      vaults: [vault],
      plugins,
      pluginIds,
      dirs,
      settings,
      syncDataJson: vaultSyncDataJson,
      source: await sourceOf(vault),
      assume,
      onConflict: args.onConflict,
    });
    allPreReports.push(...result.preReports);
    allPostReports.push(...result.postReports);
    allConflicts.push(...result.conflicts);
    allNotes.push(...result.notes.map((n) => `${vault.name}: ${n}`));
  }

  if (!args.nonInteractive) s.stop('Sync complete.');

  // Output results
  if (args.json) {
    console.log(JSON.stringify({
      templateVersion,
      preSync: allPreReports.map((r) => ({
        vault: r.vault.name,
        inSync: r.inSync,
        total: r.total,
      })),
      postSync: allPostReports.map(({ vault, results }) => ({
        vault: vault.name,
        allMatch: results.every((r) => r.status === 'in sync'),
        items: results.map(({ kind, id, label, status, templateVersion, vaultVersion, files }) => ({
          kind,
          id,
          label,
          status,
          templateVersion,
          vaultVersion,
          files: {
            match: files.match,
            differs: files.differs,
            missing: files.missing,
            extra: files.extra,
            overridden: files.overridden,
            stale: files.stale,
          },
        })),
      })),
      conflicts: allConflicts.map((c) => ({ vault: c.vault.name, kind: c.item.kind, id: c.item.id, file: c.file, detail: c.detail })),
      notes: allNotes,
    }, null, 2));
  } else {
    if (args.nonInteractive) {
      const totalPlugins = vaultPlans.reduce((sum, vp) => sum + vp.pluginIds.length, 0);
      const totalDirs = vaultPlans.reduce((sum, vp) => sum + vp.dirs.length, 0);
      const totalSettings = vaultPlans.reduce((sum, vp) => sum + vp.settings.length, 0);
      console.log(`Synced ${totalPlugins} plugin(s), ${totalDirs} director${totalDirs === 1 ? 'y' : 'ies'}, and ${totalSettings} setting(s) across ${selectedVaults.length} vault(s).`);
    }
    for (const { vault, results } of allPostReports) {
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
    if (allConflicts.length > 0) {
      const lines = allConflicts.map((c) => `${c.vault.name}: ${c.item.kind} ${c.item.label}: ${conflictLabel(c)}`);
      const message = `${allConflicts.length} conflict(s) left untouched (changed in both the vault and the template). Re-run with --on-conflict take-template|keep-vault:\n${lines.map((l) => `  ${l}`).join('\n')}`;
      if (args.nonInteractive) console.log(message);
      else p.log.warn(message);
    }
    if (allNotes.length > 0) {
      if (args.nonInteractive) for (const note of allNotes) console.log(`  ${note}`);
      else p.log.info(allNotes.join('\n'));
    }
  }

  // Prompt to save selections to vault-level config (interactive mode only)
  if (!args.nonInteractive) {
    const saveConfig = await p.confirm({
      message: 'Save these selections to each vault\'s .obsidian/sync.config.json?',
      initialValue: false,
    });
    if (p.isCancel(saveConfig)) cancel();

    if (saveConfig) {
      for (const { vault, pluginIds, dirs, settings, syncDataJson: vaultSyncDataJson } of vaultPlans) {
        const vaultConfigPath = join(vault.root, '.obsidian', 'sync.config.json');
        const vaultConfig = {
          defaultPlugins: pluginIds,
          defaultDirs: dirs,
          defaultSettings: settings,
          syncDataJson: vaultSyncDataJson,
        };
        await writeFile(vaultConfigPath, `${JSON.stringify(vaultConfig, null, 2)}\n`);
        p.log.success(`Updated ${vault.name}/.obsidian/sync.config.json`);
      }
    }

    const totalPlugins = vaultPlans.reduce((sum, vp) => sum + vp.pluginIds.length, 0);
    const totalDirs = vaultPlans.reduce((sum, vp) => sum + vp.dirs.length, 0);
    const totalSettings = vaultPlans.reduce((sum, vp) => sum + vp.settings.length, 0);
    p.outro(
      `Done! Synced ${totalPlugins} plugin(s), ${totalDirs} director${totalDirs === 1 ? 'y' : 'ies'}, and ${totalSettings} setting(s) across ${selectedVaults.length} vault(s). Template ${templateVersion}.`
    );
  }

  if (allConflicts.length > 0 && args.nonInteractive) process.exitCode = 1;
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
