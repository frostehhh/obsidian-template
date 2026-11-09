// vault-update: compares a vault with the template between the commit it was last recorded at (the base) and a
// target commit, per file and per JSON key. Read-only; apply.ts and record.ts build on it.
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { DIR_OPTIONS, PLUGIN_DIR_CONDITIONS, REPO_ROOT, SETTINGS_ITEMS, STATE, loadConfig, loadVaultConfig } from './cli.ts';
import { createMatcher } from './glob.ts';
import { deepEqual, isObject, patchCovers } from './jsonmerge.ts';
import type { JsonObject } from './jsonmerge.ts';
import { readLockFile } from './lock.ts';
import { mergePolicy } from './policy.ts';
import type { Policy } from './policy.ts';
import { pickTag, parseVersion, compareVersions } from './semver.ts';
import { hashContent, listTags } from './source.ts';
import type { ItemKind, Lock, LockV2, SyncConfig, Vault } from './types.ts';

const MAX_BUFFER = 512 * 1024 * 1024;
export const ABSENT = '-';
export const UNKNOWN = '?';
const QUICKADD_SCRIPTS = '--Configurations--/Scripts/QuickAdd';

// ---------- git ----------

export function git(args: string[]): Buffer {
  return execFileSync('git', args, { cwd: REPO_ROOT, maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] });
}

function gitText(args: string[]): string {
  return git(args).toString('utf8').trim();
}

function gitLines(args: string[]): string[] {
  return gitText(args).split('\n').filter(Boolean);
}

