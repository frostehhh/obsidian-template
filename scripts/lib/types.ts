export type ItemKind = 'plugin' | 'dir' | 'setting';
export type Status = 'in sync' | 'outdated' | 'partial' | 'not synced';

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
}

export interface State {
  template: string;
  plugins: PluginInfo[];
  dirs: {
    selectable: string[];
    pluginLinked: { plugin: string; dir: string }[];
    excluded: string[];
  };
  settings: {
    syncable: { name: string; type: 'file' | 'directory' }[];
    excluded: string[];
  };
  dataFiles: string[];
}

export interface SyncConfig {
  defaultPlugins?: string[];
  defaultVaults?: string[];
  defaultDirs?: string[];
  defaultSettings?: string[];
  syncDataJson?: boolean;
  // Vault-relative globs sync never writes or deletes ("Notes/Templates/**").
  protect?: string[];
  // Items left out of sync and compare: "plugin:<id>", "dir:<name>", "setting:<name>".
  exclude?: string[];
  // Version range the vault stays within ("0.2.x", "^0.3.0", "0.3.1"): default source is the highest matching tag.
  pin?: string;
}

export interface Vault {
  name: string;
  root: string;
  pluginsDir: string;
  communityPluginsPath: string;
}

export interface Item {
  kind: ItemKind;
  id: string;
  label: string;
}

export interface TreeComparison {
  match: string[];
  differs: string[];
  missing: string[];
  extra: string[];
  // Vault differs from the template, but the template did not change since the last sync: a local override.
  overridden: string[];
  // Removed from the template since the last sync, still present and unchanged in the vault.
  stale: string[];
  destExists: boolean;
}

export interface ItemResult extends Item {
  status: Status;
  files: TreeComparison;
  templateVersion?: string | null;
  vaultVersion?: string | null;
  // Template version this item was last synced from, per the vault's lock file (null: untracked).
  syncedVersion?: string | null;
}

export type ConflictPolicy = 'skip' | 'take-template' | 'keep-vault';

export interface SourceFile {
  file: string;
  hash: string;
}

// Where template content comes from: a git tag (deterministic) or the working tree.
export interface TemplateSource {
  ref: string;
  // Version recorded in lock files, e.g. "0.3.1" or "working-tree".
  version: string;
  // Human readable, e.g. "v0.3.1".
  label: string;
  // Files under template/<rel>, relative to it, sorted. [''] when rel is a file, [] when it does not exist.
  list(rel: string): Promise<SourceFile[]>;
  read(rel: string, file: string): Promise<Buffer>;
}

export interface LockItem {
  templateVersion: string;
  files: Record<string, string>;
}

export interface Lock {
  lockVersion: 1;
  items: Record<string, LockItem>;
}

export interface VaultReport {
  vault: Vault;
  results: ItemResult[];
}
