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
  destExists: boolean;
}

export interface ItemResult extends Item {
  status: Status;
  files: TreeComparison;
  templateVersion?: string | null;
  vaultVersion?: string | null;
}

export interface VaultReport {
  vault: Vault;
  results: ItemResult[];
}