export function resolveRef(ref: string): string {
  try {
    return gitText(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  } catch {
    throw new Error(`Unknown git ref: ${ref}`);
  }
}

const trees = new Map<string, Map<string, string>>();

// template/ files at a commit, relative to template/ (= vault-relative paths) -> blob id.
export function treeAt(commit: string): Map<string, string> {
  const cached = trees.get(commit);
  if (cached) return cached;
  const tree = new Map<string, string>();
  for (const record of git(['ls-tree', '-r', '-z', commit, '--', 'template']).toString('utf8').split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    const sha = record.slice(0, tab).split(' ')[2];
    const path = record.slice(tab + 1);
    if (sha && path.startsWith('template/')) tree.set(path.slice('template/'.length), sha);
  }
  trees.set(commit, tree);
  return tree;
}

const blobs = new Map<string, Buffer | null>();

export function readBlob(sha: string): Buffer | null {
  if (blobs.has(sha)) return blobs.get(sha) ?? null;
  let content: Buffer | null;
  try {
    content = git(['cat-file', 'blob', sha]);
  } catch {
    content = null;
  }
  blobs.set(sha, content);
  return content;
}

// "0.4.0" for a tagged commit, "0.4.0+2.9d5029b" for one 2 commits after v0.4.0, "0.0.0+<sha>" without a tag.
export function versionOf(commit: string): string {
  const tags = gitLines(['tag', '--points-at', commit, '--list', 'v*'])
    .map((t) => ({ t, v: parseVersion(t) }))
    .filter((x) => x.v)
    .sort((a, b) => compareVersions(b.v!, a.v!));
  if (tags[0]) return tags[0].t.slice(1);
  try {
    const m = /^v(\d+\.\d+\.\d+)-(\d+)-g([0-9a-f]+)$/.exec(gitText(['describe', '--tags', '--match', 'v*', '--long', '--abbrev=7', commit]));
    if (m) return `${m[1]}+${m[2]}.${m[3]}`;
  } catch {
    // no tag before this commit
  }
  return `0.0.0+${commit.slice(0, 7)}`;
}

export interface Target {
  ref: string;
  commit: string;
  version: string;
}

// --to <ref>, or the latest v* tag (within the vault's pin).
export function resolveTarget(to: string | undefined, pin: string | undefined): Target {
  let ref = to;
  if (!ref) {
    const tag = pin ? pickTag(listTags(), pin) : (listTags()[0] ?? null);
    if (!tag) throw new Error(pin ? `No tag satisfies the pin "${pin}".` : 'No v* tag found. Pass --to <ref>.');
    ref = tag;
  }
  const commit = resolveRef(ref);
  return { ref, commit, version: versionOf(commit) };
}

// ---------- JSON key paths ----------

export type Seg = { key: string } | { id: string };

export function formatKey(segs: Seg[]): string {
  return segs
    .map((s, i) => {
      if ('id' in s) return `[${s.id}]`;
      if (/^[A-Za-z0-9_$-]+$/.test(s.key)) return i === 0 ? s.key : `.${s.key}`;
      return `[${JSON.stringify(s.key)}]`;
    })
    .join('');
}

export function parseKey(text: string): Seg[] {
  const segs: Seg[] = [];
  const re = /\.?([A-Za-z0-9_$-]+)|\[("(?:[^"\\]|\\.)*")\]|\[([^\]]+)\]/gy;
  let m: RegExpExecArray | null;
  while (re.lastIndex < text.length && (m = re.exec(text))) {
    if (m[1] !== undefined) segs.push({ key: m[1] });
    else if (m[2] !== undefined) segs.push({ key: JSON.parse(m[2]) as string });
    else if (m[3] !== undefined) segs.push({ id: m[3] });
  }
  if (re.lastIndex !== text.length && text.length > 0) throw new Error(`Invalid key path: ${text}`);
  return segs;
}

function keyedById(value: unknown): Map<string, JsonObject> | null {
  if (!Array.isArray(value)) return null;
  const map = new Map<string, JsonObject>();
  for (const item of value) {
    if (!isObject(item) || typeof item.id !== 'string' || map.has(item.id)) return null;
    map.set(item.id, item);
  }
  return map;
}

export function getAt(doc: unknown, segs: Seg[]): unknown {
  let current = doc;
  for (const s of segs) {
    if ('id' in s) {
      if (!Array.isArray(current)) return undefined;
      current = current.find((e) => isObject(e) && e.id === s.id);
    } else {
      if (!isObject(current)) return undefined;
      current = current[s.key];
    }
    if (current === undefined) return undefined;
  }
  return current;
}

// Sets (value) or deletes (undefined) a path; id segments append a missing element. Returns the new document.
export function setAt(doc: unknown, segs: Seg[], value: unknown): unknown {
  if (segs.length === 0) return value;
  const [head, ...rest] = segs as [Seg, ...Seg[]];
  if ('id' in head) {
    const list = Array.isArray(doc) ? [...doc] : [];
    const index = list.findIndex((e) => isObject(e) && e.id === head.id);
    const next = setAt(index >= 0 ? list[index] : undefined, rest, value);
    if (next === undefined) {
      if (index >= 0) list.splice(index, 1);
    } else if (index >= 0) list[index] = next;
    else list.push(next);
    return list;
  }
  const obj: JsonObject = isObject(doc) ? { ...doc } : {};
  const next = setAt(obj[head.key], rest, value);
  if (next === undefined) delete obj[head.key];
  else obj[head.key] = next;
  return obj;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  return value;
}

export function jsonHash(value: unknown): string {
  if (value === undefined) return ABSENT;
  return createHash('sha1').update(JSON.stringify(canonical(value))).digest('hex');
}

export interface KeyDiff {
  segs: Seg[];
  old: unknown;
  new: unknown;
}

// Paths where old and new differ, at the deepest level where both are objects (or id-keyed arrays).
// baseless: old is the vault's document; paths the template does not have (vault-only keys) are skipped.
export function diffJson(old: unknown, next: unknown, baseless = false): KeyDiff[] {
  const out: KeyDiff[] = [];
  function walk(o: unknown, n: unknown, segs: Seg[]): void {
    if (deepEqual(o, n)) return;
    if (baseless && n === undefined) return;
    if (isObject(o) && isObject(n)) {
      for (const k of new Set([...Object.keys(n), ...Object.keys(o)])) walk(o[k], n[k], [...segs, { key: k }]);
      return;
    }
    const om = keyedById(o);
    const nm = keyedById(n);
    if (om && nm) {
      for (const id of new Set([...nm.keys(), ...om.keys()])) walk(om.get(id), nm.get(id), [...segs, { id }]);
      return;
    }
    out.push({ segs, old: o, new: n });
  }
  walk(old, next, []);
  return out;
}

// ---------- classification ----------

export type EntryState = 'apply' | 'apply-auto' | 'apply-nobase' | 'done' | 'conflict' | 'declined' | 'protected' | 'drift';
export const NEEDS_DECISION: EntryState[] = ['apply', 'apply-auto', 'apply-nobase', 'conflict'];

// old: hash, ABSENT, or UNKNOWN (no base). auto: apply without asking (syncDataJson for data.json keys).
export function classify(old: string, vault: string, next: string, auto = false): EntryState {
  if (vault === next) return 'done';
  if (old === UNKNOWN) return vault === ABSENT ? 'apply-nobase' : 'conflict';
  if (vault === old) return auto ? 'apply-auto' : 'apply';
  return 'conflict';
}

export function renameState(old: string, next: string, vaultFrom: string, vaultTo: string): EntryState {
  if (vaultTo === next && vaultFrom === ABSENT) return 'done';
  if (vaultFrom === old && vaultTo === ABSENT) return 'apply';
  return 'conflict';
}

// decline keys: "path", "glob/**", "path#key" (covers the key and everything below it).
export function declineMatcher(declines: string[]): (path: string, key?: string, from?: string) => string | undefined {
  const rules = declines.map((d) => {
    const hash = d.indexOf('#');
    const pathPart = hash >= 0 ? d.slice(0, hash) : d;
    const keyPart = hash >= 0 ? d.slice(hash + 1) : undefined;
    return { d, match: createMatcher([pathPart]), keyPart };
  });
  return (path, key, from) => {
    for (const r of rules) {
      if (!r.match(path) && !(from && r.match(from))) continue;
      if (r.keyPart === undefined) return r.d;
      if (key !== undefined && (key === r.keyPart || key.startsWith(`${r.keyPart}.`) || key.startsWith(`${r.keyPart}[`))) return r.d;
    }
    return undefined;
  };
}

// ---------- scope ----------

export interface ScopeArgs {
  plugins?: string[];
  dirs?: string[];
  settings?: string[];
  dataJson?: boolean;
}

export type ScopeSource = 'cli' | 'vault config' | 'lock' | 'repo config' | 'none';

export interface Scope {
  plugins: string[];
  dirs: string[];
  settings: string[];
  linkedDirs: string[];
  items: string[];
  excluded: string[];
  sources: { plugins: ScopeSource; dirs: ScopeSource; settings: ScopeSource };
  syncDataJson: boolean;
}

export function parseItemKey(key: string): { kind: ItemKind; id: string } {
  const i = key.indexOf(':');
  return { kind: key.slice(0, i) as ItemKind, id: key.slice(i + 1) };
}

export function itemPrefix(key: string): string {
  const { kind, id } = parseItemKey(key);
  if (kind === 'plugin') return `.obsidian/plugins/${id}`;
  if (kind === 'dir') return id;
  return `.obsidian/${id}`;
}

function canonicalDir(id: string): string {
  return [...DIR_OPTIONS, ...PLUGIN_DIR_CONDITIONS.map((c) => c.dir)].find((d) => d.toLowerCase() === id.toLowerCase()) ?? id;
}

function uniqueCi(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((v) => (seen.has(v.toLowerCase()) ? false : (seen.add(v.toLowerCase()), true)));
}

// Same precedence as the sync wizard: CLI > vault config > (the lock's last recorded scope) > repo config.
export function resolveScope(
  vaultConfig: SyncConfig,
  repoConfig: SyncConfig,
  lockItems: string[] | null,
  cli: ScopeArgs,
  policy: Pick<Policy, 'isExcluded'>
): Scope {
  const fromLock = (kind: ItemKind) => (lockItems ?? []).map(parseItemKey).filter((k) => k.kind === kind).map((k) => k.id);
  function pick(kind: ItemKind, c?: string[], v?: string[], r?: string[]): { list: string[]; source: ScopeSource } {
    if (c) return { list: c, source: 'cli' };
    if (v) return { list: v, source: 'vault config' };
    if (lockItems) return { list: fromLock(kind), source: 'lock' };
    if (r) return { list: r, source: 'repo config' };
    return { list: [], source: 'none' };
  }
  const plugins = pick('plugin', cli.plugins, vaultConfig.defaultPlugins, repoConfig.defaultPlugins);
  const dirs = pick('dir', cli.dirs, vaultConfig.defaultDirs, repoConfig.defaultDirs);
  const settings = pick('setting', cli.settings, vaultConfig.defaultSettings, repoConfig.defaultSettings);
  const linkedDirs = PLUGIN_DIR_CONDITIONS.filter((c) => plugins.list.includes(c.pluginId)).map((c) => c.dir);
  const allDirs = uniqueCi([...dirs.list, ...linkedDirs].map(canonicalDir));
  const keys = [
    ...plugins.list.map((id) => ({ kind: 'plugin' as const, id })),
    ...allDirs.map((id) => ({ kind: 'dir' as const, id })),
    ...settings.list.map((id) => ({ kind: 'setting' as const, id })),
  ];
  const items: string[] = [];
  const excluded: string[] = [];
  for (const k of keys) (policy.isExcluded({ ...k, label: k.id }) ? excluded : items).push(`${k.kind}:${k.id}`);
  return {
    plugins: plugins.list,
    dirs: allDirs,
    settings: settings.list,
    linkedDirs,
    items: [...new Set(items)],
    excluded,
    sources: { plugins: plugins.source, dirs: dirs.source, settings: settings.source },
    syncDataJson: cli.dataJson ?? vaultConfig.syncDataJson ?? repoConfig.syncDataJson ?? false,
  };
}

// ---------- files ----------

function isIgnored(itemKind: ItemKind, prefix: string, path: string): boolean {
  if (path.split('/').at(-1) === '.DS_Store') return true;
  return itemKind === 'plugin' && path === `${prefix}/genericPreviewCache.json`;
}

function isDataJson(itemKind: ItemKind, prefix: string, path: string): boolean {
  return itemKind === 'plugin' && path === `${prefix}/data.json`;
}

export function isKeyedJson(itemKind: ItemKind, prefix: string, path: string): boolean {
  return isDataJson(itemKind, prefix, path) || (itemKind === 'setting' && path === prefix && path.endsWith('.json'));
}

export function filesUnder(tree: Map<string, string>, prefix: string, itemKind: ItemKind): Map<string, string> {
  const out = new Map<string, string>();
  for (const [path, sha] of tree) {
    if ((path === prefix || path.startsWith(`${prefix}/`)) && !isIgnored(itemKind, prefix, path)) out.set(path, sha);
  }
  return out;
}

async function vaultRead(vault: Vault, path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(join(vault.root, path));
  } catch {
    return undefined;
  }
}

