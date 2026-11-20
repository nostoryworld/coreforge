// REST v3 surface (spec 02-rest-api.md): repositories, branches, commits, git refs, the
// contents API, labels, issues, comments and pull requests (including squash/merge with a
// genuine three-way tree merge), all over the one shared store (store.ts) — the same objects
// the git, GraphQL and MCP surfaces serve, with genuine git SHA-1 ids throughout (spec 02, §5).
//
// Discipline inherited from app.ts: every JSON reply carries X-GitHub-Request-Id, errors are
// thrown as HttpError and land as {"message": ...} with the surface's status. Auth follows
// spec 00, §5.2 / spec 02, §7: no token -> 401 (requireViewer), a repo addressed under any
// login but the viewer's -> 404, never 403 (Forge.visibleRepo).
//
// Performance (spec 00, §2.2): the read bench issues 2,000 sequential GETs of one issue and
// the write bench 200 issue POSTs on keep-alive connections, so handlers resolve through the
// store's maps and per-repo arrays only — no handler scans the whole forge, and the JSON
// serializers allocate one small object per record served.

import { HttpError, type SurfaceContext, type SurfaceHandler } from './app.ts';
import {
  formatCommit,
  formatTree,
  nowIso,
  parseCommit,
  parseTree,
  type CommitInfo,
  type Issue,
  type IssueComment,
  type Label,
  type PullRequest,
  type Repo,
  type TreeEntry,
  type User,
} from './store.ts';

const API_PREFIX = '/api/v3';
const HEX40 = /^[0-9a-f]{40}$/i;

// ---------------------------------------------------------------------------
// Small request helpers.
// ---------------------------------------------------------------------------

/** Percent-decode one path segment; a malformed escape is served raw rather than thrown. */
function decodeSeg(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The request body as a JSON object (ctx.jsonBody throws the 400 for malformed JSON). */
function bodyObject(ctx: SurfaceContext): Record<string, unknown> {
  const value = ctx.jsonBody();
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function bodyString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === 'string' ? value : undefined;
}

/** per_page (default 30, clamped 1..100 — spec 02, §4) and page (default 1). */
function pageParams(ctx: SurfaceContext): { perPage: number; page: number } {
  const perPageRaw = Number.parseInt(ctx.query.get('per_page') ?? '', 10);
  const pageRaw = Number.parseInt(ctx.query.get('page') ?? '', 10);
  return {
    perPage: Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30,
    page: Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1,
  };
}

function paginate<T>(items: readonly T[], perPage: number, page: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

/** A path segment as a positive issue/pull number, or NaN (the handlers answer 404). */
function segmentNumber(segment: string): number {
  return /^\d+$/.test(segment) ? Number.parseInt(segment, 10) : Number.NaN;
}

// ---------------------------------------------------------------------------
// JSON serializers. Only the fields spec 02 reads are load-bearing; the rest is GitHub
// flavour. Shapes agree with the MCP surface's serializers (same store, same objects).
// ---------------------------------------------------------------------------

function userJson(user: User): Record<string, unknown> {
  return { login: user.login, id: user.id, type: user.type };
}

function ownerJson(ctx: SurfaceContext, repo: Repo): Record<string, unknown> {
  const owner = ctx.forge.userByLogin(repo.owner);
  return owner ? userJson(owner) : { login: repo.owner, id: 0, type: 'User' };
}

function repoJson(ctx: SurfaceContext, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: ownerJson(ctx, repo),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return {
    id: label.id,
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

function commentJson(comment: IssueComment): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: userJson(comment.user),
    created_at: comment.created_at,
    updated_at: comment.updated_at,
  };
}

function issueJson(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state,
    user: userJson(issue.user),
    labels: issue.labels.map(labelJson),
    assignees: issue.assignees.map(userJson),
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
  };
}

function pullJson(pull: PullRequest): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body ?? '',
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    user: userJson(pull.user),
    head: { ref: pull.head.ref, sha: pull.head.sha, label: pull.head.label },
    base: { ref: pull.base.ref, sha: pull.base.sha, label: pull.base.label },
    labels: pull.labels.map(labelJson),
    assignees: pull.assignees.map(userJson),
    comments: pull.comments.length,
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: pull.closed_at,
  };
}

function branchJson(repo: Repo, name: string): Record<string, unknown> {
  return {
    name,
    commit: { sha: repo.getRef(`refs/heads/${name}`) ?? null },
    protected: false,
  };
}

function refJson(repo: Repo, ref: string): Record<string, unknown> {
  const oid = repo.getRef(ref) as string;
  return {
    ref,
    object: { type: repo.getObject(oid)?.type ?? 'commit', sha: oid },
  };
}

/** "Name <email> 1700000000 +0000" as the {name, email, date} object the API serves. */
function identJson(raw: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <([^>]*)> (\d+) [+-]\d{4}$/.exec(raw.trim());
  if (!match) return { name: raw.trim(), email: '', date: '1970-01-01T00:00:00.000Z' };
  return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString() };
}

function commitJson(sha: string, info: CommitInfo): Record<string, unknown> {
  return {
    sha,
    commit: {
      author: identJson(info.author),
      committer: identJson(info.committer),
      message: info.message,
      tree: { sha: info.tree },
      comment_count: 0,
    },
    author: null,
    committer: null,
    parents: info.parents.map((parent) => ({ sha: parent })),
  };
}

