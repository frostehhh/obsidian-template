# CLAUDE.md

Obsidian template vault (`template/`) plus the tooling around it (`scripts/`). Open `template/` as the vault; the repo root holds the scripts, changelog and config.

## Language

- **Prefer TypeScript** for new code and when substantially rewriting existing scripts. Existing `.js` files under `scripts/` stay as they are until they are touched.
- Node runs `.ts` files directly (type stripping, Node 22.18+), so there is no build step: `node scripts/foo/foo.ts`. Import siblings with their real extension (`./lib/cli.ts`; existing JS files are imported as `./lib/cli.js`).
- Keep to erasable syntax only (no `enum`, `namespace` or constructor parameter properties); `tsconfig.json` enforces this.
- `mise run typecheck` runs `tsc --noEmit`. `tsconfig.json` is strict and covers `scripts/` (JS is allowed but not type-checked).
- QuickAdd scripts and anything else inside `template/` run inside Obsidian and stay JavaScript.

## Tasks

Run through mise: `mise tasks` lists them. `sync`, `compare`, `state`, `release`, `typecheck`.

## Git, changelog and releases

Follow the `obsidian-template-git-workflow` skill: atomic commits in the repo's plain imperative style, a `changelog/unreleased.md` entry with every user-visible change, `mise run state` when plugins or template directories change, releases only through `mise run release`. Never push, force-push or push tags without explicit confirmation.

## Conventions

- `state.json` describes the template (plugins, syncable directories and settings). Keep it current with `mise run state`.
- Do not stage Obsidian-rewritten churn (plugin `data.json`, `workspace*.json`) or `.DS_Store`.
