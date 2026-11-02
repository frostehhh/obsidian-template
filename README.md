# Obsidian Template Vault

A pre-configured Obsidian vault template with an opinionated folder structure, task management system, and a curated plugin setup. Clone this repo and open the `template/` directory as a new Obsidian vault to get started.

## Structure

```
template/
├── --Attachments--/        # Media and file attachments
├── --Configurations--/     # Vault configuration files
│   ├── Obsidian Template/   # Note frontmatter templates (via Templater)
│   │   └── Frontmatter/     # Note.md, Reference Note.md
│   ├── Properties/          # Obsidian property definitions
│   │   └── knowledge-confidence-level.md
│   └── Scripts/
│       └── QuickAdd/        # QuickAdd macro scripts
├── .agents/skills/         # Claude agent skills (Obsidian-aware)
├── .claude/skills/         # Claude Code skill definitions
├── Bases/                  # Obsidian Bases views
├── Canvas/                 # Obsidian Canvas files
├── Dataviews/              # Dataview query notes
├── ExcaliBrain/            # ExcaliBrain graph note
├── Excalidraw/             # Excalidraw drawings
├── Knowledge Confidence/   # Base view for confidence-level tracking
├── Notes/                  # General notes
├── Reference Notes/        # Source-linked reference notes
├── References/             # Reference entries (books, papers, etc.)
└── TaskNotes/              # Task management
    ├── Tasks/              # Individual task notes
    └── Views/              # Pre-built Base views for tasks
```

## Plugins

Community plugins included in `.obsidian/plugins/`:

