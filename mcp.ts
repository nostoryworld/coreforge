// MCP surface (streamable HTTP, spec 04-mcp.md): POST /mcp speaks JSON-RPC 2.0 and answers
// in plain JSON — no session header, no SSE. The server is "modern": server/discover answers
// a result naming serverInfo, capabilities.tools and supportedVersions, so the suite never
// falls back to the legacy handshake; initialize is still answered for any client that asks.
//
// The six canonical tools run over the one shared store (store.ts), so everything MCP creates
// or changes is the same object the REST, GraphQL and git surfaces serve: an MCP-created repo
// reads back over REST with a stable id, an MCP-created issue carries the number REST lists,
// and an MCP merge sets the merged state REST reports.
//
// Error discipline (spec 04, §1.4/§1.6/§2.7): the discover probe is never refused; the one
// auth refusal on this surface is an unauthenticated tools/call, answered exactly HTTP 401
// before the tool or its arguments are judged; a non-JSON body is HTTP 400 with -32700;
// unknown tools and missing/invalid arguments are -32602; tool execution failures are
// results with isError: true. Request ids are echoed verbatim, strings included.

import type { SurfaceContext, SurfaceHandler } from './app.ts';
import { nowIso, type Issue, type PullRequest, type Repo, type User } from './store.ts';

/** The revision this server negotiates: the suite's preferred one (spec 04, §1.4). */
const PROTOCOL_VERSION = '2026-07-28';
/** The date-shaped version answered to a legacy initialize that offers nothing usable. */
const LEGACY_VERSION = '2025-11-25';
const DATE_SHAPED = /^\d{4}-\d{2}-\d{2}$/;

const SERVER_INFO = { name: 'coreforge', version: '1.0.0' } as const;

// ---------------------------------------------------------------------------
// The tool list. Built once, at module load, and served by reference: check 13 compares two
// tools/list answers byte-for-byte after a JSON round-trip, so the objects must never gain
// a per-request field or a new order. Property names are the first-priority synonyms of
// spec 04, §2.4, so the suite's argument mapping fills them under exactly these names, and
// every `required` entry is one the mapping can always fill for that tool.
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login that will own the repository.' },
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by its owner login and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body text.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: "open", "closed" or "all".' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request proposing the head branch into the base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body text.' },
        head: { type: 'string', description: 'The branch to merge from.' },
        base: { type: 'string', description: 'The branch to merge into.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request, addressed by its number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOLS_RESULT = { tools: TOOLS };

// ---------------------------------------------------------------------------
// JSON shapes. The tools return the affected object the way the REST surface serves it, as
// both a JSON text block and structuredContent: the suite reads result text (titles, repo
// names) and result JSON (full_name, number) from those (spec 04, §2.6).
// ---------------------------------------------------------------------------

function userJson(user: User): Record<string, unknown> {
  return { login: user.login, id: user.id, type: user.type };
}

function repoJson(ctx: SurfaceContext, repo: Repo): Record<string, unknown> {
  const owner = ctx.forge.userByLogin(repo.owner);
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: owner ? userJson(owner) : { login: repo.owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
  };
}

function issueJson(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: userJson(issue.user),
    labels: issue.labels.map((label) => ({
      id: label.id,
      name: label.name,
      color: label.color,
      description: label.description,
    })),
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
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    user: userJson(pull.user),
    head: { ref: pull.head.ref, sha: pull.head.sha, label: pull.head.label },
    base: { ref: pull.base.ref, sha: pull.base.sha, label: pull.base.label },
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: pull.closed_at,
  };
}

// ---------------------------------------------------------------------------
// Tool results and argument reading. Validation failures raise InvalidParams, which the
// dispatcher turns into a -32602 JSON-RPC error (spec 04, §2.7); execution failures return
// an isError result. The suite maps its semantic arguments onto the schema's property
// names before calling, so arguments arrive under the canonical names — the synonym
// fallbacks below only cost a lookup and keep hand-sent calls (check 15's shape) readable.
// ---------------------------------------------------------------------------

