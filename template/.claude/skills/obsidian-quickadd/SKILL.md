---
name: obsidian-quickadd
description: Create and configure QuickAdd plugin choices (Template, Capture, Macro, Multi), write QuickAdd JavaScript macro scripts, and manage the QuickAdd data.json settings. Use when the user wants to add a QuickAdd command, build a macro, write a script for QuickAdd, or configure captures and templates.
---

# QuickAdd Plugin

QuickAdd automates note creation and capture in Obsidian via four choice types run from the command palette or chained in macros.

## Vault layout

- **Plugin config**: `.obsidian/plugins/quickadd/data.json` — all choices live in the `choices` array
- **Macro scripts**: `--Scripts--/QuickAdd/` — JavaScript files for Macro choices

## Choice types

| Type | Purpose |
|------|---------|
| **Template** | Creates a new note from a template file |
| **Capture** | Appends/prepends formatted text to an existing file |
| **Macro** | Runs a sequence of scripts and/or other choices |
| **Multi** | Shows a sub-menu of nested choices |

Full JSON schemas for every choice type → [CHOICES.md](references/CHOICES.md)

## Format variables

Format strings appear in `fileNameFormat`, `captureTo`, `format`, and inside template files.

```
{{DATE}}               Today (YYYY-MM-DD)
{{DATE:HH:mm}}         Custom moment.js format
{{DATE+1d}}            Date offset
{{VALUE}}              User input prompt
{{VALUE:varName}}      Named variable from a macro script
{{NAME}}               New note's filename
{{CLIPBOARD}}          Clipboard contents
{{MACRO:macroName}}    Output returned by a Macro choice
```

Full variable reference and moment.js tokens → [FORMAT-VARIABLES.md](references/FORMAT-VARIABLES.md)

## Macro scripts

Scripts are async JS modules placed in `--Scripts--/QuickAdd/`:

```js
module.exports = async (params) => {
  const { app, quickAddApi: qa } = params;

  const title = await qa.inputPrompt("Title");
  if (!title) return;

  params.variables["title"] = title; // available as {{VALUE:title}} in next step
};
```

Key API surface:
- **Prompts** — `inputPrompt`, `yesNoPrompt`, `suggester`, `checkboxPrompt`
- **Dates** — `qa.date.now(format, offset?)`
- **Clipboard** — `qa.utility.getClipboard / setClipboard`
- **Variables** — `params.variables["key"] = value`
- **Obsidian API** — full `app` instance available

Full script API, error handling, and examples → [SCRIPTS.md](references/SCRIPTS.md)

## Workflow: adding a new choice

1. Open `.obsidian/plugins/quickadd/data.json`
2. Add a new object to `choices` with a fresh UUID
3. Set `"command": true` to expose it in the command palette
4. For Macro choices, write the script in `--Scripts--/QuickAdd/<name>.js`
5. Reload QuickAdd in Obsidian to pick up changes

Generate a UUID:
```bash
python3 -c "import uuid; print(uuid.uuid4())"
```

## Common patterns

**Daily task capture** — append a task to today's daily note:
```json
{
  "type": "Capture",
  "captureTo": "Daily/{{DATE:YYYY-MM-DD}}.md",
  "format": "- [ ] {{VALUE}}\n",
  "insertAfter": { "enabled": true, "after": "## Inbox", "insertAtEnd": true, "createIfNotFound": true }
}
```

**Prompted-title note** — ask for a title, create from template:
```json
{
  "type": "Template",
  "templatePath": "Templates/Note.md",
  "fileNameFormat": { "enabled": true, "format": "{{VALUE:title}}" },
  "folder": { "enabled": true, "folders": ["Notes"] }
}
```

**Script → Template macro** — script sets variables, template step uses them:
```json
{
  "type": "Macro",
  "macro": {
    "commands": [
      { "type": "script", "path": "--Scripts--/QuickAdd/promptTitle.js" },
      { "type": "template", "templatePath": "Templates/Note.md", ... }
    ]
  }
}
```
