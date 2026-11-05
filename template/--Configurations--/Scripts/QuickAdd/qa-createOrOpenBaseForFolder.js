const SCRIPTS_PATH = "--Configurations--/Scripts/QuickAdd";

async function vaultRequire(app, name) {
  const relPath = name.endsWith(".js") ? name : `${name}.js`;
  const src = await app.vault.adapter.read(`${SCRIPTS_PATH}/${relPath}`);
  const mod = { exports: {} };
  new Function("module", "exports", src)(mod, mod.exports);
  return mod.exports;
}

module.exports = async (params) => {
  const { app } = params;
  const { getActiveFile, getFolderContext, ensureFolderNote, createOrOpenFile } = await vaultRequire(app, "lib/utils");
  const { getParentPropertyKey } = await vaultRequire(app, "lib/excalibrain");
  const { buildBaseContent, syncFolderChildFormula } = await vaultRequire(app, "lib/folderBase");

  const file = getActiveFile(app);
  if (!file) {
    new Notice("No active file.");
    return;
  }

  const { folderPath, folderName } = getFolderContext(file);
  const folderNote = await ensureFolderNote(app, folderPath, folderName);

  const parentKey = await getParentPropertyKey(app);
  const notesBaseName = `Notes - ${folderName}.base`;
  const baseFilePath = folderPath ? `${folderPath}/${notesBaseName}` : notesBaseName;

  // Existing base: refresh the reserved folder formula (moved folder, old `this` filter) before opening.
  const existing = app.vault.getAbstractFileByPath(baseFilePath);
  if (existing) {
    const { parseYaml } = params.obsidian;
    const result = await syncFolderChildFormula(app, existing, parentKey, folderNote.path, parseYaml);
    if (result.status === "updated") new Notice(`Updated folder filter in "${notesBaseName}".`);
    if (result.status === "migrated") new Notice(`Migrated "${notesBaseName}" to the new folder filter.`);
    if (result.status === "skipped") new Notice(result.message);
  }

  const content = buildBaseContent(parentKey, folderNote.path);

  await createOrOpenFile(app, baseFilePath, content, {
    label: notesBaseName,
    folder: folderPath || "/",
  });
};