class InvalidParams extends Error {}

function toolOk(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

type Args = Record<string, unknown>;

function strArg(args: Args, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

function boolArg(args: Args, ...names: string[]): boolean | undefined {
  for (const name of names) {
    if (typeof args[name] === 'boolean') return args[name] as boolean;
  }
  return undefined;
}

function intArg(args: Args, ...names: string[]): number | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  }
  return undefined;
}

/** The owner a call addresses: its owner argument, else the caller's own login. */
function ownerArg(args: Args, viewer: User): string {
  return strArg(args, 'owner', 'owner_login', 'org', 'organization', 'login') ?? viewer.login;
}

/** The repository name a call addresses: repo synonyms, a full_name, or (create) `name`. */
function repoNameArg(args: Args): string | undefined {
  const direct = strArg(args, 'repo', 'repository', 'repo_name', 'repository_name');
  if (direct) return direct;
  const fullName = strArg(args, 'full_name', 'repo_full_name', 'repository_full_name', 'fullName');
  if (fullName && fullName.includes('/')) return fullName.slice(fullName.indexOf('/') + 1);
  return undefined;
}

/** Resolve the repo a call addresses, as the viewer may see it (foreign = not found). */
function visibleRepoArg(ctx: SurfaceContext, viewer: User, args: Args): Repo {
  const name = repoNameArg(args);
  if (!name) throw new InvalidParams('Missing required argument: repo');
  const repo = ctx.forge.visibleRepo(viewer, ownerArg(args, viewer), name);
  if (!repo) throw new Error(`Repository not found: ${ownerArg(args, viewer)}/${name}`);
  return repo;
}

// ---------------------------------------------------------------------------
// The six tools. Each runs synchronously over the store, so concurrent calls on one
// connection cannot cross (check 12): every answer is computed from its own arguments and
// carries its own request id.
// ---------------------------------------------------------------------------

function createRepo(ctx: SurfaceContext, viewer: User, args: Args): Record<string, unknown> {
  const name = strArg(args, 'name', 'repo', 'repository', 'repo_name', 'repository_name');
  if (!name) throw new InvalidParams('Missing required argument: name');
  const owner = ownerArg(args, viewer);
  if (owner !== viewer.login) return toolError(`Cannot create a repository for ${owner}`);
  if (ctx.forge.getRepo(viewer.login, name)) return toolError(`Repository ${viewer.login}/${name} already exists`);
  const repo = ctx.forge.createRepo(viewer.login, name, {
    private: boolArg(args, 'private', 'is_private') ?? false,
    description: strArg(args, 'description', 'about', 'summary', 'body') ?? null,
  });
  if (!repo) return toolError(`Repository ${viewer.login}/${name} already exists`);
  return toolOk(repoJson(ctx, repo));
}

function getRepo(ctx: SurfaceContext, viewer: User, args: Args): Record<string, unknown> {
  let repo: Repo;
  try {
    repo = visibleRepoArg(ctx, viewer, args);
  } catch (err) {
    if (err instanceof InvalidParams) throw err;
    return toolError(err instanceof Error ? err.message : 'Repository not found');
  }
  return toolOk(repoJson(ctx, repo));
}

/** Resolve a repo for a data tool: argument gaps are -32602, a missing repo is isError. */
type RepoLookup = { repo: Repo } | { error: Record<string, unknown> };

function dataRepo(ctx: SurfaceContext, viewer: User, args: Args): RepoLookup {
  try {
    return { repo: visibleRepoArg(ctx, viewer, args) };
  } catch (err) {
    if (err instanceof InvalidParams) throw err;
    return { error: toolError(err instanceof Error ? err.message : 'Repository not found') };
  }
}

