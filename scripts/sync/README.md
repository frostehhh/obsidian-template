# sync

CLI tool for syncing plugins, content directories, and Obsidian settings from this template vault to other vaults.

## Usage

```sh
node scripts/sync/sync.js
```

## How it works

The script walks through a series of interactive prompts, then copies the selected items to each target vault.

### 1. Plugin selection

Lists every plugin found in `template/.obsidian/plugins/` (any directory with a valid `manifest.json`). Select one or more to sync.

### 2. Vault selection

Auto-discovers sibling directories (relative to the repo root) that contain an `.obsidian/plugins/` folder. You can also enter an arbitrary vault path manually. If the chosen path has no `.obsidian/` folder, one is created automatically.

### 3. Content directory selection

Choose from a fixed list of top-level template directories (e.g. `Notes`, `Canvas`, `Bases`). Some directories are **auto-included** based on your plugin selection:

| Plugin | Auto-included directory |
|---|---|
| QuickAdd | `--Scripts--` |
| TaskNotes | `TaskNotes` |
| Excalibrain | `Excalibrain` |
| Excalidraw | `Excalidraw` |

### 4. Obsidian settings selection

Optionally sync items from `template/.obsidian/`:

- `app.json`, `appearance.json`, `templates.json`, `types.json` — individual settings files
- `snippets/`, `themes/` — directories, copied recursively

### 5. Plugin settings (`data.json`)

By default, `data.json` and `genericPreviewCache.json` are **skipped** for each plugin. You can opt in to overwrite them when prompted.

### 6. Execution

For each selected plugin, all files (and subdirectories) in the plugin's source directory are copied to the corresponding directory in the target vault. If the plugin is not yet listed in the vault's `community-plugins.json`, its ID is appended there.

Content directories and settings items are copied after plugins. Existing files at the destination are overwritten; files present only in the destination are left untouched (no deletions).

## Configuration

A `sync.config.json` file at the repo root can pre-select defaults to skip re-answering prompts each run:

```json
{
  "defaultPlugins": ["quickadd", "dataview"],
  "defaultVaults": ["My Vault"],
  "defaultDirs": ["Notes", "Canvas"],
  "defaultSettings": ["app.json"],
  "syncDataJson": false
}
```
