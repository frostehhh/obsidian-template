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
  const { getActiveFile, getFolderContext, ensureFolderNote, createOrOpenFile } = await vaultRequire(app, "lib/utils");

  const file = getActiveFile(app);
  if (!file) {
    new Notice("No active file.");
    return;
  }

  const { folderPath, folderName } = getFolderContext(file);
  await ensureFolderNote(app, folderPath, folderName);

  const notesBaseName = `Notes - ${folderName}.base`;
  const baseFilePath = folderPath ? `${folderPath}/${notesBaseName}` : notesBaseName;

  const content = `filters:
  and:
    - file.name != "_note_" + this.file.folder
    - file.name != this.file.name
    - file.inFolder(this.file.folder + "/Notes")
views:
  - type: table
    name: Table
    order:
      - file.name
      - file.tags
`;

  await createOrOpenFile(app, baseFilePath, content, {
    label: notesBaseName,
    folder: folderPath || "/",
  });
};