function createIssue(ctx: SurfaceContext, viewer: User, args: Args): Record<string, unknown> {
  const title = strArg(args, 'title', 'issue_title', 'subject');
  if (!title) throw new InvalidParams('Missing required argument: title');
  const found = dataRepo(ctx, viewer, args);
  if ('error' in found) return found.error;
  const repo = found.repo;
  const issue = ctx.forge.addIssue(repo, {
    title,
    body: strArg(args, 'body', 'issue_body', 'description', 'content', 'text') ?? null,
    user: viewer,
  });
  return toolOk(issueJson(issue));
}

function listIssues(ctx: SurfaceContext, viewer: User, args: Args): Record<string, unknown> {
  const found = dataRepo(ctx, viewer, args);
  if ('error' in found) return found.error;
  const repo = found.repo;
  const state = strArg(args, 'state', 'status') ?? 'open';
  const issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
  return toolOk(issues.map(issueJson));
}

function createPullRequest(ctx: SurfaceContext, viewer: User, args: Args): Record<string, unknown> {
  const title = strArg(args, 'title', 'pr_title', 'pull_request_title', 'subject');
  if (!title) throw new InvalidParams('Missing required argument: title');
  const head = strArg(args, 'head', 'head_ref', 'head_branch', 'source_branch');
  if (!head) throw new InvalidParams('Missing required argument: head');
  const base = strArg(args, 'base', 'base_ref', 'base_branch', 'target_branch');
  if (!base) throw new InvalidParams('Missing required argument: base');
  const found = dataRepo(ctx, viewer, args);
  if ('error' in found) return found.error;
  const repo = found.repo;
  const headSha = repo.getRef(`refs/heads/${head}`);
  if (!headSha) return toolError(`Head branch not found: ${head}`);
  const pull = ctx.forge.addPull(repo, {
    title,
    body: strArg(args, 'body', 'description', 'content', 'text') ?? null,
    user: viewer,
    head: { ref: head, sha: headSha, label: `${repo.owner}:${head}` },
    base: { ref: base, sha: repo.getRef(`refs/heads/${base}`) ?? null, label: `${repo.owner}:${base}` },
  });
  return toolOk(pullJson(pull));
}

function mergePullRequest(ctx: SurfaceContext, viewer: User, args: Args): Record<string, unknown> {
  const number = intArg(args, 'pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number');
  if (number === undefined) throw new InvalidParams('Missing required argument: pull_number');
  const found = dataRepo(ctx, viewer, args);
  if ('error' in found) return found.error;
  const repo = found.repo;
  const pull = repo.findPull(number);
  if (!pull) return toolError(`Pull request not found: ${number}`);
  if (pull.merged) return toolError(`Pull request ${number} is already merged`);
  if (pull.state !== 'open') return toolError(`Pull request ${number} is not open`);
  // The merge itself: the state REST reads back (merged, merged_at, closed) lives on this
  // one shared object, so the REST surface reports the merge the moment it lands here.
  const stamp = nowIso();
  pull.merged = true;
  pull.merged_at = stamp;
  pull.state = 'closed';
  pull.closed_at = stamp;
  pull.updated_at = stamp;
  repo.touch();
  return toolOk(pullJson(pull));
}

type ToolFn = (ctx: SurfaceContext, viewer: User, args: Args) => Record<string, unknown>;

const TOOL_FNS: Readonly<Record<string, ToolFn>> = {
  create_repo: createRepo,
  get_repo: getRepo,
  create_issue: createIssue,
  list_issues: listIssues,
  create_pull_request: createPullRequest,
  merge_pull_request: mergePullRequest,
};

// ---------------------------------------------------------------------------
// The JSON-RPC layer. One request object per POST (the client never batches); ids are
// echoed verbatim. Notifications (no id member) are accepted and ignored with a bare 202.
// The client's _meta rides along in params and is simply not read.
// ---------------------------------------------------------------------------