function parseJson(content: Buffer | string | null | undefined): unknown {
  if (content === null || content === undefined) return undefined;
  try {
    return JSON.parse(content.toString());
  } catch {
    return undefined;
  }
}

// ---------- bases ----------

export type BaseVia = 'lock' | 'tag' | 'hash-match' | 'closest' | '--base' | 'none';

export interface ItemBase {
  item: string;
  commit: string | null;
  via: BaseVia;
  version: string | null;
  // hash match: "matched/recorded"
  score?: string;
  // closest candidate when no exact match (not used unless accepted with --base)
  candidate?: string;
  // v1: file hashes as last synced (vault paths)
  recorded?: Map<string, string>;
  // v1: old blob of data.json (from dataVersion), or UNKNOWN
  dataOld?: string;
}

// Score of a commit against hashes recorded by the v1 lock, ignoring data files.
export function matchScore(recorded: Map<string, string>, files: Map<string, string>): { matched: number; exact: boolean } {
  let matched = 0;
  for (const [path, hash] of recorded) if (files.get(path) === hash) matched += 1;
  return { matched, exact: matched === recorded.size && files.size === recorded.size };
}

function findHashBase(item: string, recorded: Map<string, string>): { commit: string | null; exact: boolean; score: string } {
  const { kind } = parseItemKey(item);
  const prefix = itemPrefix(item);
  const commits = gitLines(['log', '--format=%H', '-n', '300', 'HEAD', '--', `template/${prefix}`]);
  let best: { commit: string; matched: number } | null = null;
  for (const commit of commits) {
    const files = filesUnder(treeAt(commit), prefix, kind);
    for (const p of [...files.keys()]) if (isDataJson(kind, prefix, p)) files.delete(p);
    const { matched, exact } = matchScore(recorded, files);
    if (exact) return { commit, exact: true, score: `${matched}/${recorded.size}` };
    if (!best || matched > best.matched) best = { commit, matched };
  }
  return { commit: best && best.matched > 0 ? best.commit : null, exact: false, score: `${best?.matched ?? 0}/${recorded.size}` };
}

function tagCommit(version: string): string | null {
  if (!parseVersion(version)) return null;
  try {
    return resolveRef(`v${version}`);
  } catch {
    return null;
  }
}

export function resolveBases(lock: Lock | LockV2 | null, items: string[], baseOverride?: string): ItemBase[] {
  const override = baseOverride ? resolveRef(baseOverride) : null;
  return items.map((item): ItemBase => {
    if (lock?.lockVersion === 2) {
      if (lock.items.includes(item)) return { item, commit: lock.commit, via: 'lock', version: lock.version };
      return { item, commit: null, via: 'none', version: null };
    }
    const entry = lock?.items[item];
    if (!entry) return { item, commit: null, via: 'none', version: null };
    const prefix = itemPrefix(item);
    const recorded = new Map(Object.entries(entry.files).map(([f, h]) => [f ? `${prefix}/${f}` : prefix, h]));
    let dataOld = UNKNOWN;
    const dataCommit = entry.dataVersion ? tagCommit(entry.dataVersion) : null;
    if (dataCommit) dataOld = treeAt(dataCommit).get(`${prefix}/data.json`) ?? ABSENT;
    const base = { item, recorded, dataOld };
    const tagged = tagCommit(entry.templateVersion);
    if (tagged) return { ...base, commit: tagged, via: 'tag', version: entry.templateVersion };
    const found = findHashBase(item, recorded);
    if (found.exact && found.commit) return { ...base, commit: found.commit, via: 'hash-match', version: versionOf(found.commit), score: found.score };
    if (override) return { ...base, commit: override, via: '--base', version: versionOf(override), score: found.score };
    return { ...base, commit: null, via: found.commit ? 'closest' : 'none', version: null, score: found.score, ...(found.commit ? { candidate: found.commit } : {}) };
  });
}

