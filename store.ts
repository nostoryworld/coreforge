// The shared in-memory store: the single source of truth for every surface (git smart HTTP,
// REST v3, GraphQL v4, MCP). One Forge holds every repository; one Repo holds its git objects,
// refs, issues, pull requests, labels and comments. Nothing is persisted — a trial starts with
// an empty forge and the suite creates everything it reads through the surfaces themselves
// (spec 00, §3: "The forge starts EMPTY").
//
// Git objects are stored and served byte-verbatim: commits, trees and tags are never
// re-serialised by the serving path, because the suite compares served bytes against the bytes
// it pushed (spec 01, §3.3). parse/format helpers exist for the surfaces that must look inside
// an object (reachability, the contents API, pull request diffs), never to rewrite one.

import { createHash } from 'node:crypto';

/** The four git object types. */
export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

/** The all-zeros object id: "does not exist" in ref commands and advertisements. */
export const ZERO_OID = '0000000000000000000000000000000000000000';

/** SHA-1 of an object: the id git assigns to "<type> <decimal size>\0" followed by the bytes. */
export function hashObject(type: ObjectType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  /** The raw author line after "author " ("Name <email> ts tz"). */
  author: string;
  /** The raw committer line after "committer ". */
  committer: string;
  /** The commit message (everything after the blank line), verbatim. */
  message: string;
}

/** Parse a commit object's bytes. Throws on a malformed header. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  if (!tree) throw new Error('commit object has no tree header');
  return { tree, parents, author, committer, message };
}

/** Serialise a commit. Surfaces that create commits (merges) build the exact bytes here. */
export function formatCommit(info: CommitInfo): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`, `committer ${info.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

export interface TreeEntry {
  /** "100644" for a file, "40000" for a directory, "160000" for a gitlink. */
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's bytes: repeated "<mode> <name>\0<20-byte oid>". */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space === -1) throw new Error('malformed tree entry: no mode terminator');
    const mode = data.toString('ascii', pos, space);
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > data.length) throw new Error('malformed tree entry: no oid');
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

/** Serialise tree entries in the order given (callers keep git's tree order). */
export function formatTree(entries: readonly TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object's bytes. */
export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const info: TagInfo = { object: '', type: '', tag: '', tagger: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) info.object = line.slice(7).trim();
    else if (line.startsWith('type ')) info.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) info.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) info.tagger = line.slice(7);
  }
  if (!info.object) throw new Error('tag object has no object header');
  return info;
}

/**
 * The object ids one step out from `oid`: a commit reaches its tree and its parents, a tree
 * reaches every entry except gitlinks, a tag reaches its target, a blob reaches nothing.
 * Unknown ids reach nothing (a partial store must not throw mid-walk).
 */
