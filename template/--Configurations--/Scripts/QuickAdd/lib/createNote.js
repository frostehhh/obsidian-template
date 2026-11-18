const SCRIPTS_PATH = "--Configurations--/Scripts/QuickAdd";

async function vaultRequire(app, name) {
  const relPath = name.endsWith(".js") ? name : `${name}.js`;
  const src = await app.vault.adapter.read(`${SCRIPTS_PATH}/${relPath}`);
  const mod = { exports: {} };
  new Function("module", "exports", src)(mod, mod.exports);
  return mod.exports;
}

function resolveTemplates(app, templates) {
  const paths = Array.isArray(templates) ? templates : [templates];
  for (const path of paths) {
    if (!app.vault.getAbstractFileByPath(path)) {
      throw new Error(`Template not found: "${path}".`);
    }
  }
  return paths;
}

async function applyTemplates(app, quickAddApi, file, templatePaths) {
  const reversed = [...templatePaths].reverse();
  for (let i = 0; i < reversed.length; i++) {
    if (app.workspace.getActiveFile()?.path !== file.path) {
      new Notice(`"${file.basename}" is no longer active. Stopped applying templates.`);
      return false;
    }
    await quickAddApi.applyTemplateToActiveFile(reversed[i], {
      mode: i === 0 ? "replace" : "top",
    });
  }
  return true;
}

async function createNoteFromPresets(app, quickAddApi, presets, options = {}) {
  const { ensureFolder, createAndOpenFile } = await vaultRequire(app, "lib/utils");

  let chosen;
  if (presets.length === 1) {
    chosen = presets[0];
  } else {
    const display = presets.map((p) => `${p.noteName} | ${p.path}`);
    chosen = await quickAddApi.suggester(display, presets);
    if (!chosen) return;
  }

  let templatePaths;
  try {
    templatePaths = resolveTemplates(app, chosen.templates);
  } catch (e) {
    new Notice(e.message);
    return;
  }

  const title = await quickAddApi.inputPrompt(`${chosen.noteName} title (leave blank for date only)`);

  const datePrefix = window.moment().format("YYYY-MM-DD");
  const fileName = title?.trim()
    ? options.datePrefixFilename
      ? `${datePrefix} - ${title.trim()}`
      : title.trim()
    : datePrefix;

  await ensureFolder(app, chosen.path);

  const notePath = `${chosen.path}/${fileName}.md`;
  const file = await createAndOpenFile(app, notePath, "", { label: fileName, folder: chosen.path });
  if (!file) return;

  await applyTemplates(app, quickAddApi, file, templatePaths);
}

module.exports = { createNoteFromPresets };
