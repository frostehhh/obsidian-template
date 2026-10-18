function getPlugin(app) {
  return app.plugins.plugins.excalibrain;
}

function getParentPropertyKey(app) {
  const plugin = getPlugin(app);
  if (!plugin) return "Parent";

  const parents = plugin.settings?.hierarchy?.parents ?? [];
  return parents.includes("Parent") ? "Parent:" : "Parent";
}

module.exports = { getPlugin, getParentPropertyKey };