// ---------------------------------------------------------------------------
// Git plumbing over the store. Trees are handled flattened (path -> {oid, mode}) and rebuilt
// whole on a write: contest trees are small, and a rebuild keeps the canonical git entry
// order (names compared bytewise, directories as name + "/") so every id is a genuine git
// SHA-1 of the exact bytes served (spec 02, §5.1).
// ---------------------------------------------------------------------------

interface FlatFile {
  oid: string;
  mode: string;
}

function isDirMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

/** Every file under a commit's tree, keyed by repo-relative path. */
function treeFiles(repo: Repo, commitOid: string): Map<string, FlatFile> {
  const out = new Map<string, FlatFile>();
  const commit = repo.getObject(commitOid);
  if (commit?.type !== 'commit') return out;
  const walk = (treeOid: string, prefix: string): void => {
    const tree = repo.getObject(treeOid);
    if (tree?.type !== 'tree') return;
    for (const entry of parseTree(tree.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (isDirMode(entry.mode)) walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(parseCommit(commit.data).tree, '');
  return out;
}

/** Git's tree entry order: bytewise by name, a directory comparing as its name plus "/". */
function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const keyA = isDirMode(a.mode) ? `${a.name}/` : a.name;
  const keyB = isDirMode(b.mode) ? `${b.name}/` : b.name;
  return Buffer.compare(Buffer.from(keyA, 'utf8'), Buffer.from(keyB, 'utf8'));
}

/** Rebuild (and store) the nested tree for a flattened file map; returns the root tree id. */
function buildTree(repo: Repo, files: Map<string, FlatFile>): string {
  interface Node {
    files: Map<string, FlatFile>;
    dirs: Map<string, Node>;
  }
  const newNode = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = newNode();
  for (const [path, file] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let next = node.dirs.get(parts[i]);
      if (!next) {
        next = newNode();
        node.dirs.set(parts[i], next);
      }
      node = next;
    }
    node.files.set(parts[parts.length - 1], file);
  }
  const writeNode = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
    for (const [name, dir] of node.dirs) entries.push({ mode: '40000', name, oid: writeNode(dir) });
    entries.sort(compareTreeEntries);
    return repo.putObject('tree', formatTree(entries));
  };
  return writeNode(root);
}

type PathLookup =
  | { kind: 'file'; oid: string; mode: string }
  | { kind: 'dir'; treeOid: string }
  | undefined;

/** Resolve a repo-relative path inside a tree: a file, a directory, or nothing. */
function lookupPath(repo: Repo, treeOid: string, path: string): PathLookup {
  if (path === '') return { kind: 'dir', treeOid };
  const parts = path.split('/');
  let current = treeOid;
  for (let i = 0; i < parts.length; i += 1) {
    const tree = repo.getObject(current);
    if (tree?.type !== 'tree') return undefined;
    const entry = parseTree(tree.data).find((candidate) => candidate.name === parts[i]);
    if (!entry) return undefined;
    if (i === parts.length - 1) {
      return isDirMode(entry.mode)
        ? { kind: 'dir', treeOid: entry.oid }
        : { kind: 'file', oid: entry.oid, mode: entry.mode };
    }
    if (!isDirMode(entry.mode)) return undefined;
    current = entry.oid;
  }
  return undefined;
}

/** The author/committer line for a commit the forge itself creates. */
function ident(user: User): string {
  const seconds = Math.floor(Date.now() / 1000);
  return `${user.name} <${user.email}> ${seconds} +0000`;
}

function makeCommit(repo: Repo, treeOid: string, parents: string[], message: string, user: User): string {
  const stamp = ident(user);
  return repo.putObject('commit', formatCommit({ tree: treeOid, parents, author: stamp, committer: stamp, message }));
}

/**
 * One contents-API change on a branch: set `path` to `content` (or delete it when content is
 * null) in a new commit on top of the branch tip, then move the ref. On a repo with no refs
 * at all, a change addressed at the default branch creates the root commit — the contents
 * API's first commit on an unborn repo (spec 02, §1/§2.4). Returns the new commit id and,
 * for a write, the blob id.
 */
function commitContentChange(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
  user: User,
): { commitSha: string; blobSha: string | null } {
  const ref = `refs/heads/${branch}`;
  const tip = repo.getRef(ref);
  let parents: string[] = [];
  let files = new Map<string, FlatFile>();
  if (tip !== undefined) {
    parents = [tip];
    files = treeFiles(repo, tip);
  } else if (!(branch === repo.defaultBranch && repo.refs.size === 0)) {
    throw new HttpError(404, 'Branch not found');
  }
  let blobSha: string | null = null;
  if (content !== null) {
    blobSha = repo.putObject('blob', content);
    files.set(path, { oid: blobSha, mode: files.get(path)?.mode ?? '100644' });
  } else {
    files.delete(path);
  }
  const commitSha = makeCommit(repo, buildTree(repo, files), parents, message, user);
  repo.setRef(ref, commitSha);
  return { commitSha, blobSha };
}

/** A branch name (or a raw commit id) resolved to a commit id, for contents/commits reads. */
function resolveCommitish(repo: Repo, ref: string): string | undefined {
  const tip = repo.getRef(`refs/heads/${ref}`);
  if (tip !== undefined) return tip;
  if (HEX40.test(ref) && repo.getObject(ref)?.type === 'commit') return ref;
  return undefined;
}

