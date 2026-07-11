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

module.exports = { getProjects };
