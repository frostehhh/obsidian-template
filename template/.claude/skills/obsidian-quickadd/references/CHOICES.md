# QuickAdd Choice Schemas

All choices live in the top-level `choices` array in `.obsidian/plugins/quickadd/data.json`. Every choice shares these base fields:

```json
{
  "id": "<uuid>",
  "name": "Display Name",
  "type": "Template | Capture | Macro | Multi",
  "command": true
}
```

Set `"command": true` to expose the choice in the Obsidian command palette.

Generate a UUID with:
```bash
python3 -c "import uuid; print(uuid.uuid4())"
```

---

## Template

Creates a new note from a template file.

```json
{
  "id": "<uuid>",
  "name": "New Meeting Note",
  "type": "Template",
  "command": true,
  "templatePath": "Templates/Meeting.md",
  "folder": {
    "enabled": true,
    "folders": ["Meetings"],
    "chooseWhenCreatingNote": false,
    "createInSameFolderAsActiveFile": false
  },
  "fileNameFormat": {
    "enabled": true,
    "format": "{{DATE:YYYY-MM-DD}} {{VALUE:title}}"
  },
  "openFile": true,
  "openFileInNewTab": {
    "enabled": false,
    "direction": "vertical",
    "focus": true
  },
  "appendLink": false,
  "incrementFileName": false
}
```

**Key fields:**

| Field | Description |
|-------|-------------|
| `templatePath` | Vault-relative path to the template note |
| `folder.folders` | Array of target folders; first is used unless `chooseWhenCreatingNote: true` |
| `folder.createInSameFolderAsActiveFile` | Ignores `folders` and places the note next to the active file |
| `fileNameFormat.format` | Supports format variables; shown to user as a prompt if it contains `{{VALUE}}` |
| `openFile` | Open the created note after creation |
| `appendLink` | Insert a wikilink to the new note at the cursor |
| `incrementFileName` | Auto-suffix `(1)`, `(2)` etc. if the file already exists |

---

## Capture

Appends or prepends formatted text to an existing file.

```json
{
  "id": "<uuid>",
  "name": "Quick Capture to Inbox",
  "type": "Capture",
  "command": true,
  "captureTo": "Inbox.md",
  "format": "- {{DATE:YYYY-MM-DD HH:mm}} {{VALUE}}\n",
  "prepend": false,
  "task": false,
  "insertAfter": {
    "enabled": false,
    "after": "## Inbox",
    "insertAtEnd": false,
    "createIfNotFound": false
  },
  "createFileIfItDoesntExist": {
    "enabled": false,
    "createWithTemplate": false,
    "template": ""
  }
}
```

**Key fields:**

| Field | Description |
|-------|-------------|
| `captureTo` | Target file path; supports format variables |
| `format` | Text to insert; supports format variables |
| `prepend` | Insert at the top of the file instead of the bottom |
| `task` | Wrap the captured value as a Markdown task `- [ ]` |
| `insertAfter.after` | Insert the text directly after this string in the file |
| `insertAfter.insertAtEnd` | When using `insertAfter`, place at the end of that section |
| `createFileIfItDoesntExist` | Create `captureTo` file automatically if missing |

---

## Macro

Runs a sequence of commands: scripts, inline choices, Obsidian commands, or waits.

```json
{
  "id": "<uuid>",
  "name": "Run My Macro",
  "type": "Macro",
  "command": true,
  "macroId": "<macro-uuid>",
  "macro": {
    "id": "<macro-uuid>",
    "name": "My Macro",
    "commands": [
      {
        "id": "<cmd-uuid>",
        "type": "script",
        "path": "--Scripts--/QuickAdd/myScript.js"
      }
    ]
  }
}
```

**Command types in `macro.commands`:**

```json
// JavaScript script
{ "id": "<uuid>", "type": "script", "path": "--Scripts--/QuickAdd/myScript.js" }

// Wait (milliseconds)
{ "id": "<uuid>", "name": "Wait", "type": "wait", "milliseconds": 500 }

// Any Obsidian command by ID
{ "id": "<uuid>", "type": "obsidianCommand", "commandId": "editor:toggle-bold" }

// Inline nested choice (Template or Capture object embedded here)
{ "id": "<uuid>", "type": "template", ... }
{ "id": "<uuid>", "type": "capture", ... }
```

---

## Multi

Shows a sub-menu of nested choices in the command palette.

```json
{
  "id": "<uuid>",
  "name": "Create Note",
  "type": "Multi",
  "command": true,
  "choices": [
    {
      "id": "<uuid>",
      "name": "Meeting Note",
      "type": "Template",
      "command": false,
      "templatePath": "Templates/Meeting.md"
    },
    {
      "id": "<uuid>",
      "name": "Project Note",
      "type": "Template",
      "command": false,
      "templatePath": "Templates/Project.md"
    }
  ]
}
```

Nested choices typically have `"command": false` since they're only reachable through the Multi menu.
