const SCRIPTS_PATH = "--Scripts--/QuickAdd";

async function vaultRequire(app, name) {
  const relPath = name.endsWith(".js") ? name : `${name}.js`;
  const src = await app.vault.adapter.read(`${SCRIPTS_PATH}/${relPath}`);
  const mod = { exports: {} };
  new Function("module", "exports", src)(mod, mod.exports);
  return mod.exports;
}

function getTaskNotesApi(app) {
  const api = app.plugins.plugins.tasknotes?.api;
  if (!api) {
    new Notice("TaskNotes plugin is not available.");
    return null;
  }
  return api;
}

async function ensureFolderTaskNote(app, api, folderPath, folderName) {
  const notePath = folderPath ? `${folderPath}/${folderName}.md` : `${folderName}.md`;
  let file = app.vault.getAbstractFileByPath(notePath);
  if (!file) {
    const task = await api.tasks.create({ title: folderName });
    if (task.path !== notePath) {
      await app.vault.rename(app.vault.getAbstractFileByPath(task.path), notePath);
    }
    file = app.vault.getAbstractFileByPath(notePath);
  }
  return file;
}

async function getProjectLinks(app, api, folderPath, folderName, fromFolder) {
  const projectFile = await ensureFolderTaskNote(app, api, folderPath, folderName);
  const linkText = app.metadataCache.fileToLinktext(projectFile, `${fromFolder}/placeholder.md`);
  return [`[[${linkText}]]`];
}

async function createTaskInFolder(app, file, { title, noun = "task" }) {
  const api = getTaskNotesApi(app);
  if (!api) return null;

  const { getFolderContext, ensureFolder } = await vaultRequire(app, "lib/utils");
  const { folderPath, folderName } = getFolderContext(file);
  const folder = folderPath ? `${folderPath}/Tasks` : "Tasks";

  await ensureFolder(app, folder);

  const projects = await getProjectLinks(app, api, folderPath, folderName, folder);
  const task = await api.tasks.create({ title, projects });
  await api.tasks.move(task.path, folder);

  const movedPath = `${folder}/${task.path.split("/").pop()}`;
  const movedFile = app.vault.getAbstractFileByPath(movedPath);
  if (movedFile && projects.length) {
    await app.fileManager.processFrontMatter(movedFile, (fm) => {
      fm.projects = projects;
    });
  }

  new Notice(`Created ${noun} "${title}" in "${folder}"`);
  return movedFile;
}

module.exports = { getTaskNotesApi, createTaskInFolder, ensureFolderTaskNote };
