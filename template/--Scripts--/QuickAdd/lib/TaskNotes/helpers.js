function getProjects(app, projectFilePaths, fromFolder) {
  const paths = Array.isArray(projectFilePaths) ? projectFilePaths : [projectFilePaths];
  const links = [];
  for (const path of paths) {
    const projectFile = app.vault.getAbstractFileByPath(path);
    if (!projectFile) continue;
    const linkText = app.metadataCache.fileToLinktext(projectFile, `${fromFolder}/placeholder.md`);
    links.push(`[[${linkText}]]`);
  }
  return links;
}

async function createTaskInFolder(app, api, { title, projects, folder, noun = "task" }) {
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

module.exports = { getProjects, createTaskInFolder };
