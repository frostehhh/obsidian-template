import { readdir, readFile, writeFile, stat } from 'fs/promises';
import { join } from 'path';
import {
  STATE,
  STATE_PATH,
  TEMPLATE_DIR,
  TEMPLATE_PLUGINS_DIR,
  TEMPLATE_OBSIDIAN_DIR,
  pathExists,
} from '../lib/cli.js';

// Usage: state [--check]
// Refreshes the plugin list in state.json from template/.obsidian/plugins and reports template
// content that state.json does not classify. With --check nothing is written and any drift fails.
async function scanPlugins() {
  const plugins = [];
  for (const id of (await readdir(TEMPLATE_PLUGINS_DIR)).sort()) {
    try {
      const manifest = JSON.parse(await readFile(join(TEMPLATE_PLUGINS_DIR, id, 'manifest.json'), 'utf8'));
      plugins.push({ id, name: manifest.name, version: manifest.version });
    } catch {
      // Not a plugin directory
    }
  }
  return plugins;
}

async function entriesOf(dir) {
  return (await readdir(dir, { withFileTypes: true })).filter((e) => !e.name.startsWith('.'));
}

async function main() {
  const check = process.argv.includes('--check');
  const problems = [];

  // Plugins: regenerated
  const plugins = await scanPlugins();
  const pluginsChanged = JSON.stringify(plugins) !== JSON.stringify(STATE.plugins);

  // Content directories: every top-level template directory must be classified
  const dirs = STATE.dirs;
  const classifiedDirs = new Set([
    ...dirs.selectable,
    ...dirs.pluginLinked.map((c) => c.dir),
    ...dirs.excluded,
  ]);
  for (const entry of await entriesOf(TEMPLATE_DIR)) {
    if (entry.isDirectory() && !classifiedDirs.has(entry.name)) {
      problems.push(`Directory "${entry.name}" is in template/ but not listed in state.json (dirs.selectable, pluginLinked or excluded)`);
    }
  }
  for (const dir of classifiedDirs) {
    if (!(await pathExists(join(TEMPLATE_DIR, dir)))) {
      problems.push(`Directory "${dir}" is listed in state.json but missing from template/`);
    }
  }
  const pluginIds = new Set(plugins.map((p) => p.id));
  for (const { plugin } of dirs.pluginLinked) {
    if (!pluginIds.has(plugin)) problems.push(`dirs.pluginLinked refers to plugin "${plugin}", which is not in template/.obsidian/plugins`);
  }

  // Obsidian settings: every entry in template/.obsidian other than plugins must be classified
  const syncableSettings = STATE.settings.syncable.map((s) => s.name);
  const classifiedSettings = new Set([...syncableSettings, ...STATE.settings.excluded, 'plugins']);
  for (const entry of await entriesOf(TEMPLATE_OBSIDIAN_DIR)) {
    if (!classifiedSettings.has(entry.name)) {
      problems.push(`".obsidian/${entry.name}" is in template/ but not listed in state.json (settings.syncable or excluded)`);
    }
  }
  for (const setting of STATE.settings.syncable) {
    const target = join(TEMPLATE_OBSIDIAN_DIR, setting.name);
    if (!(await pathExists(target))) {
      problems.push(`Setting "${setting.name}" is listed in state.json but missing from template/.obsidian`);
      continue;
    }
    const actual = (await stat(target)).isDirectory() ? 'directory' : 'file';
    if (actual !== setting.type) problems.push(`Setting "${setting.name}" is a ${actual}, but state.json says ${setting.type}`);
  }

  if (pluginsChanged) {
    if (check) {
      problems.push('state.json plugins are out of date; run `mise run state`');
    } else {
      await writeFile(STATE_PATH, `${JSON.stringify({ ...STATE, plugins }, null, 2)}\n`);
      console.log(`Updated state.json plugins (${plugins.length}).`);
    }
  } else {
    console.log(`state.json plugins are current (${plugins.length}).`);
  }

  for (const problem of problems) console.error(`- ${problem}`);
  if (problems.length > 0) {
    console.error(check ? 'state.json is out of date.' : 'Fix the items above in state.json, then re-run.');
    process.exit(1);
  }
  console.log('state.json matches the template.');
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