function rpcResult(ctx: SurfaceContext, id: unknown, result: unknown): void {
  ctx.sendJson(200, { jsonrpc: '2.0', id, result });
}

function rpcError(ctx: SurfaceContext, status: number, id: unknown, code: number, message: string): void {
  ctx.sendJson(status, { jsonrpc: '2.0', id, error: { code, message } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function handleToolsCall(ctx: SurfaceContext, id: unknown, params: Record<string, unknown>): void {
  // The surface's one auth refusal (spec 04, §1.6/§3.15): exactly HTTP 401, decided before
  // the tool's existence or its arguments are judged.
  if (!ctx.viewer) {
    rpcError(ctx, 401, id, -32001, 'Unauthorized: a Bearer token is required');
    return;
  }
  const name = params.name;
  if (typeof name !== 'string' || name === '') {
    rpcError(ctx, 200, id, -32602, 'Invalid params: tools/call requires a tool name');
    return;
  }
  const fn = TOOL_FNS[name];
  if (!fn) {
    rpcError(ctx, 200, id, -32602, `Unknown tool: ${name}`);
    return;
  }
  const rawArgs = params.arguments;
  const args: Args = isRecord(rawArgs) ? rawArgs : {};
  try {
    rpcResult(ctx, id, fn(ctx, ctx.viewer, args));
  } catch (err) {
    if (err instanceof InvalidParams) {
      rpcError(ctx, 200, id, -32602, `Invalid params: ${err.message}`);
    } else {
      rpcResult(ctx, id, toolError(err instanceof Error ? err.message : String(err)));
    }
  }
}

export const handleMcp: SurfaceHandler = (ctx) => {
  // close() sends one best-effort DELETE when a session was handed out; none ever is, but
  // the answer is ignored either way and must not corrupt state (spec 04, §1.1).
  if (ctx.method === 'DELETE') {
    ctx.sendJson(200, {});
    return;
  }
  if (ctx.method !== 'POST') {
    ctx.sendJson(405, { message: 'Method Not Allowed' });
    return;
  }

  // Parsed here, not via ctx.jsonBody(): a non-JSON body has its own contract — HTTP 400
  // with a -32700 JSON-RPC error (spec 04, §3.10) — not the app shell's GitHub error shape.
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    rpcError(ctx, 400, null, -32700, 'Parse error: the request body is not valid JSON');
    return;
  }
  if (!isRecord(parsed) || typeof parsed.method !== 'string') {
    rpcError(ctx, 200, isRecord(parsed) ? (parsed.id ?? null) : null, -32600, 'Invalid Request: expected a JSON-RPC request object');
    return;
  }

  const method = parsed.method;
  const params: Record<string, unknown> = isRecord(parsed.params) ? parsed.params : {};

  // A message with no id member is a notification: accept and ignore it (any status is
  // swallowed by the client). notifications/initialized is the only one ever sent.
  if (!('id' in parsed)) {
    ctx.res.writeHead(202);
    ctx.res.end();
    return;
  }
  const id = parsed.id;

  switch (method) {
    case 'server/discover':
      // Modern era (spec 04, §1.4): a result object makes the server modern. Never refused
      // for an authenticated caller — no auth is demanded here at all.
      rpcResult(ctx, id, {
        serverInfo: SERVER_INFO,
        capabilities: { tools: {} },
        supportedVersions: [PROTOCOL_VERSION],
      });
      return;
    case 'initialize': {
      const offered = params.protocolVersion;
      rpcResult(ctx, id, {
        protocolVersion: typeof offered === 'string' && DATE_SHAPED.test(offered) ? offered : LEGACY_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;
    }
    case 'tools/list':
      rpcResult(ctx, id, TOOLS_RESULT);
      return;
    case 'tools/call':
      handleToolsCall(ctx, id, params);
      return;
    default:
      rpcError(ctx, 200, id, -32601, `Method not found: ${method}`);
  }
};
