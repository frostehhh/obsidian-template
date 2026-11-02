const SCRIPTS_PATH = "--Configurations--/Scripts/QuickAdd";

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

function getTags(fileCache) {
  const tags = fileCache?.frontmatter?.tags;
  if (!tags) return [];
  return Array.isArray(tags) ? tags : [tags];
}

function findProjectsInDirectory(app, dirPath) {
  const normalizedDir = dirPath === "/" ? "" : dirPath;
  return app.vault.getFiles().filter((file) => {
    if (file.extension !== "md") return false;
    const parentPath = file.parent.path === "/" ? "" : file.parent.path;
    if (parentPath !== normalizedDir) return false;
    const fileTags = getTags(app.metadataCache.getFileCache(file));
    return fileTags.includes("task") && fileTags.includes("project");
  });
}

async function findProjectWithLookup(app, startDirPath, maxLevels = 2) {
  let currentPath = startDirPath === "/" ? "" : startDirPath;

  for (let level = 0; level <= maxLevels; level++) {
    const projects = findProjectsInDirectory(app, currentPath);

    if (projects.length === 1) {
      return { project: projects[0], error: null };
    }
    if (projects.length > 1) {
      return {
        project: null,
        error: `Multiple projects found in "${currentPath || "/"}". Expected exactly one.`,
      };
    }

    if (currentPath === "") break;
    const parts = currentPath.split("/");
    parts.pop();
    currentPath = parts.join("/");
  }

  return {
    project: null,
    error: `No project found in "${startDirPath || "/"}" or up to ${maxLevels} parent directories.`,
  };
}

async function createTaskForProject(app, projectFile, { title, noun = "task" }) {
  const api = getTaskNotesApi(app);
  if (!api) return null;

  const { ensureFolder } = await vaultRequire(app, "lib/utils");
  const projectDir = projectFile.parent.path === "/" ? "" : projectFile.parent.path;
  const folder = projectDir ? `${projectDir}/Tasks` : "Tasks";

  await ensureFolder(app, folder);

  const linkText = app.metadataCache.fileToLinktext(projectFile, `${folder}/placeholder.md`);
  const projects = [`[[${linkText}]]`];

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

module.exports = {
  getTaskNotesApi,
  createTaskInFolder,
  ensureFolderTaskNote,
  findProjectsInDirectory,
  findProjectWithLookup,
  createTaskForProject,
};