// ---------- report ----------

export interface Entry {
  // "path", or "path#key" for a JSON key
  id: string;
  item: string;
  path: string;
  key?: string;
  from?: string;
  change: 'add' | 'modify' | 'delete' | 'rename';
  old: string;
  vault: string;
  new: string;
  vaultFrom?: string;
  state: EntryState;
  pending?: string;
  declinedBy?: string;
  patched?: boolean;
  commits: string[];
  label?: string;
  refs?: string[];
  // version the vault was at for this entry (for record --defer)
  baseVersion: string | null;
}

export interface Group {
  id: string;
  title: string;
  changelog: string[];
  entries: string[];
}

export interface Report {
  vault: { name: string; root: string; git: 'clean' | 'dirty' | 'not a repo' };
  lock: { version: 1 | 2 | null; label: string };
  target: Target;
  base: { commit: string; version: string } | null;
  bases: Array<Omit<ItemBase, 'recorded' | 'dataOld'>>;
  scope: Scope;
  entries: Entry[];
  groups: Group[];
  commits: Array<{ sha: string; subject: string }>;
  migrationNotes: string[];
  migrations: string[];
  declines: Array<{ key: string; label: string; stale: boolean }>;
  available: string[];
  deselected: Array<{ item: string; files: string[] }>;
  notEnabled: string[];
  missingRefs: Array<{ entry: string; ref: string }>;
  needsDecision: number;
}

export interface ReportOptions {
  vault: Vault;
  to?: string;
  base?: string;
  scope?: ScopeArgs;
  audit?: boolean;
}

