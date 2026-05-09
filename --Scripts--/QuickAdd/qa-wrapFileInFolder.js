module.exports = async (params) => {
  const { app } = params;

  const file = app.workspace.getActiveFile();
  if (!file) {
    new Notice("No active file.");
    return;
  }

  const parentPath = file.parent.path === "/" ? "" : file.parent.path;
  const newFolderPath = parentPath ? `${parentPath}/${file.basename}` : file.basename;
  const newFilePath = `${newFolderPath}/${file.name}`;

  await app.vault.createFolder(newFolderPath);
  await app.fileManager.renameFile(file, newFilePath);

  new Notice(`Moved "${file.name}" into "${newFolderPath}"`);
};
