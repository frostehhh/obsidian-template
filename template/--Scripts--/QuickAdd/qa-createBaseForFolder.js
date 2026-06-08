module.exports = async (params) => {
  const { app } = params;

  const file = app.workspace.getActiveFile();
  if (!file) {
    new Notice("No active file.");
    return;
  }

  const folderPath = file.parent.path === "/" ? "" : file.parent.path;
  const folderName = file.parent.name;
  const basePath = folderPath ? `${folderPath}/_${folderName}.base` : `${folderName}.base`;

  if (app.vault.getAbstractFileByPath(basePath)) {
    new Notice(`"${folderName}.base" already exists.`);
    return;
  }

  const content = `filters:
  and:
    - file.name != "_note_" + this.file.folder
    - file.name != this.file.name
    - file.inFolder(this.file.folder)
`;

  const newFile = await app.vault.create(basePath, content);
  new Notice(`Created "${folderName}.base" in "${folderPath || "/"}"`);
  const leaf = app.workspace.getLeaf(false);
  await leaf.openFile(newFile);
};
