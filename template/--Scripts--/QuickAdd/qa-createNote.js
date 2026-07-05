const SCRIPTS_PATH = "--Scripts--/QuickAdd";

async function vaultRequire(app, name) {
  const relPath = name.endsWith(".js") ? name : `${name}.js`;
  const src = await app.vault.adapter.read(`${SCRIPTS_PATH}/${relPath}`);
  const mod = { exports: {} };
  new Function("module", "exports", src)(mod, mod.exports);
  return mod.exports;
}

module.exports = async (params) => {
  const { app, quickAddApi } = params;
  const { createNoteFromPresets } = await vaultRequire(app, "lib/createNote");

  const PRESETS = [
    {
      noteName: "Note",
      templates: "--Obsidian Template--/Frontmatter/Note.md",
      path: "Notes",
    },
  ];

  await createNoteFromPresets(app, quickAddApi, PRESETS);
};