export function objectNeighbours(repo: Repo, oid: string): string[] {
  const object = repo.objects.get(oid);
  if (!object) return [];
  switch (object.type) {
    case 'commit': {
      const commit = parseCommit(object.data);
      return [commit.tree, ...commit.parents];
    }
    case 'tree':
      return parseTree(object.data)
        .filter((entry) => entry.mode !== '160000')
        .map((entry) => entry.oid);
    case 'tag':
      return [parseTag(object.data).object];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Users. The scenario's twelve users and its org are data (spec 00, §3.2): the surfaces serve
// them by login and id. The token names user 0, the viewer.
// ---------------------------------------------------------------------------

export interface User {
  id: number;
  login: string;
  name: string;
  email: string;
  type: 'User' | 'Organization';
}

export const SCENARIO_USERS: readonly User[] = [
  { id: 1000, login: 'adaiversen', name: 'Ada Iversen', email: 'adaiversen@example.invalid', type: 'User' },
  { id: 1001, login: 'quinnkeller', name: 'Quinn Keller', email: 'quinnkeller@example.invalid', type: 'User' },
  { id: 1002, login: 'olgabauer', name: 'Olga Bauer', email: 'olgabauer@example.invalid', type: 'User' },
  { id: 1003, login: 'dmitriquist', name: 'Dmitri Quist', email: 'dmitriquist@example.invalid', type: 'User' },
  { id: 1004, login: 'adanovak', name: 'Ada Novak', email: 'adanovak@example.invalid', type: 'User' },
  { id: 1005, login: 'zanerossi', name: 'Zane Rossi', email: 'zanerossi@example.invalid', type: 'User' },
  { id: 1006, login: 'pavelcosta', name: 'Pavel Costa', email: 'pavelcosta@example.invalid', type: 'User' },
  { id: 1007, login: 'wrenkeller', name: 'Wren Keller', email: 'wrenkeller@example.invalid', type: 'User' },
  { id: 1008, login: 'coraquist', name: 'Cora Quist', email: 'coraquist@example.invalid', type: 'User' },
  { id: 1009, login: 'elenaulrich', name: 'Elena Ulrich', email: 'elenaulrich@example.invalid', type: 'User' },
  { id: 1010, login: 'tesssato', name: 'Tess Sato', email: 'tesssato@example.invalid', type: 'User' },
  { id: 1011, login: 'svenrossi', name: 'Sven Rossi', email: 'svenrossi@example.invalid', type: 'User' },
];

export const SCENARIO_ORG: User = {
  id: 2000,
  login: 'faint-meadow-org',
  name: 'faint-meadow-org',
  email: 'faint-meadow-org@example.invalid',
  type: 'Organization',
};

/** The scenario viewer: the login the shop token names (spec 00, §3.1). */
export const VIEWER: User = SCENARIO_USERS[0];

// ---------------------------------------------------------------------------
// Repository model. Issues and pull requests share one per-repo number sequence, as on GitHub;
// every issue, pull, comment and label also carries a forge-wide numeric id.
// ---------------------------------------------------------------------------

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface IssueComment {
  id: number;
  body: string;
  user: User;
  created_at: string;
  updated_at: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  user: User;
  labels: Label[];
  assignees: User[];
  comments: IssueComment[];
  /** Set when this issue is the issue-face of a pull request (GitHub serves PRs as issues too). */
  pull_number: number | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface PullRef {
  ref: string;
  sha: string | null;
  label: string;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  user: User;
  head: PullRef;
  base: PullRef;
  labels: Label[];
  assignees: User[];
  comments: IssueComment[];
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

/** The current instant as an ISO-8601 string, the timestamp format every surface serves. */
export function nowIso(): string {
  return new Date().toISOString();
}

export class Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  private: boolean;
  description: string | null;
  defaultBranch: string;
  /** The ref HEAD points at. Starts unborn at refs/heads/main and never moves in this contest. */
  headRef: string;
  readonly objects: Map<string, GitObject>;
  readonly refs: Map<string, string>;
  readonly issues: Issue[];
  readonly pulls: PullRequest[];
  readonly labels: Label[];
  /** Next per-repo issue/pull number (one shared sequence, as on GitHub). */
  nextNumber: number;
  readonly created_at: string;
  updated_at: string;

  constructor(id: number, owner: string, name: string, opts: { private?: boolean; description?: string | null } = {}) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.private = opts.private ?? false;
    this.description = opts.description ?? null;
    this.defaultBranch = 'main';
    this.headRef = 'refs/heads/main';
    this.objects = new Map();
    this.refs = new Map();
    this.issues = [];
    this.pulls = [];
    this.labels = [];
    this.nextNumber = 1;
    this.created_at = nowIso();
    this.updated_at = this.created_at;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  touch(): void {
    this.updated_at = nowIso();
  }

  // -- objects ---------------------------------------------------------------

  hasObject(oid: string): boolean {
    return this.objects.has(oid);
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  /** Store bytes under their computed id and return the id. Idempotent. */
  putObject(type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  /** Store an object whose id is already known (from a received pack). Idempotent. */
  storeObject(oid: string, object: GitObject): void {
    if (!this.objects.has(oid)) this.objects.set(oid, object);
  }

  // -- refs ------------------------------------------------------------------

  getRef(ref: string): string | undefined {
    return this.refs.get(ref);
  }

  setRef(ref: string, oid: string): void {
    this.refs.set(ref, oid);
    this.touch();
  }

  deleteRef(ref: string): void {
    this.refs.delete(ref);
    this.touch();
  }

  /** The commit oid HEAD resolves to, or undefined while the default branch is unborn. */
  headOid(): string | undefined {
    return this.refs.get(this.headRef);
  }

  // -- reachability ------------------------------------------------------------

  /**
   * The full reachable closure of `tips`: commits reach tree + parents, trees reach entries,
   * tags reach their target (objectNeighbours). Ids not in the store are included in the result
   * (a caller diffing two closures wants the ids) but reach nothing further.
   */
  reachable(tips: Iterable<string>): Set<string> {
    const seen = new Set<string>();
    const stack = [...tips];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      for (const next of objectNeighbours(this, oid)) {
        if (!seen.has(next)) stack.push(next);
      }
    }
    return seen;
  }

  /**
   * The closure of `tips` cut at `depth` commit generations (depth 1 = the wanted commits
   * only), for shallow fetches (spec 01, §5.4). A commit inside the depth budget contributes
   * its full tree closure; commits beyond it are excluded entirely. Tags pointing at a commit
   * hand that commit the tag's own generation.
   */
  reachableShallow(tips: Iterable<string>, depth: number): Set<string> {
    const included = new Set<string>();
    // Pass 1: pick the commits within the generation budget.
    const commits = new Set<string>();
    let frontier: string[] = [];
    for (const tip of tips) {
      const object = this.objects.get(tip);
      if (!object) continue;
      if (object.type === 'commit') frontier.push(tip);
      else if (object.type === 'tag') {
        included.add(tip);
        const target = parseTag(object.data).object;
        if (this.objects.get(target)?.type === 'commit') frontier.push(target);
      } else {
        included.add(tip);
      }
    }
    for (let generation = 1; generation <= depth && frontier.length > 0; generation += 1) {
      const next: string[] = [];
      for (const oid of frontier) {
        if (commits.has(oid)) continue;
        commits.add(oid);
        const commit = parseCommit((this.objects.get(oid) as GitObject).data);
        for (const parent of commit.parents) {
          if (!commits.has(parent)) next.push(parent);
        }
      }
      frontier = next;
    }
    // Pass 2: the full closure of the chosen commits, never crossing into another commit
    // except the chosen ones themselves.
    const stack: string[] = [];
    for (const oid of commits) {
      included.add(oid);
      const commit = parseCommit((this.objects.get(oid) as GitObject).data);
      stack.push(commit.tree);
    }
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (included.has(oid)) continue;
      const object = this.objects.get(oid);
      if (!object) continue;
      if (object.type === 'commit') continue; // parents outside the budget stay out
      included.add(oid);
      for (const next of objectNeighbours(this, oid)) {
        if (!included.has(next)) stack.push(next);
      }
    }
    return included;
  }

  /** True when `ancestor` is `tip` itself or reachable from `tip` through parent links only. */
  isAncestor(ancestor: string, tip: string): boolean {
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (object?.type === 'commit') {
        for (const parent of parseCommit(object.data).parents) stack.push(parent);
      } else if (object?.type === 'tag') {
        stack.push(parseTag(object.data).object);
      }
    }
    return false;
  }

  /** The parent list of a commit, or [] for a non-commit / unknown id. */
  commitParents(oid: string): string[] {
    const object = this.objects.get(oid);
    if (object?.type !== 'commit') return [];
    return parseCommit(object.data).parents;
  }

  // -- issues, pulls, labels ---------------------------------------------------

  findIssue(number: number): Issue | undefined {
    return this.issues.find((issue) => issue.number === number);
  }

  findPull(number: number): PullRequest | undefined {
    return this.pulls.find((pull) => pull.number === number);
  }

  findLabel(name: string): Label | undefined {
    return this.labels.find((label) => label.name === name);
  }
}

// ---------------------------------------------------------------------------
// The Forge: every repo, keyed "owner/name", plus the id counters and the token -> viewer
// mapping. Surfaces ask the Forge for a repo and get undefined for a missing one; whether an
// existing-but-foreign repo also reads as missing (it must: spec 00, §5.2 — another owner's
// repo is 404, never 403) is each surface's call via visibleRepo().
// ---------------------------------------------------------------------------

export class Forge {
  readonly repos: Map<string, Repo>;
  readonly users: readonly User[];
  private nextRepoId: number;
  private nextGlobalId: number;

  constructor() {
    this.repos = new Map();
    this.users = [...SCENARIO_USERS, SCENARIO_ORG];
    this.nextRepoId = 1;
    this.nextGlobalId = 1;
  }

  /** A forge-wide unique numeric id for an issue, pull, comment or label. */
  allocId(): number {
    const id = this.nextGlobalId;
    this.nextGlobalId += 1;
    return id;
  }

  userByLogin(login: string): User | undefined {
    return this.users.find((user) => user.login === login);
  }

  userById(id: number): User | undefined {
    return this.users.find((user) => user.id === id);
  }

  /** Create a repo. Returns the repo, or undefined when the name is already taken. */
  createRepo(
    owner: string,
    name: string,
    opts: { private?: boolean; description?: string | null; id?: number } = {},
  ): Repo | undefined {
    const key = `${owner}/${name}`;
    if (this.repos.has(key)) return undefined;
    const repo = new Repo(opts.id ?? this.nextRepoId, owner, name, opts);
    if (opts.id === undefined) this.nextRepoId += 1;
    else this.nextRepoId = Math.max(this.nextRepoId, opts.id + 1);
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }

  /** Every repo owned by `owner`, in creation order. */
  reposOf(owner: string): Repo[] {
    return [...this.repos.values()].filter((repo) => repo.owner === owner);
  }

  /**
   * The repo as `viewer` may see it: their own repos only. A repo owned by anyone else reads
   * as not found — the surfaces turn undefined into their 404 shape (spec 00, §5.2).
   */
  visibleRepo(viewer: User, owner: string, name: string): Repo | undefined {
    if (owner !== viewer.login) return undefined;
    return this.getRepo(owner, name);
  }

  /**
   * The viewer a Bearer token names, or null when the request carries no usable token
   * (spec 00, §3.1/§5.2: a request without the token is 401). The harness provisions the token
   * in MAKEFUN_SHOP_TOKEN; the token names the scenario viewer. When the environment carries
   * no token (a local smoke run), any non-empty token names the viewer.
   */
  viewerForToken(token: string): User | null {
    if (!token) return null;
    const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
    if (expected !== '' && token !== expected) return null;
    return VIEWER;
  }

  // -- record creation (shared number/id allocation lives here so every surface agrees) ------

  addIssue(repo: Repo, fields: { title: string; body?: string | null; user: User; labels?: Label[]; assignees?: User[] }): Issue {
    const stamp = nowIso();
    const issue: Issue = {
      id: this.allocId(),
      number: repo.nextNumber,
      title: fields.title,
      body: fields.body ?? null,
      state: 'open',
      user: fields.user,
      labels: fields.labels ?? [],
      assignees: fields.assignees ?? [],
      comments: [],
      pull_number: null,
      created_at: stamp,
      updated_at: stamp,
      closed_at: null,
    };
    repo.nextNumber += 1;
    repo.issues.push(issue);
    repo.touch();
    return issue;
  }

  addPull(
    repo: Repo,
    fields: {
      title: string;
      body?: string | null;
      user: User;
      head: PullRef;
      base: PullRef;
      labels?: Label[];
      assignees?: User[];
    },
  ): PullRequest {
    const stamp = nowIso();
    const pull: PullRequest = {
      id: this.allocId(),
      number: repo.nextNumber,
      title: fields.title,
      body: fields.body ?? null,
      state: 'open',
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      user: fields.user,
      head: fields.head,
      base: fields.base,
      labels: fields.labels ?? [],
      assignees: fields.assignees ?? [],
      comments: [],
      created_at: stamp,
      updated_at: stamp,
      closed_at: null,
    };
    repo.nextNumber += 1;
    repo.pulls.push(pull);
    repo.touch();
    return pull;
  }

  addComment(target: Issue | PullRequest, fields: { body: string; user: User }): IssueComment {
    const stamp = nowIso();
    const comment: IssueComment = {
      id: this.allocId(),
      body: fields.body,
      user: fields.user,
      created_at: stamp,
      updated_at: stamp,
    };
    target.comments.push(comment);
    target.updated_at = stamp;
    return comment;
  }

  addLabel(repo: Repo, fields: { name: string; color?: string; description?: string | null }): Label {
    const label: Label = {
      id: this.allocId(),
      name: fields.name,
      color: fields.color ?? 'ededed',
      description: fields.description ?? null,
    };
    repo.labels.push(label);
    return label;
  }
}
