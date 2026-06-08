const path = require("path");
const resolve = require(path.join(app.vault.adapter.basePath, "--Scripts--", "QuickAdd", "lib", "resolver"))(app);
const hello = resolve("lib/hello.js");

module.exports = async (params) => {
  const { app } = params;

  hello();
};
