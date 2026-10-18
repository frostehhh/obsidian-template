# Unreleased

<!-- One line per user-visible change, added in the same commit as the change.
Group under Added / Changed / Deprecated / Removed / Fixed / Security.
Breaking changes need a **Migration** note. -->

## Added

- Add `--non-interactive` flag to `sync`, `--vaults` to `compare`, and `--yes` to `release` for agent/CI usage
- Add `scripts/agent/sync.ts`, `scripts/agent/compare.ts`, `scripts/agent/release.ts`, `scripts/agent/state.ts` as thin non-interactive wrappers
- Add `scripts/lib/sync.ts` and `scripts/lib/release.ts` shared libraries containing the core logic
- Register `agent:sync`, `agent:compare`, `agent:release`, `agent:state` tasks in `mise.toml`

## Changed

- Refactor `scripts/sync/sync.ts`, `scripts/compare/compare.ts`, and `scripts/release/release.ts` to delegate to shared libraries and support non-interactive mode
- Update `scripts/sync/README.md` with non-interactive usage examples
