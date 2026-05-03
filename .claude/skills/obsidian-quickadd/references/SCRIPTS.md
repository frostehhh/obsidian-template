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

## Importing modules with `require`

QuickAdd scripts run in Obsidian's Node.js context, so `require` is available for three categories of imports.

### Node.js built-ins

Standard Node modules work without installation:

```js
const path = require("path");
const fs   = require("fs");
const os   = require("os");

module.exports = async (params) => {
  const vaultPath = params.app.vault.adapter.basePath;
  const target    = path.join(vaultPath, "--Scripts--", "data.json");
  const raw       = fs.readFileSync(target, "utf8");
  const data      = JSON.parse(raw);
};
```

Common built-ins: `path`, `fs`, `os`, `crypto`, `child_process`, `url`.

> Prefer `app.vault` for reading/writing vault files — it keeps paths portable and triggers Obsidian's cache. Use `fs` only for files outside the vault or for synchronous reads where the vault API is inconvenient.

### Obsidian API

Import Obsidian's exported classes and utilities by requiring `"obsidian"`:

```js
const { Notice, moment, TFile, normalizePath } = require("obsidian");

module.exports = async (params) => {
  const { app } = params;

  new Notice("Hello from QuickAdd!");

  const today = moment().format("YYYY-MM-DD");

  const filePath = normalizePath("Notes/My Note.md");
  const file = app.vault.getAbstractFileByPath(filePath);
  if (file instanceof TFile) {
    const content = await app.vault.read(file);
  }
};
```

Commonly used exports: `Notice`, `moment`, `TFile`, `TFolder`, `normalizePath`, `requestUrl`, `parseYaml`, `stringifyYaml`.

### Other scripts in the vault

Shared helper modules live in `--Scripts--/QuickAdd/lib/` by default. Require them by absolute path built from the vault's base path:

```js
const path = require("path");

module.exports = async (params) => {
  const { app } = params;
  const lib  = path.join(app.vault.adapter.basePath, "--Scripts--", "QuickAdd", "lib");

  const utils = require(path.join(lib, "utils.js"));
  const result = utils.formatTitle("my note");
};
```

A helper in `lib/` follows the same `module.exports` convention:

```js
// --Scripts--/QuickAdd/lib/utils.js
module.exports = {
  formatTitle(str) {
    return str.replace(/\b\w/g, (c) => c.toUpperCase());
  },
};
```

To avoid repeating the base path in every script, load `resolver.js` once at the top to get a `resolve` function scoped to `--Scripts--/QuickAdd/`:

```js
const path    = require("path");
const resolve = require(path.join(app.vault.adapter.basePath, "--Scripts--", "QuickAdd", "lib", "resolver"))(app);

module.exports = async (params) => {
  const utils  = resolve("lib/utils.js");
  const helper = resolve("lib/helper.js");
  const myScript = resolve("myScript.js");
};
```

`app` is a global in Obsidian's renderer context, so `resolve` can be initialized at the top level alongside `path`. `resolver.js` lives at `--Scripts--/QuickAdd/lib/resolver.js` and resolves all paths from the `--Scripts--/QuickAdd/` root — prefix `lib/` for modules in the lib directory.

> Node caches `require` results. If you edit a script and re-run the macro in the same Obsidian session, you may get the stale version. **Restarting Obsidian** is the simplest fix. To clear a single module without restarting:
> ```js
> const modPath = path.join(app.vault.adapter.basePath, "--Scripts--", "QuickAdd", "lib", "utils.js");
> const utils = require(modPath);
> ```

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
