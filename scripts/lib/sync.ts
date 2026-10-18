import { readdir, readFile, writeFile, mkdir, copyFile } from 'fs/promises';
import { join } from 'path';
import {
  TEMPLATE_DIR,
  TEMPLATE_PLUGINS_DIR,
  TEMPLATE_OBSIDIAN_DIR,
  DATA_FILES,
  pathExists,
  copyRecursive,
  copyAny,
} from './cli.ts';
import { compareVault, compareItem, listItems } from './compare.ts';
import type { Vault, PluginInfo, ItemResult } from './types.ts';

export interface SyncPlanEntry {
  plugin: PluginInfo;
  vault: Vault;
  srcDir: string;
  destDir: string;
  filesToCopy: string[];
  filesToSkip: string[];
  subDirs: string[];
  addToCommunityPlugins: boolean;
  existingCommunityPlugins: string[];
}

export interface SyncOptions {
  vaults: Vault[];
  plugins: PluginInfo[];
  pluginIds: string[];
  dirs: string[];
  settings: string[];
  syncDataJson: boolean;
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

export interface SyncResult {
  plan: SyncPlanEntry[];
  preReports: SyncPreReport[];
  postReports: SyncPostReport[];
}

export async function buildSyncPlan(options: SyncOptions): Promise<SyncPlanEntry[]> {
  const { vaults, plugins, pluginIds, syncDataJson } = options;
  const selectedPlugins = plugins.filter((pl) => pluginIds.includes(pl.id));
  const plan: SyncPlanEntry[] = [];

  for (const vault of vaults) {
    let existingCommunityPlugins: string[] = [];
    try {
      existingCommunityPlugins = JSON.parse(await readFile(vault.communityPluginsPath, 'utf8'));
    } catch {
      // Missing community-plugins.json — start fresh
    }

    for (const plugin of selectedPlugins) {
      const srcDir = join(TEMPLATE_PLUGINS_DIR, plugin.id);
      const destDir = join(vault.pluginsDir, plugin.id);
      const allFiles = await readdir(srcDir, { withFileTypes: true });

      const filesToCopy: string[] = [];
      const filesToSkip: string[] = [];
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

  return plan;
}

export async function executeSync(options: SyncOptions): Promise<SyncResult> {
  const { vaults, pluginIds, dirs, settings } = options;

  // Pre-sync comparison
  const items = await listItems();
  const preReports: SyncPreReport[] = [];
  for (const vault of vaults) {
    const results = await compareVault(vault, items);
    preReports.push({ vault, inSync: results.filter((r) => r.status === 'in sync').length, total: results.length });
  }

  // Build and execute plan
  const plan = await buildSyncPlan(options);
  const communityPluginUpdates = new Map<string, string[]>();

  for (const entry of plan) {
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

  for (const vault of vaults) {
    const updated = communityPluginUpdates.get(vault.name);
    if (updated) {
      await writeFile(vault.communityPluginsPath, JSON.stringify(updated, null, 2));
    }
  }

  for (const vault of vaults) {
    for (const dir of dirs) {
      const src = join(TEMPLATE_DIR, dir);
      const dest = join(vault.root, dir);
      if (await pathExists(src)) {
        await copyRecursive(src, dest);
      }
    }
  }

  for (const vault of vaults) {
    for (const item of settings) {
      const src = join(TEMPLATE_OBSIDIAN_DIR, item);
      const dest = join(vault.root, '.obsidian', item);
      if (await pathExists(src)) {
        await copyAny(src, dest);
      }
    }
  }

  // Post-sync verification
  const syncedItems = items.filter(
    (item) =>
      (item.kind === 'plugin' && pluginIds.includes(item.id)) ||
      (item.kind === 'dir' && dirs.some((d) => d.toLowerCase() === item.id.toLowerCase())) ||
      (item.kind === 'setting' && settings.includes(item.id))
  );

  const postReports: SyncPostReport[] = [];
  for (const vault of vaults) {
    const results: ItemResult[] = [];
    for (const item of syncedItems) results.push(await compareItem(vault, item));
    postReports.push({ vault, results });
  }

  return { plan, preReports, postReports };
}
