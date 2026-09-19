# QuickAdd Macro Scripts

Scripts live in `--Scripts--/QuickAdd/` and export an async function. They run inside Obsidian's Node.js context and have access to the full Obsidian `app` API.

## Module signature

```js
module.exports = async (params) => {
  const { app, quickAddApi: qa } = params;
  // ...
};
```

Return a string to expose it as `{{MACRO:macroName}}` output in the next template/capture step.

---

## Importing other scripts

`require` and dynamic `import()` are not available in QuickAdd's script execution context. Use `vaultRequire` instead — it reads a vault file and evaluates it as a CommonJS module:

```js
const basePath = "--Scripts--/QuickAdd";

async function vaultRequire(app, name) {
  const relPath = name.endsWith(".js") ? name : `${name}.js`;
  const src = await app.vault.adapter.read(`${basePath}/${relPath}`);
  const mod = { exports: {} };
  new Function("module", "exports", src)(mod, mod.exports);
  return mod.exports;
}

module.exports = async (params) => {
  const { app } = params;

  const myLib = await vaultRequire(app, "lib/my-lib");
  // ...
};
```

- Paths are relative to `--Scripts--/QuickAdd/`
- `.js` extension is optional
- Lib files use standard `module.exports = ...` syntax — no changes needed
- Modules are re-read from disk on every run (no caching)

---

## quickAddApi reference

### User prompts

```js
// Single-line text input
const value = await qa.inputPrompt("Header", "placeholder", "default value");

// Yes/no dialog — returns true or false
const ok = await qa.yesNoPrompt("Confirm?", "Optional body text.");

// Suggester — pick one item from a list
// displayItems: shown in UI | actualItems: returned on selection
const picked = await qa.suggester(
  ["Label A", "Label B", "Label C"],
  ["value-a", "value-b", "value-c"]
);
// Pass a function as displayItems to format each item dynamically:
const file = await qa.suggester(
  (f) => f.basename,
  app.vault.getMarkdownFiles()
);

// Checkbox — multi-select, returns array of selected actual values
const chosen = await qa.checkboxPrompt(
  ["Option A", "Option B", "Option C"], // display + actual (same array)
  ["Option A"]                           // pre-selected (optional)
);

// Wide input modal (multi-line friendly)
const text = await qa.wideInputPrompt("Header", "placeholder", "default");
```

All prompt functions return `null` if the user cancels. Always guard:

```js
const title = await qa.inputPrompt("Title");
if (!title) return; // user cancelled
```

### Dates

```js
qa.date.now("YYYY-MM-DD")          // today
qa.date.now("YYYY-MM-DD", 1)       // today + 1 day offset
qa.date.tomorrow("YYYY-MM-DD")     // tomorrow
qa.date.yesterday("YYYY-MM-DD")    // yesterday
```

Format strings use [moment.js tokens](https://momentjs.com/docs/#/displaying/format/).

### Clipboard

```js
const text = await qa.utility.getClipboard();
await qa.utility.setClipboard("text to copy");
```

---

## Passing variables to templates

Set named keys on `params.variables` to make them available in downstream template/capture steps as `{{VALUE:varName}}`:

```js
params.variables["projectName"] = "Alpha";
params.variables["dueDate"] = qa.date.now("YYYY-MM-DD", 7);
// Template can use: {{VALUE:projectName}}, {{VALUE:dueDate}}
```

---

## Obsidian app API

`app` is the live Obsidian `App` instance. Common operations:

```js
// Active file
const file = app.workspace.getActiveFile(); // TFile | null

// Read / write
const content = await app.vault.read(file);
await app.vault.modify(file, content + "\n- appended");

// Create a file
await app.vault.create("Folder/Note.md", "# Hello");

// Get all markdown files
const files = app.vault.getMarkdownFiles(); // TFile[]

// Get metadata (frontmatter, tags, links)
const meta = app.metadataCache.getFileCache(file);
const frontmatter = meta?.frontmatter ?? {};

// Open a file
await app.workspace.openLinkText("Note Name", "", false);

// Run any Obsidian command by ID
app.commands.executeCommandById("editor:toggle-bold");
```

---

## Complete script example

```js
module.exports = async (params) => {
  const { app, quickAddApi: qa } = params;

  // 1. Prompt for a title
  const title = await qa.inputPrompt("Note title");
  if (!title) return;

  // 2. Pick a category
  const category = await qa.suggester(
    ["Project", "Reference", "Archive"],
    ["Projects", "References", "Archive"]
  );
  if (!category) return;

  // 3. Pass to template step
  params.variables["title"] = title;
  params.variables["folder"] = category;
  params.variables["date"] = qa.date.now("YYYY-MM-DD");
};
```

---

## Error handling

Unhandled exceptions in a script abort the macro and show an error notice. Wrap risky operations:

```js
try {
  const file = app.workspace.getActiveFile();
  if (!file) throw new Error("No active file.");
  // ...
} catch (e) {
  new Notice(`QuickAdd error: ${e.message}`);
}
```

`Notice` is a global available in Obsidian's context — no import needed.
