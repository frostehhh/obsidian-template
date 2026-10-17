---
name: obsidian-template-git-workflow
description: Git, changelog and release rules for the obsidian-template repo. Use when committing in this repo, changing anything under template/, scripts/ or skills, writing a changelog entry, choosing a version bump, or cutting a release with mise run release.
---

# Obsidian Template Git Workflow

Repo-specific rules on top of the generic `git-workflow-and-versioning` skill. Where the two differ, this one wins.

## Commits

- One logical change per commit.
- Subject: imperative, sentence case, no trailing period, no `feat:`/`fix:` prefix. This matches the existing history (`Guard folder-base Parent filter against notes with no Parent property`). Add a body only when the why is not obvious.
- Never stage unrelated churn. Obsidian rewrites these on its own, so check `git status` and stage files by path:
  - plugin `data.json` files under `template/.obsidian/plugins/` (unless the change is meant to update plugin settings)
  - `.DS_Store`, `workspace.json`, `workspaces.json`
- Commit trailers come from the session's attribution instructions, if any.

## Changelog entry with every change

Any commit that changes `template/`, `scripts/`, or the skills adds a line to `changelog/unreleased.md` in the same commit. Do not generate entries from commit messages and do not wait until release time.

- Group under `## Added`, `## Changed`, `## Deprecated`, `## Removed`, `## Fixed`, `## Security` (create the heading when first needed).
- Phrase by impact on someone using or syncing the template: "Folder base no longer errors on notes without a Parent", not "Guard filter".
- Breaking changes (vault structure, property schema, folder names, QuickAdd script names or contracts) get a **Migration** sub-bullet with the steps to take in an existing vault. Deprecations name the removal version.
- Mention when users must re-sync a specific plugin or directory (`mise run sync`).
- No entry is needed for changes that do not affect the template's users: README typos, formatting, commit-only housekeeping.

## Choosing the version bump

- MAJOR: breaking change needing manual migration in existing vaults.
- MINOR: backward-compatible additions (new plugin, script, base, skill). While on 0.x, breaking changes also bump MINOR and must be called out as breaking.
- PATCH: backward-compatible fixes and setting tweaks.
- When unsure whether something is breaking, treat it as breaking.

## Releasing

1. Be on a clean `master` with a current `state.json` (the release task refuses otherwise; untracked files are ignored).
2. Find commits since the last release that touched users: `git log "$(git describe --tags --abbrev=0)"..HEAD --oneline -- template scripts .agents`. Compare against `changelog/unreleased.md` and add any missing entries. Commits are a checklist, never the source of the wording. Commit the changelog update.
3. Preview: `mise run release <patch|minor|major> --dry-run`.
4. Release: `mise run release <patch|minor|major>`. It moves `changelog/unreleased.md` to `changelog/<version>.md`, adds it to `CHANGELOG.md`, sets the `package.json` version, commits `Release x.y.z`, and creates the annotated tag `vX.Y.Z`.
5. Publishing is `git push --follow-tags`. Run it only after the user explicitly confirms.

Never hand-edit the `package.json` version or create release tags manually, so the tag, `package.json` and the changelog cannot disagree.

## Keeping state.json current

`state.json` lists what the template contains and what sync can copy. After adding or updating a plugin, or adding a top-level template directory or `.obsidian` setting, run `mise run state` and commit the result with the change. `mise run release` refuses to run while it is stale.

## Checking what a change reaches

After changing synced content (plugins, directories, settings), `mise run compare <vault>` shows what an existing vault is missing or has out of date. `mise run sync` copies it.

## Safety

Never push, force-push, delete tags, or rewrite history without explicit confirmation from the user.
