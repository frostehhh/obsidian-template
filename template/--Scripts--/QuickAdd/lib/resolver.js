const path = require("path");

module.exports = (app) => (name) =>
  require(path.join(app.vault.adapter.basePath, "--Scripts--", "QuickAdd", name));
