function getActiveFile(app) {
  return app.workspace.getActiveFile();
}

function getFolderContext(file) {
  return {
    folderPath: file.parent.path === "/" ? "" : file.parent.path,
    folderName: file.parent.name,
  };
}

async function openFile(app, file) {
  const leaf = app.workspace.getLeaf(false);
  await leaf.openFile(file);
}

async function ensureFolder(app, folderPath) {
  if (!app.vault.getAbstractFileByPath(folderPath)) {
    await app.vault.createFolder(folderPath);
  }
}

module.exports = { getActiveFile, getFolderContext, openFile, ensureFolder };
