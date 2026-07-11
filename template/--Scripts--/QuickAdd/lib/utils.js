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

async function createAndOpenFile(app, path, content, { label, folder }) {
  if (app.vault.getAbstractFileByPath(path)) {
    const basename = path.split("/").pop();
    new Notice(`"${basename}" already exists.`);
    return null;
  }
  const newFile = await app.vault.create(path, content);
  new Notice(`Created "${label}" in "${folder}"`);
  await openFile(app, newFile);
  return newFile;
}

module.exports = { getActiveFile, getFolderContext, openFile, ensureFolder, createAndOpenFile };
