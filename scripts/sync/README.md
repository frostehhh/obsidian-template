# sync and compare

CLI tools for syncing plugins, content directories, and Obsidian settings from this template vault to other vaults.

## Usage

```sh
mise run sync      # interactive wizard that copies items into other vaults
mise run compare   # read-only report of how a vault matches the template
```

## How it works

The wizard first asks for the target vaults, compares the template with each of them, shows which items already match, and then walks through prompts for what to copy. Every option carries its comparison status in the hint.

### 1. Vault selection and comparison

Auto-discovers sibling directories (relative to the repo root) that contain an `.obsidian/plugins/` folder. You can also enter an arbitrary vault path manually. If the chosen path has no `.obsidian/` folder, one is created automatically.

The template is then compared with each selected vault by file content (sha1). Plugin `data.json` and `genericPreviewCache.json` are ignored, as sync skips them by default. Each item (plugin, content directory, settings entry) gets a status:

| Status | Meaning |
|---|---|
| in sync | every template file exists in the vault with identical content |
| outdated | at least one file differs from the template |
| partial | some template files are missing, the rest match |
| not synced | the item is absent from the vault |

Files that exist only in the vault are reported as `+N vault-only` and never count against an item (`Notes` legitimately holds vault-only notes). The comparison shows differences, not direction: a differing file may be an older template copy or a local edit in the vault.

### 2. Plugin selection

Lists every plugin found in `template/.obsidian/plugins/` (any directory with a valid `manifest.json`). Select one or more to sync.

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

### 6. Execution and verification

For each selected plugin, all files (and subdirectories) in the plugin's source directory are copied to the corresponding directory in the target vault. If the plugin is not yet listed in the vault's `community-plugins.json`, its ID is appended there.

Content directories and settings items are copied after plugins. Existing files at the destination are overwritten; files present only in the destination are left untouched (no deletions). Afterwards the synced items are compared again and the wizard reports whether they now match the template.

## compare

```sh
mise run compare [vault-name-or-path] [--verbose] [--json] [--check]
```

Read-only. Prints the same statuses for every plugin, directory and setting, for example:

```
vault: Work   (template v0.1.0)
  plugins   QuickAdd             in sync
            Dataview             outdated   (v3.1.0 -> v3.2.0, 4 differ)
            TaskNotes            not synced
  dirs      Bases                partial   (2 missing)
            Notes                in sync   (+14 vault-only)
Summary: 2 in sync, 1 outdated, 1 partial, 1 not synced
```

`--verbose` lists the differing, missing and vault-only files, `--json` prints machine-readable output, and `--check` exits non-zero when anything is not in sync. Without an argument it shows the vault picker.

The template version comes from the git tag (`git describe --tags`), falling back to `package.json`.

## state.json

`state.json` at the repo root describes the template: the plugins it contains (id, name, version), the content directories that can be selected, the directories linked to a plugin, the Obsidian settings that can be synced, and the files and directories deliberately left out. Both `sync` and `compare` read it. Run `mise run state` after adding or updating a plugin or adding a template directory; it refreshes the plugin list and fails with a list of anything in `template/` that `state.json` does not classify (`--check` verifies without writing).

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
