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

async function markAsProject(app, file) {
  await app.fileManager.processFrontMatter(file, (fm) => {
    const existing = fm.tags || [];
    const tags = Array.isArray(existing) ? [...existing] : [existing];
    if (!tags.includes("task")) tags.push("task");
    if (!tags.includes("project")) tags.push("project");
    fm.tags = tags;
  });
}

// Find the project note for `file` in its directory or up to `maxLevels`
// parent directories. If none is found, offer to convert a folder note found
// along the way. Returns the project file, or null (after showing a notice).
async function resolveProject(app, quickAddApi, file, maxLevels = 2) {
  let currentDirPath = file.parent.path === "/" ? "" : file.parent.path;
  let levelsSearched = 0;
  const candidateFolderNotes = [];

  // Phase 1: Search all directory levels for project notes,
  // collecting folder-note candidates along the way.
  while (levelsSearched <= maxLevels) {
    const dirName = currentDirPath === "" ? app.vault.getName() : currentDirPath.split("/").pop();
    const projects = findProjectsInDirectory(app, currentDirPath);

    if (projects.length === 1) return projects[0];

    if (projects.length > 1) {
      const projectNames = projects.map((p) => `"${p.basename}"`).join(", ");
      new Notice(`Multiple projects found in "${dirName}": ${projectNames}. Expected exactly one.`);
      return null;
    }

    // No project in this directory — collect matching folder note for later
    const folderNotePath = currentDirPath ? `${currentDirPath}/${dirName}.md` : `${dirName}.md`;
    const folderNote = app.vault.getAbstractFileByPath(folderNotePath);
    if (folderNote) {
      candidateFolderNotes.push({
        file: folderNote,
        label: `${dirName}.md  (${currentDirPath || "/"})`,
      });
    }

    // Move up one parent level
    if (currentDirPath === "") break;
    const parts = currentDirPath.split("/");
    parts.pop();
    currentDirPath = parts.join("/");
    levelsSearched++;
  }

  // Phase 2: No project found — offer to convert a collected folder note
  if (candidateFolderNotes.length > 0) {
    const chosen = await quickAddApi.suggester(
      candidateFolderNotes.map((c) => c.label),
      candidateFolderNotes.map((c) => c.file)
    );
    if (chosen) {
      await markAsProject(app, chosen);
      new Notice(`Converted "${chosen.basename}" to a project.`);
      return chosen;
    }
  }

  new Notice(`No project found in "${file.parent.name}" or up to ${maxLevels} parent directories.`);
  return null;
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

  new Notice(`Created ${noun} "${title}" for project "${projectFile.basename}"`);
  return movedFile;
}

module.exports = {
  getTaskNotesApi,
  createTaskInFolder,
  ensureFolderTaskNote,
  findProjectsInDirectory,
  findProjectWithLookup,
  markAsProject,
  resolveProject,
  createTaskForProject,
};
