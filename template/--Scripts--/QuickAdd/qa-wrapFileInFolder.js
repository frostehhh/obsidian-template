const SCRIPTS_PATH = "--Scripts--/QuickAdd";

async function vaultRequire(app, name) {
  const relPath = name.endsWith(".js") ? name : `${name}.js`;
  const src = await app.vault.adapter.read(`${SCRIPTS_PATH}/${relPath}`);
  const mod = { exports: {} };
  new Function("module", "exports", src)(mod, mod.exports);
  return mod.exports;
}

module.exports = async (params) => {
  const { app } = params;
  const { getActiveFile, getFolderContext } = await vaultRequire(app, "lib/utils");

  const file = getActiveFile(app);
  if (!file) {
    new Notice("No active file.");
    return;
  }

  const { folderPath } = getFolderContext(file);
  const newFolderPath = folderPath ? `${folderPath}/${file.basename}` : file.basename;
  const newFilePath = `${newFolderPath}/${file.name}`;

  await app.vault.createFolder(newFolderPath);
  await app.fileManager.renameFile(file, newFilePath);

  new Notice(`Moved "${file.name}" into "${newFolderPath}"`);
};
