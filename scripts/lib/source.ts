import { readdir, readFile, stat } from 'fs/promises';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { pickTag, satisfies } from './semver.ts';
import type { SourceFile, TemplateSource } from './types.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEMPLATE = join(REPO, 'template');
const MAX_BUFFER = 512 * 1024 * 1024;

export const WORKING_TREE = 'working-tree';

// Git blob hash: sha1("blob <size>\0" + content). Equals the object id for files in a git tree.
export function hashContent(content: Buffer): string {
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

function git(args: string[]): Buffer {
  return execFileSync('git', args, { cwd: REPO, maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] });
}

// v* tags, newest first.
export function listTags(): string[] {
  try {
    return git(['tag', '--list', 'v*', '--sort=-v:refname']).toString('utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

export function latestTag(): string | null {
  return listTags()[0] ?? null;
}

// Full commit id a ref points at.
export function commitOf(ref: string): string {
  try {
    return git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).toString('utf8').trim();
  } catch {
    throw new Error(`Unknown git ref: ${ref}`);
  }
}

export function workingTreeSource(): TemplateSource {
  async function walk(dir: string, prefix: string, out: SourceFile[]): Promise<void> {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      if (entry.name === '.DS_Store') continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(dir, entry.name), rel, out);
      else if (entry.isFile()) out.push({ file: rel, hash: hashContent(await readFile(join(dir, entry.name))) });
    }
  }

  return {
    ref: WORKING_TREE,
    version: WORKING_TREE,
    label: WORKING_TREE,
    async list(rel) {
      const full = join(TEMPLATE, rel);
      let info;
      try {
        info = await stat(full);
      } catch {
        return [];
      }
      if (info.isFile()) return [{ file: '', hash: hashContent(await readFile(full)) }];
      const out: SourceFile[] = [];
      await walk(full, '', out);
      return out;
    },
    read: (rel, file) => readFile(join(TEMPLATE, rel, file)),
  };
}

// Reads template/ straight from git objects at a ref, ignoring the working tree.
// version overrides the version recorded in locks (used when the ref is a commit id taken from a plan file).
export function gitSource(ref: string, version?: string): TemplateSource {
  commitOf(ref);

  let tree: Map<string, string> | undefined;
  function loadTree(): Map<string, string> {
    if (tree) return tree;
    const entries: [string, string][] = [];
    for (const record of git(['ls-tree', '-r', '-z', ref, '--', 'template']).toString('utf8').split('\0')) {
      if (!record) continue;
      const tab = record.indexOf('\t');
      const sha = record.slice(0, tab).split(' ')[2];
      const path = record.slice(tab + 1);
      if (sha && path.startsWith('template/')) entries.push([path.slice('template/'.length), sha]);
    }
    entries.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    tree = new Map(entries);
    return tree;
  }

  const resolvedVersion = version ?? (/^v\d/.test(ref) ? ref.slice(1) : ref);
  return {
    ref,
    version: resolvedVersion,
    label: version ? `v${version}` : ref,
    async list(rel) {
      const files = loadTree();
      const direct = files.get(rel);
      if (direct) return [{ file: '', hash: direct }];
      const prefix = `${rel}/`;
      const out: SourceFile[] = [];
      for (const [path, hash] of files) {
        if (path.startsWith(prefix)) out.push({ file: path.slice(prefix.length), hash });
      }
      return out;
    },
    async read(rel, file) {
      const path = file ? `${rel}/${file}` : rel;
      const sha = loadTree().get(path);
      if (!sha) throw new Error(`${path} does not exist in template at ${ref}`);
      return git(['cat-file', 'blob', sha]);
    },
  };
}

// --from <ref>: a git ref, "working-tree", or (default) the latest v* tag, or the latest one within the vault's pin.
// An explicit ref outside the pin is refused unless ignorePin is set.
export function resolveSource(from?: string, pin?: string, { ignorePin = false }: { ignorePin?: boolean } = {}): TemplateSource {
  if (from === WORKING_TREE) return workingTreeSource();
  if (from) {
    if (pin && !ignorePin && !satisfies(from, pin)) {
      throw new Error(`${from} is outside the vault's pin "${pin}". Use --ignore-pin to override.`);
    }
    return gitSource(from);
  }
  if (pin) {
    const tag = pickTag(listTags(), pin);
    if (!tag) throw new Error(`No tag satisfies the pin "${pin}".`);
    return gitSource(tag);
  }
  const tag = latestTag();
  if (tag) return gitSource(tag);
  console.error('Warning: no v* tag found, syncing from the working tree.');
  return workingTreeSource();
}