function vaultGitState(vault: Vault): Report['vault']['git'] {
  try {
    const out = execFileSync('git', ['-C', vault.root, 'status', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim() ? 'dirty' : 'clean';
  } catch {
    return 'not a repo';
  }
}

function lockItemsOf(lock: Lock | LockV2 | null): string[] | null {
  if (!lock) return null;
  return lock.lockVersion === 2 ? lock.items : Object.keys(lock.items);
}

function lockLabel(lock: Lock | LockV2 | null): string {
  if (!lock) return 'none';
  if (lock.lockVersion === 2) return `v2 ${lock.version} (${lock.commit.slice(0, 7)})`;
  const versions = [...new Set(Object.values(lock.items).map((i) => i.templateVersion))].sort();
  return `v1 (${versions.join(', ') || 'empty'}) - migration needed`;
}

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (isObject(value)) for (const v of Object.values(value)) collectStrings(v, out);
  return out;
}

export function scriptRefs(path: string, content: string): string[] {
  if (!path.startsWith(`${QUICKADD_SCRIPTS}/`) || !path.endsWith('.js')) return [];
  const refs = new Set<string>();
  for (const m of content.matchAll(/vaultRequire\(\s*app\s*,\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
    const name = m[1] as string;
    refs.add(`${QUICKADD_SCRIPTS}/${name.endsWith('.js') ? name : `${name}.js`}`);
  }
  return [...refs].sort();
}

function choiceLabel(doc: unknown, segs: Seg[]): string | undefined {
  for (let i = 1; i <= segs.length; i++) {
    const seg = segs[i - 1] as Seg;
    if (!('id' in seg)) continue;
    const element = getAt(doc, segs.slice(0, i));
    if (isObject(element) && typeof element.name === 'string') return element.name;
  }
  return undefined;
}

const subjects = new Map<string, string>();
function subjectOf(sha: string): string {
  if (!subjects.has(sha)) subjects.set(sha, gitText(['log', '-1', '--format=%s', sha]));
  return subjects.get(sha) as string;
}

const changelogCache = new Map<string, string[]>();
function changelogLines(sha: string): string[] {
  if (!changelogCache.has(sha)) {
    const lines = git(['show', '--format=', '--unified=0', sha, '--', 'changelog/'])
      .toString('utf8')
      .split('\n')
      .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
      .map((l) => l.slice(1).trim())
      .filter((l) => l && !l.startsWith('<!--') && !l.startsWith('#'));
    changelogCache.set(sha, lines);
  }
  return changelogCache.get(sha) as string[];
}

function commitsTouching(base: string, target: string, paths: string[]): string[] {
  return gitLines(['log', '--reverse', '--format=%H', `${base}..${target}`, '--', ...paths.map((p) => `template/${p}`)]);
}

function docAt(commit: string, path: string): unknown {
  const sha = treeAt(commit).get(path);
  return sha ? parseJson(readBlob(sha)) : undefined;
}

function oldestCommit(commits: string[], target: string): string | null {
  const behind = (c: string) => Number(gitText(['rev-list', '--count', `${c}..${target}`]));
  return [...commits].sort((a, b) => behind(b) - behind(a))[0] ?? null;
}

const renameCache = new Map<string, Map<string, string>>();
// Files moved under template/ between two commits: new path -> old path.
export function renamesBetween(base: string, target: string): Map<string, string> {
  const key = `${base}..${target}`;
  const cached = renameCache.get(key);
  if (cached) return cached;
  const out = git(['diff', '-M', '--name-status', '-z', base, target, '--', 'template']).toString('utf8').split('\0');
  const map = new Map<string, string>();
  for (let i = 0; i < out.length; i++) {
    const status = out[i] ?? '';
    if (!status) continue;
    if (status.startsWith('R') || status.startsWith('C')) {
      if (status.startsWith('R')) map.set((out[i + 2] ?? '').slice('template/'.length), (out[i + 1] ?? '').slice('template/'.length));
      i += 2;
    } else i += 1;
  }
  renameCache.set(key, map);
  return map;
}

function parentOf(commit: string): string | null {
  try {
    return resolveRef(`${commit}^`);
  } catch {
    return null;
  }
}

export async function buildReport(options: ReportOptions): Promise<Report> {
  const { vault } = options;
  const lock = await readLockFile(vault);
  const vaultConfig = await loadVaultConfig(vault.root);
  const repoConfig = await loadConfig();
  const policy = mergePolicy(vaultConfig, repoConfig);
  const target = resolveTarget(options.to, policy.pin);
  const targetTree = treeAt(target.commit);
  const lockItems = lockItemsOf(lock);
  const scope = resolveScope(vaultConfig, repoConfig, lockItems, options.scope ?? {}, policy);
  const bases = resolveBases(lock, scope.items, options.base);
  const pending = lock?.lockVersion === 2 ? (lock.pending ?? {}) : {};
  const declines = vaultConfig.decline ?? {};
  const declinedBy = declineMatcher(Object.keys(declines));
  const entries: Entry[] = [];

  const vaultHashes = new Map<string, string>();
  async function vaultHash(path: string): Promise<string> {
    if (!vaultHashes.has(path)) {
      const content = await vaultRead(vault, path);
      vaultHashes.set(path, content === undefined ? ABSENT : hashContent(content));
    }
    return vaultHashes.get(path) as string;
  }

  for (const base of bases) {
    const { kind } = parseItemKey(base.item);
    const prefix = itemPrefix(base.item);
    const newFiles = filesUnder(targetTree, prefix, kind);
    const baseFiles = base.commit ? filesUnder(treeAt(base.commit), prefix, kind) : new Map<string, string>();
    const oldOf = (path: string): string => {
      if (base.recorded) {
        const recorded = base.recorded.get(path);
        if (recorded) return recorded;
        if (isDataJson(kind, prefix, path)) return base.dataOld ?? UNKNOWN;
        return base.commit ? (baseFiles.get(path) ?? ABSENT) : UNKNOWN;
      }
      return base.commit ? (baseFiles.get(path) ?? ABSENT) : UNKNOWN;
    };
    const pendingPaths = Object.keys(pending)
      .map((id) => id.split('#')[0] as string)
      .filter((p) => p === prefix || p.startsWith(`${prefix}/`));
    const paths = [...new Set([...newFiles.keys(), ...baseFiles.keys(), ...(base.recorded?.keys() ?? []), ...pendingPaths])]
      .filter((p) => !isIgnored(kind, prefix, p))
      .sort();

    for (const path of paths) {
      const next = newFiles.get(path) ?? ABSENT;
      const filePending = pending[path];
      const old = filePending?.old ?? oldOf(path);
      const keyPending = Object.keys(pending).filter((id) => id.startsWith(`${path}#`));
      const common = { item: base.item, path, commits: [] as string[], baseVersion: base.version };

      if (old === next && !filePending && keyPending.length === 0) {
        if (options.audit && next !== ABSENT) {
          const v = await vaultHash(path);
          if (v !== next && !isKeyedJson(kind, prefix, path)) {
            entries.push({ ...common, id: path, change: 'modify', old, vault: v, new: next, state: 'drift' });
          }
        }
        continue;
      }

      const v = await vaultHash(path);
      if (isKeyedJson(kind, prefix, path) && next !== ABSENT && v !== ABSENT && v !== next) {
        const vaultDoc = parseJson(await vaultRead(vault, path));
        const newDoc = parseJson(readBlob(next));
        const oldDoc = old === ABSENT ? {} : old === UNKNOWN ? undefined : parseJson(readBlob(old));
        const baseless = old === UNKNOWN || oldDoc === undefined;
        if (isObject(vaultDoc) && isObject(newDoc) && (baseless || isObject(oldDoc))) {
          const diffs = diffJson(baseless ? vaultDoc : oldDoc, newDoc, baseless);
          const seen = new Set(diffs.map((d) => formatKey(d.segs)));
          for (const id of keyPending) {
            const key = id.slice(path.length + 1);
            if (!seen.has(key)) diffs.push({ segs: parseKey(key), old: undefined, new: getAt(newDoc, parseKey(key)) });
          }
          const patch = policy.patches[path];
          for (const d of diffs) {
            const key = formatKey(d.segs);
            const id = `${path}#${key}`;
            const p = pending[id];
            const o = p ? p.old : baseless ? UNKNOWN : jsonHash(d.old);
            const n = jsonHash(d.new);
            const vv = jsonHash(getAt(vaultDoc, d.segs));
            const entry: Entry = {
              ...common,
              id,
              key,
              change: o === ABSENT || (o === UNKNOWN && vv === ABSENT) ? 'add' : n === ABSENT ? 'delete' : 'modify',
              old: o,
              vault: vv,
              new: n,
              state: classify(o, vv, n, scope.syncDataJson && isDataJson(kind, prefix, path)),
            };
            if (p) entry.pending = p.since;
            const label = choiceLabel(newDoc, d.segs) ?? choiceLabel(vaultDoc, d.segs);
            if (label) entry.label = label;
            const refs = collectStrings(d.new).filter((s) => s.endsWith('.js') && s.includes('/'));
            if (refs.length) entry.refs = [...new Set(refs)].sort();
            if (patch !== undefined && entry.state !== 'done' && patchCovers(patch, d.segs.map((s) => ('id' in s ? s.id : s.key)))) {
              entry.state = 'done';
              entry.patched = true;
            }
            entries.push(entry);
          }
          continue;
        }
      }

      const entry: Entry = {
        ...common,
        id: path,
        change: old === ABSENT || (old === UNKNOWN && v === ABSENT) ? 'add' : next === ABSENT ? 'delete' : 'modify',
        old,
        vault: v,
        new: next,
        state: classify(old, v, next),
      };
      if (filePending) entry.pending = filePending.since;
      if (next !== ABSENT) {
        const refs = scriptRefs(path, readBlob(next)?.toString('utf8') ?? '');
        if (refs.length) entry.refs = refs;
      }
      entries.push(entry);
    }
  }

  // Moves, across the whole template (a file can move between items). Base: the item's, else the vault's oldest.
  const baseOf = new Map(bases.map((b) => [b.item, b.commit]));
  const knownCommits = [...new Set(bases.map((b) => b.commit).filter((c): c is string => c !== null))];
  const renameBase = lock?.lockVersion === 2 ? lock.commit : oldestCommit(knownCommits, target.commit);
  for (const a of [...entries]) {
    if (a.change !== 'add' || a.key !== undefined) continue;
    const baseCommit = baseOf.get(a.item) ?? renameBase;
    if (!baseCommit) continue;
    const from = renamesBetween(baseCommit, target.commit).get(a.path);
    if (!from) continue;
    const del = entries.findIndex((e) => e.id === from && e.change === 'delete' && e.key === undefined);
    const d = del >= 0 ? (entries[del] as Entry) : undefined;
    const old = d ? d.old : (treeAt(baseCommit).get(from) ?? ABSENT);
    const vaultFrom = d ? d.vault : await vaultHash(from);
    if (!d && vaultFrom === ABSENT) continue;
    const merged: Entry = { ...a, from, change: 'rename', old, vaultFrom, state: renameState(old, a.new, vaultFrom, a.vault) };
    entries.splice(entries.indexOf(a), 1, merged);
    if (d) entries.splice(entries.indexOf(d), 1);
  }

  const jsonCommits = new Map<string, string[]>();
  for (const e of entries) {
    const baseCommit = baseOf.get(e.item) ?? (e.change === 'rename' ? renameBase : null);
    if (!baseCommit || e.pending) continue;
    if (e.key === undefined) {
      e.commits = commitsTouching(baseCommit, target.commit, e.from ? [e.path, e.from] : [e.path]);
      continue;
    }
    const cacheKey = `${baseCommit}:${e.path}`;
    if (!jsonCommits.has(cacheKey)) jsonCommits.set(cacheKey, commitsTouching(baseCommit, target.commit, [e.path]));
    const segs = parseKey(e.key);
    e.commits = (jsonCommits.get(cacheKey) as string[]).filter((c) => {
      const parent = parentOf(c);
      return !deepEqual(getAt(parent ? docAt(parent, e.path) : undefined, segs), getAt(docAt(c, e.path), segs));
    });
  }

  for (const e of entries) {
    if (e.state === 'done' || e.state === 'drift') continue;
    if (policy.isProtected(e.path) || (e.from !== undefined && policy.isProtected(e.from))) {
      e.state = 'protected';
      continue;
    }
    const by = declinedBy(e.path, e.key, e.from);
    if (by) {
      e.state = 'declined';
      e.declinedBy = by;
    }
  }

  const newItems = new Set(scope.items.filter((i) => !(lockItems ?? []).includes(i)));
  const groups = new Map<string, Group>();
  for (const e of entries) {
    if (e.state === 'drift') continue;
    const first = e.commits[0];
    const id = first ?? (e.pending ? 'pending' : newItems.has(e.item) ? `install:${e.item}` : 'no-base');
    if (!groups.has(id)) {
      const title = first
        ? `${first.slice(0, 7)} ${subjectOf(first)}`
        : id === 'pending'
          ? 'Deferred earlier'
          : id.startsWith('install:')
            ? `Newly selected ${id.slice('install:'.length)}`
            : 'No recorded base (compared with the target only)';
      groups.set(id, { id, title, changelog: first ? changelogLines(first) : [], entries: [] });
    }
    (groups.get(id) as Group).entries.push(e.id);
  }

  const known = bases.filter((b): b is ItemBase & { commit: string } => b.commit !== null);
  const distinct = [...new Set(known.map((b) => b.commit))];
  const oldest = oldestCommit(distinct, target.commit);
  // Commits that changed an in-scope item after that item's base.
  const inRange = new Set<string>();
  for (const b of known) for (const c of commitsTouching(b.commit, target.commit, [itemPrefix(b.item)])) inRange.add(c);
  const ordered = oldest ? gitLines(['log', '--reverse', '--format=%H', `${oldest}..${target.commit}`, '--', 'template']) : [];
  const commits = ordered.filter((c) => inRange.has(c)).map((sha) => ({ sha, subject: subjectOf(sha) }));
  const migrationNotes = commits.flatMap((c) => changelogLines(c.sha).filter((l) => l.startsWith('- ') && /\*\*Migration/i.test(l)));
  const main = oldest;
  const doneMigrations = new Set(lock?.lockVersion === 1 ? (lock.migrations ?? []) : []);
  const migrationFiles = (ref: string) => gitLines(['ls-tree', '--name-only', ref, 'migrations/']).filter((f) => /\/\d+\.\d+\.\d+\.ts$/.test(f));
  const migrations = main
    ? migrationFiles(target.commit)
        .filter((f) => !migrationFiles(main).includes(f))
        .filter((f) => !doneMigrations.has(f.slice('migrations/'.length, -3)))
    : [];

  const targetDocs = new Map<string, unknown>();
  const declineList = Object.entries(declines).map(([key, label]) => {
    const hash = key.indexOf('#');
    const pathPart = hash >= 0 ? key.slice(0, hash) : key;
    const match = createMatcher([pathPart]);
    const files = [...targetTree.keys()].filter((p) => match(p));
    let stale = files.length === 0;
    if (!stale && hash >= 0) {
      const file = files[0] as string;
      if (!targetDocs.has(file)) targetDocs.set(file, parseJson(readBlob(targetTree.get(file) as string)));
      stale = getAt(targetDocs.get(file), parseKey(key.slice(hash + 1))) === undefined;
    }
    return { key, label, stale };
  });

  const available: string[] = [];
  const candidates = [
    ...STATE.plugins.map((p) => `plugin:${p.id}`),
    ...uniqueCi([...DIR_OPTIONS, ...PLUGIN_DIR_CONDITIONS.map((c) => c.dir)]).map((d) => `dir:${d}`),
    ...SETTINGS_ITEMS.map((s) => `setting:${s}`),
  ];
  for (const key of candidates) {
    if (scope.items.some((i) => i.toLowerCase() === key.toLowerCase()) || scope.excluded.includes(key)) continue;
    if (filesUnder(targetTree, itemPrefix(key), parseItemKey(key).kind).size > 0) available.push(key);
  }

  const deselected: Report['deselected'] = [];
  for (const item of (lockItems ?? []).filter((i) => !scope.items.includes(i))) {
    const prefix = itemPrefix(item);
    const tracked =
      lock?.lockVersion === 1
        ? Object.keys(lock.items[item]?.files ?? {}).map((f) => (f ? `${prefix}/${f}` : prefix))
        : lock?.lockVersion === 2
          ? [...filesUnder(treeAt(lock.commit), prefix, parseItemKey(item).kind).keys()]
          : [];
    const present: string[] = [];
    for (const f of tracked) if ((await vaultHash(f)) !== ABSENT) present.push(f);
    deselected.push({ item, files: present });
  }

  let community: string[] = [];
  try {
    community = JSON.parse(await readFile(join(vault.root, '.obsidian', 'community-plugins.json'), 'utf8'));
  } catch {
    community = [];
  }
  const notEnabled = scope.plugins.filter((id) => scope.items.includes(`plugin:${id}`) && !community.includes(id));

  const missingRefs: Report['missingRefs'] = [];
  for (const e of entries) {
    if (!e.refs || e.state === 'done' || e.state === 'declined' || e.state === 'protected' || e.state === 'drift') continue;
    for (const ref of e.refs) {
      const providing = entries.find((x) => x.path === ref && x.key === undefined && x.new !== ABSENT);
      const ok = providing ? !['declined', 'protected'].includes(providing.state) : (await vaultHash(ref)) !== ABSENT;
      if (!ok) missingRefs.push({ entry: e.id, ref });
    }
  }

  return {
    vault: { name: vault.name, root: vault.root, git: vaultGitState(vault) },
    lock: { version: lock ? lock.lockVersion : null, label: lockLabel(lock) },
    target,
    base: distinct.length === 1 && main ? { commit: main, version: versionOf(main) } : null,
    bases: bases.map(({ recorded: _r, dataOld: _d, ...rest }) => rest),
    scope,
    entries,
    groups: [...groups.values()],
    commits,
    migrationNotes,
    migrations,
    declines: declineList,
    available,
    deselected,
    notEnabled,
    missingRefs,
    needsDecision: entries.filter((e) => NEEDS_DECISION.includes(e.state)).length,
  };
}

// ---------- record ----------

export interface Decisions {
  keep: string[];
  defer: string[];
  // decline key -> label ("" lets record pick one)
  decline: Record<string, string>;
}

export interface DecisionCheck {
  problems: string[];
  pending: NonNullable<LockV2['pending']>;
  declines: Record<string, string>;
  kept: string[];
}

// Every entry that needs a decision must be kept (conflicts only), deferred or declined; nothing else may be named.
export function checkDecisions(entries: Entry[], d: Decisions, fallbackSince: string): DecisionCheck {
  const problems: string[] = [];
  const byId = new Map(entries.map((e) => [e.id, e]));
  const open = entries.filter((e) => NEEDS_DECISION.includes(e.state));
  const keep = new Set(d.keep);
  const defer = new Set(d.defer);
  const declinedBy = declineMatcher(Object.keys(d.decline));

  for (const id of keep) {
    const e = byId.get(id);
    if (!e) problems.push(`--keep ${id}: no such entry`);
    else if (e.state !== 'conflict') problems.push(`--keep ${id}: only conflicts can be kept (state ${e.state})`);
  }
  for (const id of defer) {
    const e = byId.get(id);
    if (!e) problems.push(`--defer ${id}: no such entry`);
    else if (!NEEDS_DECISION.includes(e.state)) problems.push(`--defer ${id}: nothing to defer (state ${e.state})`);
    if (keep.has(id)) problems.push(`${id}: both kept and deferred`);
  }
  const declines: Record<string, string> = {};
  for (const [key, label] of Object.entries(d.decline)) {
    const hash = key.indexOf('#');
    const one = declineMatcher([key]);
    const matched = open.filter((e) => one(e.path, e.key, e.from));
    if (matched.length === 0) {
      problems.push(`--decline ${key}: matches no open entry`);
      continue;
    }
    declines[key] = label || matched.find((e) => e.label)?.label || (hash >= 0 ? key.slice(hash + 1) : key);
  }
  for (const e of open) {
    if (keep.has(e.id) || defer.has(e.id) || declinedBy(e.path, e.key, e.from)) continue;
    problems.push(`${e.id}: ${e.state}, not applied and no decision (apply it, or --keep/--defer/--decline)`);
  }

  const pending: NonNullable<LockV2['pending']> = {};
  for (const id of defer) {
    const e = byId.get(id);
    if (!e) continue;
    const since = e.pending ?? e.baseVersion ?? fallbackSince;
    if (e.change === 'rename' && e.from) {
      pending[e.from] = { old: e.old, since };
      pending[e.path] = { old: ABSENT, since };
    } else pending[e.id] = { old: e.old, since };
  }
  return { problems, pending, declines, kept: [...keep] };
}

// ---------- text output ----------

const STATE_LABEL: Record<EntryState, string> = {
  apply: 'apply',
  'apply-auto': 'apply (auto)',
  'apply-nobase': 'apply (no base)',
  done: 'done',
  conflict: 'conflict',
  declined: 'declined',
  protected: 'protected',
  drift: 'drift',
};

function describeEntry(e: Entry): string {
  const what = e.key !== undefined ? `${e.path}  ${e.key}` : e.from ? `${e.from} -> ${e.path}` : e.path;
  const extra = [
    e.label ? `"${e.label}"` : '',
    e.pending ? `pending since ${e.pending}` : '',
    e.declinedBy ? `by ${e.declinedBy}` : '',
    e.patched ? 'decided by patch' : '',
    e.refs?.length ? `needs ${e.refs.map((r) => r.split('/').at(-1)).join(', ')}` : '',
  ].filter(Boolean);
  return `${STATE_LABEL[e.state].padEnd(16)} ${e.change.padEnd(7)} ${what}${extra.length ? `   (${extra.join('; ')})` : ''}`;
}

export function renderReport(r: Report, { all = false }: { all?: boolean } = {}): string {
  const lines: string[] = [];
  lines.push(`vault: ${r.vault.name}   git: ${r.vault.git}   lock: ${r.lock.label}`);
  const mixed = r.bases.some((b) => b.commit) ? 'mixed (per item, below)' : 'none';
  lines.push(`target: ${r.target.ref} = ${r.target.version} (${r.target.commit.slice(0, 7)})   base: ${r.base ? `${r.base.version} (${r.base.commit.slice(0, 7)})` : mixed}`);
  if (!r.base) {
    const byBase = new Map<string, string[]>();
    for (const b of r.bases) {
      const where = b.commit
        ? `${b.via} ${b.commit.slice(0, 7)} (${b.version})`
        : b.candidate
          ? `NO EXACT MATCH, closest ${b.candidate.slice(0, 7)} (${versionOf(b.candidate)})`
          : b.via === 'none' && b.score
            ? 'NO MATCH'
            : 'none (new in scope)';
      const label = b.commit || !b.score ? b.item : `${b.item} ${b.score}`;
      byBase.set(where, [...(byBase.get(where) ?? []), label]);
    }
    for (const [where, items] of byBase) lines.push(`  base ${where}: ${items.join(', ')}`);
  }
  lines.push(`scope: ${r.scope.items.length} items (plugins: ${r.scope.sources.plugins}, dirs: ${r.scope.sources.dirs}, settings: ${r.scope.sources.settings})   syncDataJson: ${r.scope.syncDataJson}`);
  if (r.commits.length) lines.push(`commits: ${r.commits.length}`);
  const byId = new Map(r.entries.map((e) => [e.id, e]));
  for (const g of r.groups) {
    const list = g.entries.map((id) => byId.get(id) as Entry).filter((e) => all || e.state !== 'done');
    const done = g.entries.length - list.length;
    if (list.length === 0 && !all) continue;
    lines.push('', `## ${g.title}${done ? `   (+${done} done)` : ''}`);
    for (const c of g.changelog) lines.push(`   changelog: ${c}`);
    for (const e of list) lines.push(`  ${describeEntry(e)}`);
  }
  const drift = r.entries.filter((e) => e.state === 'drift');
  if (drift.length) {
    lines.push('', '## Drift (vault differs, template unchanged in range)');
    for (const e of drift) lines.push(`  ${describeEntry(e)}`);
  }
  const doneTotal = r.entries.filter((e) => e.state === 'done').length;
  if (doneTotal && !all) lines.push('', `${doneTotal} entr${doneTotal === 1 ? 'y' : 'ies'} already done (--all to list)`);
  if (r.missingRefs.length) {
    lines.push('', 'Dependency warnings:');
    for (const m of r.missingRefs) lines.push(`  ${m.entry} needs ${m.ref}, which the vault will not have`);
  }
  if (r.migrationNotes.length || r.migrations.length) {
    lines.push('', 'Migrations:');
    for (const m of r.migrations) lines.push(`  run by hand: ${m}`);
    for (const n of r.migrationNotes) lines.push(`  note: ${n}`);
  }
  const stale = r.declines.filter((d) => d.stale);
  if (stale.length) lines.push('', `Stale declines (template no longer has them): ${stale.map((d) => d.key).join(', ')}`);
  if (r.deselected.length) {
    lines.push('', 'Deselected (no longer tracked, files left in place):');
    for (const d of r.deselected) lines.push(`  ${d.item}: ${d.files.length} file(s) still in the vault`);
  }
  if (r.available.length) lines.push('', `Available, not selected: ${r.available.join(', ')}`);
  if (r.notEnabled.length) lines.push(`Not enabled in community-plugins.json: ${r.notEnabled.join(', ')}`);
  lines.push('', `Needs a decision: ${r.needsDecision}`);
  return lines.join('\n');
}

// ---------- scope listing (report --scope) ----------

export interface ScopeOption {
  key: string;
  label: string;
  selected: boolean;
  linked?: string;
  status: string;
}

export async function scopeOptions(vault: Vault, r: Report): Promise<ScopeOption[]> {
  const tree = treeAt(r.target.commit);
  const out: ScopeOption[] = [];
  const keys = [
    ...STATE.plugins.map((p) => ({ key: `plugin:${p.id}`, label: `${p.name} v${p.version}` })),
    ...uniqueCi([...DIR_OPTIONS, ...PLUGIN_DIR_CONDITIONS.map((c) => c.dir)]).map((d) => ({ key: `dir:${d}`, label: d })),
    ...SETTINGS_ITEMS.map((s) => ({ key: `setting:${s}`, label: s })),
  ];
  for (const { key, label } of keys) {
    const { kind } = parseItemKey(key);
    const prefix = itemPrefix(key);
    const files = filesUnder(tree, prefix, kind);
    if (files.size === 0) continue;
    let missing = 0;
    let differs = 0;
    for (const [path, sha] of files) {
      if (isDataJson(kind, prefix, path)) continue;
      const content = await vaultRead(vault, path);
      if (content === undefined) missing += 1;
      else if (hashContent(content) !== sha) differs += 1;
    }
    const total = [...files.keys()].filter((p) => !isDataJson(kind, prefix, p)).length;
    const status = missing === total ? 'not in vault' : differs || missing ? `${differs} differ, ${missing} missing` : 'matches target';
    const linked = PLUGIN_DIR_CONDITIONS.find((c) => kind === 'dir' && c.dir.toLowerCase() === parseItemKey(key).id.toLowerCase());
    const option: ScopeOption = { key, label, selected: r.scope.items.some((i) => i.toLowerCase() === key.toLowerCase()), status };
    if (linked) option.linked = `plugin:${linked.pluginId}`;
    if (r.scope.excluded.includes(key)) option.status += ', excluded';
    out.push(option);
  }
  return out;
}