/** Commits reachable from `tip`, newest first (first-parent chain first), capped. */
function listCommitsFrom(repo: Repo, tip: string, cap = 1000): { sha: string; info: CommitInfo }[] {
  const out: { sha: string; info: CommitInfo }[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0 && out.length < cap) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.getObject(oid);
    if (object?.type !== 'commit') continue;
    const info = parseCommit(object.data);
    out.push({ sha: oid, info });
    for (let i = info.parents.length - 1; i >= 0; i -= 1) stack.push(info.parents[i]);
  }
  return out;
}

/** Every ancestor of `tip` (inclusive) through parent links. */
function ancestorSet(repo: Repo, tip: string): Set<string> {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.getObject(oid);
    if (object?.type === 'commit') stack.push(...parseCommit(object.data).parents);
  }
  return seen;
}

/** The nearest common ancestor of two commits (breadth-first from `b`), or undefined. */
function mergeBase(repo: Repo, a: string, b: string): string | undefined {
  const ancestors = ancestorSet(repo, a);
  const seen = new Set<string>([b]);
  let frontier = [b];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (ancestors.has(oid)) return oid;
      const object = repo.getObject(oid);
      if (object?.type === 'commit') {
        for (const parent of parseCommit(object.data).parents) {
          if (!seen.has(parent)) {
            seen.add(parent);
            next.push(parent);
          }
        }
      }
    }
    frontier = next;
  }
  return undefined;
}

/**
 * A genuine three-way tree merge (spec 02, §5.3): per path, the side that moved away from
 * the merge base wins; both sides moving the same path to different results (or one side
 * deleting what the other changed) is a conflict and answers null.
 */