| Plugin | Description |
|---|---|
| [Advanced Canvas](https://obsidian.md/plugins?id=advanced-canvas) | Supercharge your canvas experience — presentations, flowcharts, and more. |
| [Advanced Tables](https://obsidian.md/plugins?id=table-editor-obsidian) | Improved table navigation, formatting, manipulation, and formulas. |
| [Copy Button for Code Blocks](https://obsidian.md/plugins?id=code-block-copy) | Adds a copy button to every code block. |
| [Dataview](https://obsidian.md/plugins?id=dataview) | Complex data views and SQL-like queries over your notes. |
| [Editing Toolbar](https://obsidian.md/plugins?id=editing-toolbar) | MS Word-like formatting toolbar with customizable editing commands. |
| [ExcaliBrain](https://obsidian.md/plugins?id=excalibrain) | Clean, intuitive, and editable graph view for Obsidian. |
| [Excalidraw](https://obsidian.md/plugins?id=obsidian-excalidraw-plugin) | Edit and view Excalidraw drawings; 4D Visual PKM. |
| [Folder Notes](https://obsidian.md/plugins?id=folder-notes) | Create notes within folders accessible without collapsing the folder. |
| [Git](https://obsidian.md/plugins?id=obsidian-git) | Git version control with automatic backup and advanced features. |
| [Highlightr](https://obsidian.md/plugins?id=highlightr-plugin) | Minimal color-coded highlighting menu with configurable highlight colors. |
| [Hover Editor](https://obsidian.md/plugins?id=obsidian-hover-editor) | Transform the page preview hover popover into a floating editor tab. |
| [Iconize](https://obsidian.md/plugins?id=obsidian-icon-folder) | Add icons to files, folders, and text in your vault. |
| [Lazy Loader](https://obsidian.md/plugins?id=lazy-plugins) | Load plugins with a delay on startup for faster vault open times. |
| [Linter](https://obsidian.md/plugins?id=obsidian-linter) | Format and normalize YAML, markdown, spacing, and frontmatter. |
| [Markdown Formatting Assistant](https://obsidian.md/plugins?id=obsidian-markdown-formatting-assistant-plugin) | Editor panel for Markdown, HTML, and colors with a command interface. |
| [Media Extended](https://obsidian.md/plugins?id=media-extended) | Video and audio playback enhancements. |
| [Mermaid Tools](https://obsidian.md/plugins?id=mermaid-tools) | Improved Mermaid.js experience with a visual element toolbar. |
| [Meta Bind](https://obsidian.md/plugins?id=obsidian-meta-bind-plugin) | Make notes interactive with inline input fields, metadata displays, and buttons. |
| [Omnisearch](https://obsidian.md/plugins?id=omnisearch) | Full-text vault search that just works. |
| [Open Vault in VS Code](https://obsidian.md/plugins?id=open-vscode) | Ribbon button and context menu to open the vault as a VS Code workspace. |
| [QuickAdd](https://obsidian.md/plugins?id=quickadd) | Quickly add pages or content via macros and capture prompts. |
| [Simple Embeds](https://obsidian.md/plugins?id=simple-embeds) | Replace Twitter, YouTube, and other links with embeds in preview. |
| [Spaced Repetition](https://obsidian.md/plugins?id=obsidian-spaced-repetition) | Fight the forgetting curve by reviewing flashcards and notes. |
| [Style Settings](https://obsidian.md/plugins?id=obsidian-style-settings) | Controls for adjusting theme, plugin, and snippet CSS variables. |
| [Supercharged Links](https://obsidian.md/plugins?id=supercharged-links-obsidian) | Style links and add context menu options based on note properties. |
| [Tag Wrangler](https://obsidian.md/plugins?id=tag-wrangler) | Rename, merge, toggle, and search tags from the tags panel. |
| [TaskNotes](https://obsidian.md/plugins?id=tasknotes) | Note-based task management with calendar, pomodoro, and time tracking. |
| [Templater](https://obsidian.md/plugins?id=templater-obsidian) | Advanced note templating and automation with handlebars-like syntax. |


### QuickAdd Scripts (`--Configurations--/Scripts/QuickAdd/`)

See https://quickadd.obsidian.guide/docs/ for information on the relevant plugin.

| Script | Description |
|---|---|
| `qa-taskNotes-createTaskForFolder.js` | Create a task in the current folder's `Tasks/` subfolder, auto-linking the folder's note as a project |
| `qa-taskNotes-createTaskForProject.js` | Create a task under the `Tasks/` subfolder of a project note (a note tagged with `#task` and `#project`) in the current or parent directories |
| `qa-taskNotes-setCurrentNoteAsProject.js` | Add `task` and `project` tags to the current note's frontmatter, marking it as a project |
| `qa-taskNotes-createOrOpenTasksDefaultViewForFolder.js` | Scaffold a default task view Base for the current folder, or open it if it already exists |
| `qa-createOrOpenBaseForFolder.js` | Create a generic Base view for the current folder, or open it if it already exists |
| `qa-wrapFileInFolder.js` | Wrap the active file into a new folder of the same name |

## Claude Code Integration

The `template/.claude/` and `template/.agents/` directories include skills for AI-assisted vault management:

- **obsidian-markdown** — create/edit Obsidian Flavored Markdown
- **obsidian-bases** — create/edit `.base` files
- **obsidian-cli** — interact with the vault via CLI
- **json-canvas** — create/edit `.canvas` files
- **obsidian-quickadd** — configure QuickAdd choices and scripts
- **defuddle** — extract clean markdown from web pages

Repository workflow skills (in the repo root `.agents/skills/`): **git-workflow-and-versioning** (generic git and release practices) and **obsidian-template-git-workflow** (this repo's commit, changelog and release rules).

## Getting Started

1. Clone this repository.
2. Open `template/` as a vault in Obsidian.
3. Accept the prompt to enable community plugins.
4. Browse `TaskNotes/Views/tasks-default.base` to see your task board.
5. Use the QuickAdd command palette (`Ctrl/Cmd+P` → QuickAdd) to create tasks and notes.

## Syncing to other vaults

Requires [mise](https://mise.jdx.dev/) and `npm install` (for the CLI prompts).

```sh
mise run sync      # copy plugins, directories and settings into other vaults
mise run compare   # report which of them already match the template
```

Both commands compare `template/` with the vault file by file, so the sync wizard shows what is already in sync before you choose what to copy. See [scripts/sync/README.md](scripts/sync/README.md).

## Versioning & Changelog

The template follows [Semantic Versioning](https://semver.org/). Releases are annotated git tags (`vX.Y.Z`), and the tag is the source of truth for the version shown by `sync` and `compare`.

| Bump | When |
|---|---|
| MAJOR | Breaking change that needs manual migration in existing vaults: vault structure, property schema, folder names, QuickAdd script contracts |
| MINOR | Backward-compatible additions: new plugins, scripts, bases, skills (while on 0.x, breaking changes also bump MINOR) |
| PATCH | Backward-compatible fixes and setting tweaks |

When unsure whether a change is breaking, treat it as breaking.

**Changelog.** [CHANGELOG.md](CHANGELOG.md) is an index with one file per release in [changelog/](changelog/). Add a line describing the user-visible impact to `changelog/unreleased.md` in the same commit as the change, grouped under Added / Changed / Deprecated / Removed / Fixed / Security. Breaking changes need a **Migration** note. The `obsidian-template-git-workflow` skill covers this and the commit conventions.

**Releasing.** From a clean `master`:

```sh
mise run release minor --dry-run   # preview
mise run release minor             # patch | minor | major | x.y.z
git push --follow-tags             # publish
```

The release task moves `changelog/unreleased.md` to `changelog/<version>.md`, updates the index, sets the `package.json` version, commits, and creates the tag. It never pushes.
