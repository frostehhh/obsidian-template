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

function getProjectLinks(app, projectFilePath, fromFolder) {
  const projectFile = app.vault.getAbstractFileByPath(projectFilePath);
  if (!projectFile) return [];
  const linkText = app.metadataCache.fileToLinktext(projectFile, `${fromFolder}/placeholder.md`);
  return [`[[${linkText}]]`];
}

async function createTaskInFolder(app, file, { title, noun = "task" }) {
  const api = getTaskNotesApi(app);
  if (!api) return null;

  const { getFolderContext, ensureFolder } = await vaultRequire(app, "lib/utils");
  const { folderPath, folderName } = getFolderContext(file);
  const folder = folderPath ? `${folderPath}/Tasks` : "Tasks";
  const projectFilePath = folderPath ? `${folderPath}/${folderName}.md` : `${folderName}.md`;

  await ensureFolder(app, folder);

  const projects = getProjectLinks(app, projectFilePath, folder);
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

module.exports = { getTaskNotesApi, createTaskInFolder };