function mergeTrees(
  repo: Repo,
  baseCommit: string,
  oursCommit: string,
  theirsCommit: string,
): Map<string, FlatFile> | null {
  const base = treeFiles(repo, baseCommit);
  const ours = treeFiles(repo, oursCommit);
  const theirs = treeFiles(repo, theirsCommit);
  const merged = new Map<string, FlatFile>();
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const baseOid = base.get(path)?.oid;
    const oursFile = ours.get(path);
    const theirsFile = theirs.get(path);
    if (theirsFile?.oid === baseOid) {
      if (oursFile) merged.set(path, oursFile);
    } else if (oursFile?.oid === baseOid) {
      if (theirsFile) merged.set(path, theirsFile);
    } else if (oursFile?.oid === theirsFile?.oid) {
      if (oursFile) merged.set(path, oursFile);
    } else {
      return null;
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Line counting and diffing for the pull-request files list (spec 02, §2.7): additions on
// an added file must be a real count >= 1, so counts come from the blobs themselves — a
// longest-common-subsequence diff for modified files (contest blobs are a few KiB).
// ---------------------------------------------------------------------------

function splitLines(data: Buffer): string[] {
  if (data.length === 0) return [];
  const lines = data.toString('utf8').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function diffCounts(oldData: Buffer, newData: Buffer): { additions: number; deletions: number } {
  const oldLines = splitLines(oldData);
  const newLines = splitLines(newData);
  if (oldLines.length === 0) return { additions: newLines.length, deletions: 0 };
  if (newLines.length === 0) return { additions: 0, deletions: oldLines.length };
  let prev = new Array<number>(newLines.length + 1).fill(0);
  let curr = new Array<number>(newLines.length + 1).fill(0);
  for (let i = 1; i <= oldLines.length; i += 1) {
    for (let j = 1; j <= newLines.length; j += 1) {
      curr[j] = oldLines[i - 1] === newLines[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    [prev, curr] = [curr, prev];
  }
  const lcs = prev[newLines.length];
  return { additions: newLines.length - lcs, deletions: oldLines.length - lcs };
}

/** The head-vs-base file diff a pull request reports (spec 02, §2.7). */
function pullFiles(repo: Repo, pull: PullRequest): Record<string, unknown>[] {
  const baseFiles = pull.base.sha ? treeFiles(repo, pull.base.sha) : new Map<string, FlatFile>();
  const headFiles = pull.head.sha ? treeFiles(repo, pull.head.sha) : new Map<string, FlatFile>();
  const out: Record<string, unknown>[] = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const baseFile = baseFiles.get(path);
    const headFile = headFiles.get(path);
    if (baseFile && headFile && baseFile.oid === headFile.oid) continue;
    const baseData = baseFile ? (repo.getObject(baseFile.oid)?.data ?? Buffer.alloc(0)) : Buffer.alloc(0);
    const headData = headFile ? (repo.getObject(headFile.oid)?.data ?? Buffer.alloc(0)) : Buffer.alloc(0);
    let status: string;
    let counts: { additions: number; deletions: number };
    if (!baseFile) {
      status = 'added';
      counts = { additions: splitLines(headData).length, deletions: 0 };
    } else if (!headFile) {
      status = 'removed';
      counts = { additions: 0, deletions: splitLines(baseData).length };
    } else {
      status = 'modified';
      counts = diffCounts(baseData, headData);
    }
    out.push({
      filename: path,
      status,
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
    });
  }
  out.sort((a, b) => String(a.filename).localeCompare(String(b.filename)));
  return out;
}

// ---------------------------------------------------------------------------
// Shared handler plumbing.
// ---------------------------------------------------------------------------

/** The repo a /repos/{owner}/{repo} route addresses, as the viewer may see it. */
function requireRepo(ctx: SurfaceContext, owner: string, name: string): { viewer: User; repo: Repo } {
  const viewer = ctx.requireViewer();
  const repo = ctx.forge.visibleRepo(viewer, owner, name);
  if (!repo) throw new HttpError(404, 'Not Found');
  return { viewer, repo };
}

let noContentCounter = 0;

/** A bare 204 (repo delete): no body may ride on a 204, but the request id still must. */
function sendNoContent(ctx: SurfaceContext): void {
  noContentCounter += 1;
  ctx.res.writeHead(204, { 'x-github-request-id': `rest-${noContentCounter}-${Date.now().toString(36)}` });
  ctx.res.end();
}

/**
 * The JSON body of a DELETE request. app.ts reads bodies only for POST/PUT/PATCH, so a
 * contents DELETE's {message, sha} is still on the socket: read it here, briefly. When the
 * shell has already buffered it (ctx.body) that wins, and a body that never arrives simply
 * means the delete proceeds without the optional fields.
 */
async function deleteBody(ctx: SurfaceContext): Promise<Record<string, unknown>> {
  if (ctx.body.length > 0) {
    try {
      const value = JSON.parse(ctx.body.toString('utf8')) as unknown;
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      /* fall through to the stream read */
    }
  }
  const raw = await new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => resolve(Buffer.concat(chunks)), 300);
    ctx.req.on('data', (chunk: Buffer) => chunks.push(chunk));
    ctx.req.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    ctx.req.on('error', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
  });
  try {
    const value = JSON.parse(raw.toString('utf8')) as unknown;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    /* no usable body */
  }
  return {};
}

// ---------------------------------------------------------------------------
// Root, meta, the viewer, and the viewer's repositories.
// ---------------------------------------------------------------------------

function root(ctx: SurfaceContext): void {
  ctx.sendJson(
    200,
    {
      current_user_url: `${API_PREFIX}/user`,
      current_user_repositories_url: `${API_PREFIX}/user/repos`,
      repository_url: `${API_PREFIX}/repos/{owner}/{repo}`,
      issue_url: `${API_PREFIX}/repos/{owner}/{repo}/issues/{number}`,
      rate_limit_url: `${API_PREFIX}/rate_limit`,
    },
    { 'x-oauth-scopes': 'repo, read:org' },
  );
}

function meta(ctx: SurfaceContext): void {
  ctx.sendJson(200, {
    verifiable_password_authentication: false,
    installed_version: '1.0.0',
  });
}

function listUserRepos(ctx: SurfaceContext): void {
  const viewer = ctx.requireViewer();
  const { perPage, page } = pageParams(ctx);
  const repos = ctx.forge.reposOf(viewer.login);
  const headers: Record<string, string> = {};
  const totalPages = Math.max(1, Math.ceil(repos.length / perPage));
  if (page < totalPages) {
    // The client follows rel="next" verbatim and requires an absolute same-origin URL
    // (spec 02, §4.1): the origin is the one this very request arrived on.
    const origin = `http://${ctx.req.headers.host ?? 'localhost'}`;
    const base = `${origin}${API_PREFIX}/user/repos?per_page=${perPage}`;
    headers.link = `<${base}&page=${page + 1}>; rel="next", <${base}&page=${totalPages}>; rel="last"`;
  }
  ctx.sendJson(200, paginate(repos, perPage, page).map((repo) => repoJson(ctx, repo)), headers);
}

function createUserRepo(ctx: SurfaceContext): void {
  const viewer = ctx.requireViewer();
  const obj = bodyObject(ctx);
  const name = bodyString(obj, 'name');
  if (!name) throw new HttpError(422, 'Repository creation failed.');
  if (ctx.forge.getRepo(viewer.login, name)) {
    throw new HttpError(422, 'Repository creation failed: a repository with that name already exists.');
  }
  const repo = ctx.forge.createRepo(viewer.login, name, {
    private: obj.private === true,
    description: bodyString(obj, 'description') ?? null,
  });
  if (!repo) throw new HttpError(422, 'Repository creation failed.');
  ctx.sendJson(201, repoJson(ctx, repo));
}

// ---------------------------------------------------------------------------
// Repository CRUD.
// ---------------------------------------------------------------------------

function getRepoHandler(ctx: SurfaceContext, owner: string, name: string): void {
  const { repo } = requireRepo(ctx, owner, name);
  ctx.sendJson(200, repoJson(ctx, repo));
}

function patchRepoHandler(ctx: SurfaceContext, owner: string, name: string): void {
  const { repo } = requireRepo(ctx, owner, name);
  const obj = bodyObject(ctx);
  if ('description' in obj) {
    repo.description = typeof obj.description === 'string' ? obj.description : null;
  }
  if (typeof obj.private === 'boolean') repo.private = obj.private;
  const newName = bodyString(obj, 'name');
  if (newName && newName !== repo.name) {
    // A rename re-keys the forge map; the checks never rename, but the route stays honest.
    ctx.forge.deleteRepo(repo.owner, repo.name);
    (repo as { name: string }).name = newName;
    ctx.forge.repos.set(repo.fullName, repo);
  }
  repo.touch();
  ctx.sendJson(200, repoJson(ctx, repo));
}

function deleteRepoHandler(ctx: SurfaceContext, owner: string, name: string): void {
  const { viewer, repo } = requireRepo(ctx, owner, name);
  ctx.forge.deleteRepo(viewer.login, repo.name);
  sendNoContent(ctx);
}

// ---------------------------------------------------------------------------
// Branches, commits and git refs.
// ---------------------------------------------------------------------------

function listBranches(ctx: SurfaceContext, owner: string, name: string): void {
  const { repo } = requireRepo(ctx, owner, name);
  const names: string[] = [];
  for (const ref of repo.refs.keys()) {
    if (ref.startsWith('refs/heads/')) names.push(ref.slice('refs/heads/'.length));
  }
  names.sort();
  ctx.sendJson(200, names.map((branch) => branchJson(repo, branch)));
}

function getBranch(ctx: SurfaceContext, owner: string, name: string, branch: string): void {
  const { repo } = requireRepo(ctx, owner, name);
  if (repo.getRef(`refs/heads/${branch}`) === undefined) throw new HttpError(404, 'Branch not found');
  ctx.sendJson(200, branchJson(repo, branch));
}

function listCommits(ctx: SurfaceContext, owner: string, name: string): void {
  const { repo } = requireRepo(ctx, owner, name);
  const { perPage, page } = pageParams(ctx);
  const shaParam = ctx.query.get('sha');
  let tip: string | undefined;
  if (shaParam) {
    tip = resolveCommitish(repo, shaParam);
    if (tip === undefined) throw new HttpError(404, 'Commit not found');
  } else {
    tip = repo.headOid();
  }
  if (tip === undefined) {
    ctx.sendJson(200, []);
    return;
  }
  const commits = listCommitsFrom(repo, tip);
  ctx.sendJson(200, paginate(commits, perPage, page).map((entry) => commitJson(entry.sha, entry.info)));
}

function getCommit(ctx: SurfaceContext, owner: string, name: string, sha: string): void {
  const { repo } = requireRepo(ctx, owner, name);
  const object = repo.getObject(sha);
  if (object?.type !== 'commit') throw new HttpError(404, 'Commit not found');
  ctx.sendJson(200, commitJson(sha, parseCommit(object.data)));
}

function createGitRef(ctx: SurfaceContext, owner: string, name: string): void {
  const { repo } = requireRepo(ctx, owner, name);
  const obj = bodyObject(ctx);
  const ref = bodyString(obj, 'ref');
  const sha = bodyString(obj, 'sha');
  if (!ref || !ref.startsWith('refs/')) throw new HttpError(422, 'Invalid ref');
  if (!sha || !repo.getObject(sha)) throw new HttpError(422, 'Object does not exist');
  repo.setRef(ref, sha);
  ctx.sendJson(201, refJson(repo, ref));
}

function getGitRef(ctx: SurfaceContext, owner: string, name: string, refPath: string): void {
  const { repo } = requireRepo(ctx, owner, name);
  const ref = refPath.startsWith('refs/') ? refPath : `refs/${refPath}`;
  if (repo.getRef(ref) === undefined) throw new HttpError(404, 'Reference not found');
  ctx.sendJson(200, refJson(repo, ref));
}

function listGitRefs(ctx: SurfaceContext, owner: string, name: string): void {
  const { repo } = requireRepo(ctx, owner, name);
  const refs = [...repo.refs.keys()].sort().map((ref) => refJson(repo, ref));
  ctx.sendJson(200, refs);
}

// ---------------------------------------------------------------------------
// The contents API.
// ---------------------------------------------------------------------------

function getContents(ctx: SurfaceContext, owner: string, name: string, path: string): void {
  const { repo } = requireRepo(ctx, owner, name);
  const refParam = ctx.query.get('ref') ?? repo.defaultBranch;
  const commitOid = resolveCommitish(repo, refParam);
  if (commitOid === undefined) throw new HttpError(404, 'Not Found');
  const commit = repo.getObject(commitOid);
  if (commit?.type !== 'commit') throw new HttpError(404, 'Not Found');
  const found = lookupPath(repo, parseCommit(commit.data).tree, path);
  if (!found) throw new HttpError(404, 'Not Found');
  if (found.kind === 'file') {
    const blob = repo.getObject(found.oid);
    if (blob?.type !== 'blob') throw new HttpError(404, 'Not Found');
    ctx.sendJson(200, {
      type: 'file',
      encoding: 'base64',
      size: blob.data.length,
      name: path.split('/').pop() ?? path,
      path,
      content: blob.data.toString('base64'),
      sha: found.oid,
    });
    return;
  }
  const tree = repo.getObject(found.treeOid);
  if (tree?.type !== 'tree') throw new HttpError(404, 'Not Found');
  const entries = parseTree(tree.data).map((entry) => {
    const isDir = isDirMode(entry.mode);
    const data = isDir ? undefined : repo.getObject(entry.oid)?.data;
    return {
      type: isDir ? 'dir' : 'file',
      name: entry.name,
      path: path === '' ? entry.name : `${path}/${entry.name}`,
      sha: entry.oid,
      size: data ? data.length : 0,
    };
  });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  ctx.sendJson(200, entries);
}

function putContents(ctx: SurfaceContext, owner: string, name: string, path: string): void {
  const { viewer, repo } = requireRepo(ctx, owner, name);
  if (path === '') throw new HttpError(422, 'Invalid path');
  const obj = bodyObject(ctx);
  const message = bodyString(obj, 'message') ?? '';
  const contentB64 = bodyString(obj, 'content');
  if (contentB64 === undefined) throw new HttpError(422, 'content is required');
  const branch = bodyString(obj, 'branch') ?? repo.defaultBranch;
  const shaGiven = bodyString(obj, 'sha');

  const tip = repo.getRef(`refs/heads/${branch}`);
  let existing: FlatFile | undefined;
  if (tip !== undefined) {
    existing = treeFiles(repo, tip).get(path);
  } else if (!(branch === repo.defaultBranch && repo.refs.size === 0)) {
    throw new HttpError(404, 'Branch not found');
  }
  if (existing) {
    if (shaGiven === undefined) throw new HttpError(422, 'sha is required to update an existing file');
    if (shaGiven.toLowerCase() !== existing.oid.toLowerCase()) {
      throw new HttpError(409, 'The sha supplied does not match the current blob');
    }
  }

  const content = Buffer.from(contentB64, 'base64');
  const { commitSha, blobSha } = commitContentChange(repo, branch, path, content, message, viewer);
  ctx.sendJson(existing ? 200 : 201, {
    content: {
      name: path.split('/').pop() ?? path,
      path,
      sha: blobSha,
      size: content.length,
      type: 'file',
      encoding: 'base64',
    },
    commit: { sha: commitSha, message },
  });
}

async function deleteContents(ctx: SurfaceContext, owner: string, name: string, path: string): Promise<void> {
  const { viewer, repo } = requireRepo(ctx, owner, name);
  const obj = await deleteBody(ctx);
  const message = bodyString(obj, 'message') ?? '';
  const branch = bodyString(obj, 'branch') ?? repo.defaultBranch;
  const shaGiven = bodyString(obj, 'sha');
  const tip = repo.getRef(`refs/heads/${branch}`);
  const existing = tip !== undefined ? treeFiles(repo, tip).get(path) : undefined;
  if (!existing) throw new HttpError(404, 'Not Found');
  if (shaGiven !== undefined && shaGiven.toLowerCase() !== existing.oid.toLowerCase()) {
    throw new HttpError(409, 'The sha supplied does not match the current blob');
  }
  const { commitSha } = commitContentChange(repo, branch, path, null, message, viewer);
  ctx.sendJson(200, { content: null, commit: { sha: commitSha, message } });
}

// ---------------------------------------------------------------------------
// Labels.
// ---------------------------------------------------------------------------

function createLabel(ctx: SurfaceContext, owner: string, name: string): void {
  const { repo } = requireRepo(ctx, owner, name);
  const obj = bodyObject(ctx);
  const labelName = bodyString(obj, 'name');
  if (!labelName) throw new HttpError(422, 'Invalid label');
  if (repo.findLabel(labelName)) throw new HttpError(422, 'Label already exists');
  const label = ctx.forge.addLabel(repo, {
    name: labelName,
    color: bodyString(obj, 'color') ?? 'ededed',
    description: bodyString(obj, 'description') ?? null,
  });
  ctx.sendJson(201, labelJson(label));
}

function listLabels(ctx: SurfaceContext, owner: string, name: string): void {
  const { repo } = requireRepo(ctx, owner, name);
  ctx.sendJson(200, repo.labels.map(labelJson));
}

// ---------------------------------------------------------------------------
// Issues and their comments.
// ---------------------------------------------------------------------------

/** The labels an issue create names, resolved against the repo (unknown -> 422). */
function resolveLabels(repo: Repo, obj: Record<string, unknown>): Label[] {
  const raw = obj.labels;
  if (!Array.isArray(raw)) return [];
  const labels: Label[] = [];
  for (const entry of raw) {
    const labelName =
      typeof entry === 'string'
        ? entry
        : typeof entry === 'object' && entry !== null
          ? bodyString(entry as Record<string, unknown>, 'name')
          : undefined;
    if (!labelName) continue;
    const label = repo.findLabel(labelName);
    if (!label) throw new HttpError(422, `Label "${labelName}" does not exist`);
    labels.push(label);
  }
  return labels;
}

function createIssue(ctx: SurfaceContext, owner: string, name: string): void {
  const { viewer, repo } = requireRepo(ctx, owner, name);
  const obj = bodyObject(ctx);
  const labels = resolveLabels(repo, obj);
  const issue = ctx.forge.addIssue(repo, {
    title: bodyString(obj, 'title') ?? '',
    body: bodyString(obj, 'body') ?? '',
    user: viewer,
    labels,
  });
  ctx.sendJson(201, issueJson(issue));
}

function listIssues(ctx: SurfaceContext, owner: string, name: string): void {
  const { repo } = requireRepo(ctx, owner, name);
  const { perPage, page } = pageParams(ctx);
  const state = ctx.query.get('state') ?? 'open';
  let items = repo.issues.filter((issue) => state === 'all' || issue.state === state);
  // Issues are stored in creation order; sort=created is the only sort ever sent, and
  // direction picks the reading direction (spec 02, §4.2). GitHub's default is desc.
  const direction = ctx.query.get('direction') ?? 'desc';
  if (direction !== 'asc') items = [...items].reverse();
  ctx.sendJson(200, paginate(items, perPage, page).map(issueJson));
}

function requireIssue(repo: Repo, number: number): Issue {
  const issue = Number.isInteger(number) ? repo.findIssue(number) : undefined;
  if (!issue) throw new HttpError(404, 'Issue not found');
  return issue;
}

function getIssue(ctx: SurfaceContext, owner: string, name: string, number: number): void {
  const { repo } = requireRepo(ctx, owner, name);
  ctx.sendJson(200, issueJson(requireIssue(repo, number)));
}

function patchIssue(ctx: SurfaceContext, owner: string, name: string, number: number): void {
  const { repo } = requireRepo(ctx, owner, name);
  const issue = requireIssue(repo, number);
  const obj = bodyObject(ctx);
  const title = bodyString(obj, 'title');
  if (title !== undefined) issue.title = title;
  const body = bodyString(obj, 'body');
  if (body !== undefined) issue.body = body;
  const state = bodyString(obj, 'state');
  if (state === 'closed' || state === 'open') {
    issue.state = state;
    issue.closed_at = state === 'closed' ? nowIso() : null;
  }
  issue.updated_at = nowIso();
  ctx.sendJson(200, issueJson(issue));
}

function createComment(ctx: SurfaceContext, owner: string, name: string, number: number): void {
  const { viewer, repo } = requireRepo(ctx, owner, name);
  const issue = requireIssue(repo, number);
  const obj = bodyObject(ctx);
  const comment = ctx.forge.addComment(issue, { body: bodyString(obj, 'body') ?? '', user: viewer });
  ctx.sendJson(201, commentJson(comment));
}

function listComments(ctx: SurfaceContext, owner: string, name: string, number: number): void {
  const { repo } = requireRepo(ctx, owner, name);
  const issue = requireIssue(repo, number);
  ctx.sendJson(200, issue.comments.map(commentJson));
}

// ---------------------------------------------------------------------------
// Pull requests: create, read, list, files, and the merge (spec 02, §2.7/§5.3).
// ---------------------------------------------------------------------------

function createPull(ctx: SurfaceContext, owner: string, name: string): void {
  const { viewer, repo } = requireRepo(ctx, owner, name);
  const obj = bodyObject(ctx);
  const head = bodyString(obj, 'head');
  const base = bodyString(obj, 'base');
  if (!head || !base) throw new HttpError(422, 'Invalid pull request');
  const headSha = repo.getRef(`refs/heads/${head}`);
  if (!headSha) throw new HttpError(422, `Head branch "${head}" does not exist`);
  const baseSha = repo.getRef(`refs/heads/${base}`);
  if (!baseSha) throw new HttpError(422, `Base branch "${base}" does not exist`);
  const pull = ctx.forge.addPull(repo, {
    title: bodyString(obj, 'title') ?? '',
    body: bodyString(obj, 'body') ?? '',
    user: viewer,
    head: { ref: head, sha: headSha, label: `${repo.owner}:${head}` },
    base: { ref: base, sha: baseSha, label: `${repo.owner}:${base}` },
  });
  ctx.sendJson(201, pullJson(pull));
}

function listPulls(ctx: SurfaceContext, owner: string, name: string): void {
  const { repo } = requireRepo(ctx, owner, name);
  const { perPage, page } = pageParams(ctx);
  // No state parameter means open only — a merged pull must not appear (spec 02, §4.3).
  const state = ctx.query.get('state') ?? 'open';
  const items = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
  ctx.sendJson(200, paginate(items, perPage, page).map(pullJson));
}

function requirePull(repo: Repo, number: number): PullRequest {
  const pull = Number.isInteger(number) ? repo.findPull(number) : undefined;
  if (!pull) throw new HttpError(404, 'Pull request not found');
  return pull;
}

function getPull(ctx: SurfaceContext, owner: string, name: string, number: number): void {
  const { repo } = requireRepo(ctx, owner, name);
  ctx.sendJson(200, pullJson(requirePull(repo, number)));
}

function patchPull(ctx: SurfaceContext, owner: string, name: string, number: number): void {
  const { repo } = requireRepo(ctx, owner, name);
  const pull = requirePull(repo, number);
  const obj = bodyObject(ctx);
  const title = bodyString(obj, 'title');
  if (title !== undefined) pull.title = title;
  const body = bodyString(obj, 'body');
  if (body !== undefined) pull.body = body;
  const state = bodyString(obj, 'state');
  if ((state === 'closed' || state === 'open') && !pull.merged) {
    pull.state = state;
    pull.closed_at = state === 'closed' ? nowIso() : null;
  }
  pull.updated_at = nowIso();
  ctx.sendJson(200, pullJson(pull));
}

function getPullFiles(ctx: SurfaceContext, owner: string, name: string, number: number): void {
  const { repo } = requireRepo(ctx, owner, name);
  const pull = requirePull(repo, number);
  ctx.sendJson(200, pullFiles(repo, pull));
}

/**
 * Merge a pull request into its base branch. "squash" lands one commit whose tree is the
 * three-way merge of the merge base, the current base tip and the current head tip;
 * "merge" lands the same tree as a two-parent merge commit. A genuine conflict (the same
 * path changed on both sides since the merge base, §5.3) answers 405, as do an already
 * merged or otherwise unmergeable pull.
 */
function mergePull(ctx: SurfaceContext, owner: string, name: string, number: number): void {
  const { viewer, repo } = requireRepo(ctx, owner, name);
  const pull = requirePull(repo, number);
  const obj = bodyObject(ctx);
  const method = bodyString(obj, 'merge_method') ?? 'merge';
  if (pull.merged || pull.state !== 'open') {
    throw new HttpError(405, 'Pull Request is not mergeable');
  }
  const baseRef = `refs/heads/${pull.base.ref}`;
  const headRef = `refs/heads/${pull.head.ref}`;
  const baseTip = repo.getRef(baseRef);
  const headTip = repo.getRef(headRef);
  if (!baseTip || !headTip) throw new HttpError(405, 'Pull Request is not mergeable');
  if (baseTip === headTip || repo.isAncestor(headTip, baseTip)) {
    throw new HttpError(405, 'Pull Request is not mergeable');
  }
  const base = mergeBase(repo, baseTip, headTip);
  if (!base) throw new HttpError(405, 'Pull Request is not mergeable');
  const mergedFiles = mergeTrees(repo, base, baseTip, headTip);
  if (!mergedFiles) throw new HttpError(405, 'Merge conflict');
  const parents = method === 'merge' ? [baseTip, headTip] : [baseTip];
  const message = pull.body ? `${pull.title}\n\n${pull.body}` : pull.title;
  const mergeCommitSha = makeCommit(repo, buildTree(repo, mergedFiles), parents, message, viewer);
  repo.setRef(baseRef, mergeCommitSha);
  const stamp = nowIso();
  pull.state = 'closed';
  pull.merged = true;
  pull.merged_at = stamp;
  pull.merge_commit_sha = mergeCommitSha;
  pull.closed_at = stamp;
  pull.updated_at = stamp;
  ctx.sendJson(200, { sha: mergeCommitSha, merged: true, message: 'Pull Request successfully merged' });
}

// ---------------------------------------------------------------------------
// The dispatcher: /api/v3 paths to the handlers above. Anything unmatched is the JSON 404
// of spec 02, §6 (protocol.unknown-route-json-404).
// ---------------------------------------------------------------------------

export const handleRest: SurfaceHandler = async (ctx) => {
  const rest = ctx.path.slice(API_PREFIX.length);
  const segs = rest
    .split('/')
    .filter((segment) => segment !== '')
    .map(decodeSeg);
  const method = ctx.method;

  if (segs.length === 0) {
    if (method === 'GET') return root(ctx);
    throw new HttpError(404, 'Not Found');
  }
  if (segs[0] === 'meta' && segs.length === 1 && method === 'GET') return meta(ctx);

  if (segs[0] === 'user') {
    if (segs.length === 1 && method === 'GET') {
      const viewer = ctx.requireViewer();
      return ctx.sendJson(200, userJson(viewer));
    }
    if (segs.length === 2 && segs[1] === 'repos') {
      if (method === 'GET') return listUserRepos(ctx);
      if (method === 'POST') return createUserRepo(ctx);
    }
    throw new HttpError(404, 'Not Found');
  }

  if (segs[0] === 'repos' && segs.length >= 3) {
    const owner = segs[1];
    const name = segs[2];
    if (segs.length === 3) {
      if (method === 'GET') return getRepoHandler(ctx, owner, name);
      if (method === 'PATCH') return patchRepoHandler(ctx, owner, name);
      if (method === 'DELETE') return deleteRepoHandler(ctx, owner, name);
      throw new HttpError(404, 'Not Found');
    }
    const sub = segs[3];
    if (sub === 'branches') {
      if (segs.length === 4 && method === 'GET') return listBranches(ctx, owner, name);
      if (segs.length >= 5 && method === 'GET') return getBranch(ctx, owner, name, segs.slice(4).join('/'));
    } else if (sub === 'commits') {
      if (segs.length === 4 && method === 'GET') return listCommits(ctx, owner, name);
      if (segs.length === 5 && method === 'GET') return getCommit(ctx, owner, name, segs[4]);
    } else if (sub === 'git' && segs[4] === 'refs') {
      if (segs.length === 5 && method === 'POST') return createGitRef(ctx, owner, name);
      if (segs.length === 5 && method === 'GET') return listGitRefs(ctx, owner, name);
      if (segs.length >= 6 && method === 'GET') return getGitRef(ctx, owner, name, segs.slice(5).join('/'));
    } else if (sub === 'contents') {
      const path = segs.slice(4).join('/');
      if (method === 'GET') return getContents(ctx, owner, name, path);
      if (method === 'PUT') return putContents(ctx, owner, name, path);
      if (method === 'DELETE') return deleteContents(ctx, owner, name, path);
    } else if (sub === 'labels') {
      if (segs.length === 4 && method === 'POST') return createLabel(ctx, owner, name);
      if (segs.length === 4 && method === 'GET') return listLabels(ctx, owner, name);
    } else if (sub === 'issues') {
      if (segs.length === 4 && method === 'GET') return listIssues(ctx, owner, name);
      if (segs.length === 4 && method === 'POST') return createIssue(ctx, owner, name);
      if (segs.length === 5 && method === 'GET') return getIssue(ctx, owner, name, segmentNumber(segs[4]));
      if (segs.length === 5 && method === 'PATCH') return patchIssue(ctx, owner, name, segmentNumber(segs[4]));
      if (segs.length === 6 && segs[5] === 'comments' && method === 'POST') {
        return createComment(ctx, owner, name, segmentNumber(segs[4]));
      }
      if (segs.length === 6 && segs[5] === 'comments' && method === 'GET') {
        return listComments(ctx, owner, name, segmentNumber(segs[4]));
      }
    } else if (sub === 'pulls') {
      if (segs.length === 4 && method === 'GET') return listPulls(ctx, owner, name);
      if (segs.length === 4 && method === 'POST') return createPull(ctx, owner, name);
      if (segs.length === 5 && method === 'GET') return getPull(ctx, owner, name, segmentNumber(segs[4]));
      if (segs.length === 5 && method === 'PATCH') return patchPull(ctx, owner, name, segmentNumber(segs[4]));
      if (segs.length === 6 && segs[5] === 'files' && method === 'GET') {
        return getPullFiles(ctx, owner, name, segmentNumber(segs[4]));
      }
      if (segs.length === 6 && segs[5] === 'merge' && method === 'PUT') {
        return mergePull(ctx, owner, name, segmentNumber(segs[4]));
      }
    }
    throw new HttpError(404, 'Not Found');
  }

  throw new HttpError(404, 'Not Found');
};
