const SCRIPTS_PATH = "--Scripts--/QuickAdd";

async function vaultRequire(app, name) {
  const relPath = name.endsWith(".js") ? name : `${name}.js`;
  const src = await app.vault.adapter.read(`${SCRIPTS_PATH}/${relPath}`);
  const mod = { exports: {} };
  new Function("module", "exports", src)(mod, mod.exports);
  return mod.exports;
}

module.exports = async (params) => {
  const { app, quickAddApi } = params;
  const { getActiveFile, getFolderContext, openFile, ensureFolder } = await vaultRequire(app, "lib/utils");

  const file = getActiveFile(app);
  if (!file) {
    new Notice("No active file.");
    return;
  }

  const { folderPath } = getFolderContext(file);
  const notesFolder = folderPath ? `${folderPath}/Notes` : "Notes";

  const title = await quickAddApi.inputPrompt("Note title");
  if (!title) return;

  await ensureFolder(app, notesFolder);

  const notePath = `${notesFolder}/${title}.md`;
  if (app.vault.getAbstractFileByPath(notePath)) {
    new Notice(`"${title}.md" already exists.`);
    return;
  }

  const newFile = await app.vault.create(notePath, "");
  new Notice(`Created "${title}" in "${notesFolder}"`);
  await openFile(app, newFile);
};
