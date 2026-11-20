// GraphQL v4 surface: POST /api/graphql executing the v4 documents the suite sends
// (spec 03-graphql.md) — viewer, repository, node, search, __type introspection, issue and
// pull-request connections with cursor pagination, and the five mutations (createIssue,
// closeIssue, createPullRequest, mergePullRequest, addComment). A small purpose-built
// engine: a tokenizer, a recursive-descent parser (operations, variable definitions,
// aliases, arguments, inline fragments, nested selection sets), a validation pass that
// names unknown fields the way GitHub does, and an executor over the hand-written schema
// below. Everything resolves against the shared store (store.ts), so a mutation here is
// a REST-visible fact there, and the git state the fixtures push drives defaultBranchRef,
// headRefName/baseRefName and the pull-request file diffs.
//
// Global ids are base64 of a typed, colon-joined key ("Repository:5000",
// "Issue:5000:1000", "PullRequest:5000:1001", "IssueComment:1002", "User:1000") — opaque
// (never the plain decimal of the numeric id; spec 03, §4 #19), stable across reads, and
// self-describing enough for node(id:) and every mutation input to resolve them back to
// the object they were issued for.

import type { SurfaceHandler } from './app.ts';
import {
  type Issue,
  type PullRequest,
  type Repo,
  type User,
  formatCommit,
  nowIso,
  parseCommit,
  parseTree,
} from './store.ts';

// ---------------------------------------------------------------------------
// Global ids
// ---------------------------------------------------------------------------

function encodeId(...parts: readonly (string | number)[]): string {
  return Buffer.from(parts.join(':'), 'utf8').toString('base64');
}

function decodeId(id: string): string[] | null {
  if (!id) return null;
  const text = Buffer.from(id, 'base64').toString('utf8');
  const parts = text.split(':');
  if (parts.length < 2 || !/^[A-Za-z]+$/.test(parts[0])) return null;
  return parts;
}

function repoGlobalId(repo: Repo): string {
  return encodeId('Repository', repo.id);
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return encodeId('Issue', repo.id, issue.id);
}

function pullGlobalId(repo: Repo, pull: PullRequest): string {
  return encodeId('PullRequest', repo.id, pull.id);
}

/** The repo an entity was last served from (issues/pulls do not carry their repo). */
const entityRepo = new WeakMap<object, Repo>();

function tag<T extends object>(entity: T, repo: Repo): T {
  entityRepo.set(entity, repo);
  return entity;
}

function repoByGlobalId(forge: SurfaceForge, id: string): Repo | undefined {
  const parts = decodeId(id);
  if (!parts || parts[0] !== 'Repository') return undefined;
  const wanted = Number(parts[1]);
  for (const repo of forge.repos.values()) if (repo.id === wanted) return repo;
  return undefined;
}

function issueByGlobalId(forge: SurfaceForge, id: string): { repo: Repo; issue: Issue } | undefined {
  const parts = decodeId(id);
  if (!parts || parts[0] !== 'Issue') return undefined;
  const repo = repoByGlobalId(forge, encodeId('Repository', parts[1]));
  if (!repo) return undefined;
  const issue = repo.issues.find((candidate) => candidate.id === Number(parts[2]));
  return issue ? { repo, issue } : undefined;
}

function pullByGlobalId(forge: SurfaceForge, id: string): { repo: Repo; pull: PullRequest } | undefined {
  const parts = decodeId(id);
  if (!parts || parts[0] !== 'PullRequest') return undefined;
  const repo = repoByGlobalId(forge, encodeId('Repository', parts[1]));
  if (!repo) return undefined;
  const pull = repo.pulls.find((candidate) => candidate.id === Number(parts[2]));
  return pull ? { repo, pull } : undefined;
}

/** The slice of the Forge the resolvers use (the real Forge satisfies it structurally). */
interface SurfaceForge {
  readonly repos: Map<string, Repo>;
  viewerForToken(token: string): User | null;
  userByLogin(login: string): User | undefined;
  userById(id: number): User | undefined;
  reposOf(owner: string): Repo[];
  visibleRepo(viewer: User, owner: string, name: string): Repo | undefined;
  addIssue(repo: Repo, fields: { title: string; body?: string | null; user: User }): Issue;
  addPull(
    repo: Repo,
    fields: {
      title: string;
      body?: string | null;
      user: User;
      head: { ref: string; sha: string | null; label: string };
      base: { ref: string; sha: string | null; label: string };
    },
  ): PullRequest;
  addComment(
    target: Issue | PullRequest,
    fields: { body: string; user: User },
  ): { id: number; body: string; user: User };
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread' | 'eof';
  value: string;
}

const PUNCT = new Set(['!', '$', '(', ')', ':', '=', '@', '[', ']', '{', '}', '|', '&']);

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[_A-Za-z]/.test(c);
  const isNameChar = (c: string): boolean => /[_0-9A-Za-z]/.test(c);
  while (i < source.length) {
    const c = source[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '\uFEFF') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && source.startsWith('...', i)) {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if (PUNCT.has(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'b') out += '\b';
          else if (esc === 'f') out += '\f';
          else if (esc === 'u') {
            out += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      let isFloat = false;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface ArgumentNode {
  name: string;
  value: ValueNode;
}

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: ArgumentNode[];
  selectionSet: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'inlineFragment'; typeCondition: string | null; selectionSet: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string };

interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  selectionSet: SelectionNode[];
}

interface FragmentDef {
  typeCondition: string;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentDef>;
}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    this.pos += 1;
    return token;
  }

  private expect(kind: Token['kind'], value?: string): Token {
    const token = this.next();
    if (token.kind !== kind || (value !== undefined && token.value !== value)) {
      throw new Error(`expected ${value ?? kind}, found ${token.value || token.kind}`);
    }
    return token;
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  private eatPunct(value: string): boolean {
    if (!this.atPunct(value)) return false;
    this.pos += 1;
    return true;
  }

  private expectName(): string {
    return this.expect('name').value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ operation: 'query', name: null, selectionSet: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'query' || keyword === 'mutation' || keyword === 'subscription') {
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        if (this.atPunct('(')) this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({
          operation: keyword === 'mutation' ? 'mutation' : 'query',
          name,
          selectionSet: this.parseSelectionSet(),
        });
      } else if (keyword === 'fragment') {
        const fragName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected "on" in fragment definition');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected definition ${keyword}`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expect('punct', '(');
    while (!this.atPunct(')')) {
      this.expect('punct', '$');
      this.expectName();
      this.expect('punct', ':');
      this.parseTypeRef();
      if (this.eatPunct('=')) this.parseValue();
      this.skipDirectives();
    }
    this.expect('punct', ')');
  }

  private parseTypeRef(): void {
    if (this.eatPunct('[')) {
      this.parseTypeRef();
      this.expect('punct', ']');
    } else {
      this.expectName();
    }
    this.eatPunct('!');
  }

  private skipDirectives(): void {
    while (this.eatPunct('@')) {
      this.expectName();
      if (this.atPunct('(')) this.parseArguments();
    }
  }

  private parseArguments(): ArgumentNode[] {
    const args: ArgumentNode[] = [];
    this.expect('punct', '(');
    while (!this.atPunct(')')) {
      const name = this.expectName();
      this.expect('punct', ':');
      args.push({ name, value: this.parseValue() });
    }
    this.expect('punct', ')');
    return args;
  }

  private parseSelectionSet(): SelectionNode[] {
    const selections: SelectionNode[] = [];
    this.expect('punct', '{');
    while (!this.atPunct('}')) selections.push(this.parseSelection());
    this.expect('punct', '}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'spread') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (this.atPunct('@')) {
        this.skipDirectives();
        return { kind: 'inlineFragment', typeCondition: null, selectionSet: this.parseSelectionSet() };
      }
      const name = this.expectName();
      this.skipDirectives();
      return { kind: 'fragmentSpread', name };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.eatPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args = this.atPunct('(') ? this.parseArguments() : [];
    this.skipDirectives();
    const selectionSet = this.atPunct('{') ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseValue(): ValueNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '$') {
      this.next();
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      this.next();
      const values: ValueNode[] = [];
      while (!this.atPunct(']')) values.push(this.parseValue());
      this.expect('punct', ']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      this.next();
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.atPunct('}')) {
        const name = this.expectName();
        this.expect('punct', ':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('punct', '}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') {
      this.next();
      return { kind: 'string', value: token.value };
    }
    if (token.kind === 'int') {
      this.next();
      return { kind: 'int', value: parseInt(token.value, 10) };
    }
    if (token.kind === 'float') {
      this.next();
      return { kind: 'float', value: parseFloat(token.value) };
    }
    if (token.kind === 'name') {
      this.next();
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected token ${token.value || token.kind} where a value was expected`);
  }
}

// ---------------------------------------------------------------------------
// Values, type references, execution environment
// ---------------------------------------------------------------------------

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((value) => evalValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, variables);
      return out;
    }
  }
}

function evalArgs(args: readonly ArgumentNode[], variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of args) out[arg.name] = evalValue(arg.value, variables);
  return out;
}

function namedType(type: string): string {
  return type.replace(/[[\]!]/g, '');
}

function isListType(type: string): boolean {
  const trimmed = type.endsWith('!') ? type.slice(0, -1) : type;
  return trimmed.startsWith('[');
}

function innerType(type: string): string {
  let trimmed = type.endsWith('!') ? type.slice(0, -1) : type;
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) trimmed = trimmed.slice(1, -1);
  return trimmed;
}

interface ExecEnv {
  forge: SurfaceForge;
  viewer: User;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentDef>;
}

interface GqlError {
  message: string;
}

// ---------------------------------------------------------------------------
// Connections: nodes + pageInfo with opaque cursors. A cursor is the base64 of
// "cursor:<index>" — the item's index in the connection's full (filtered, ordered)
// list; `after` resumes strictly after it. `first` is a hard cap.
// ---------------------------------------------------------------------------

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
  hasPreviousPage: boolean;
  startCursor: string | null;
}

interface Connection<T> {
  items: T[];
  pageInfo: PageInfo;
}

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  const match = /^cursor:(\d+)$/.exec(Buffer.from(cursor, 'base64').toString('utf8'));
  return match ? Number(match[1]) : null;
}

function paginate<T>(all: readonly T[], args: Record<string, unknown>): Connection<T> {
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    const index = decodeCursor(args.after);
    if (index !== null) start = index + 1;
  }
  const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.floor(args.first)) : all.length;
  const items = all.slice(start, start + first);
  return {
    items,
    pageInfo: {
      hasNextPage: start + items.length < all.length,
      endCursor: items.length > 0 ? encodeCursor(start + items.length - 1) : typeof args.after === 'string' ? args.after : null,
      hasPreviousPage: start > 0,
      startCursor: items.length > 0 ? encodeCursor(start) : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Pull-request file diffs: the paths whose blob differs between the base tip's
// tree and the head tip's tree (added, removed or changed), read from the refs
// the fixtures pushed. This is the diff the pulls' commits describe.
// ---------------------------------------------------------------------------

function flattenTree(repo: Repo, treeOid: string, prefix: string, out: Map<string, string>): void {
  const object = repo.getObject(treeOid);
  if (!object || object.type !== 'tree') return;
  for (const entry of parseTree(object.data)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else if (entry.mode !== '160000') out.set(path, entry.oid);
  }
}

function pullRequestPaths(repo: Repo, pull: PullRequest): string[] {
  const baseSha = repo.getRef(`refs/heads/${pull.base.ref}`) ?? pull.base.sha;
  const headSha = repo.getRef(`refs/heads/${pull.head.ref}`) ?? pull.head.sha;
  if (!baseSha || !headSha) return [];
  const baseObject = repo.getObject(baseSha);
  const headObject = repo.getObject(headSha);
  if (baseObject?.type !== 'commit' || headObject?.type !== 'commit') return [];
  const baseFiles = new Map<string, string>();
  const headFiles = new Map<string, string>();
  flattenTree(repo, parseCommit(baseObject.data).tree, '', baseFiles);
  flattenTree(repo, parseCommit(headObject.data).tree, '', headFiles);
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  return [...paths].filter((path) => baseFiles.get(path) !== headFiles.get(path)).sort();
}

// ---------------------------------------------------------------------------
// Validation: every selected field must exist on its parent type. The one
// negative the suite sends (spec 03, §4 #14) needs an error whose message names
// the offending field, in GitHub's wording.
// ---------------------------------------------------------------------------

function validateSelectionSet(
  typeName: string,
  selections: readonly SelectionNode[],
  fragments: Map<string, FragmentDef>,
  errors: GqlError[],
): void {
  const typeDef = SCHEMA[typeName];
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      const target = selection.typeCondition ?? typeName;
      if (SCHEMA[target]) validateSelectionSet(target, selection.selectionSet, fragments, errors);
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = fragments.get(selection.name);
      if (fragment && SCHEMA[fragment.typeCondition]) {
        validateSelectionSet(fragment.typeCondition, fragment.selectionSet, fragments, errors);
      }
      continue;
    }
    if (selection.name === '__typename') continue;
    const fieldDef = typeDef?.fields?.[selection.name];
    if (!fieldDef) {
      errors.push({ message: `Field '${selection.name}' doesn't exist on type '${typeName}'` });
      continue;
    }
    if (selection.selectionSet) {
      const target = namedType(fieldDef.type);
      if (SCHEMA[target]) validateSelectionSet(target, selection.selectionSet, fragments, errors);
    }
  }
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

const NODE_IMPLEMENTORS = new Set(['Repository', 'User', 'Issue', 'PullRequest', 'IssueComment']);

function fragmentApplies(typeCondition: string | null, concreteType: string): boolean {
  if (!typeCondition) return true;
  if (typeCondition === concreteType) return true;
  return typeCondition === 'Node' && NODE_IMPLEMENTORS.has(concreteType);
}

function execSelectionSet(
  typeName: string,
  source: unknown,
  selections: readonly SelectionNode[],
  env: ExecEnv,
  out: Record<string, unknown>,
): void {
  const typeDef = SCHEMA[typeName];
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (fragmentApplies(selection.typeCondition, typeName)) {
        execSelectionSet(typeName, source, selection.selectionSet, env, out);
      }
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = env.fragments.get(selection.name);
      if (fragment && fragmentApplies(fragment.typeCondition, typeName)) {
        execSelectionSet(typeName, source, fragment.selectionSet, env, out);
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const fieldDef = typeDef?.fields?.[selection.name];
    if (!fieldDef) {
      // Validation has already reported this field; answer null and keep going.
      out[key] = null;
      continue;
    }
    const args = evalArgs(selection.args, env.variables);
    const raw = fieldDef.resolve(source, args, env);
    out[key] = completeValue(fieldDef.type, raw, selection.selectionSet, env);
  }
}

function completeValue(
  type: string,
  value: unknown,
  selectionSet: readonly SelectionNode[] | null,
  env: ExecEnv,
): unknown {
  if (type.endsWith('!')) return completeValue(type.slice(0, -1), value, selectionSet, env);
  if (value === null || value === undefined) return null;
  if (isListType(type)) {
    const inner = innerType(type);
    return (value as readonly unknown[]).map((item) => completeValue(inner, item, selectionSet, env));
  }
  const name = namedType(type);
  const def = SCHEMA[name];
  if (!def || def.kind === 'SCALAR') return name === 'ID' ? String(value) : value;
  if (def.kind === 'ENUM') return value;
  let concrete = name;
  let source: unknown = value;
  if (def.kind === 'INTERFACE') {
    const tagged = value as { __nodeType?: string; entity?: unknown };
    if (tagged && typeof tagged === 'object' && tagged.__nodeType) {
      concrete = tagged.__nodeType;
      source = tagged.entity;
    }
  }
  const out: Record<string, unknown> = {};
  execSelectionSet(concrete, source, selectionSet ?? [], env, out);
  return out;
}

/** Resolve a global id to a Node-tagged entity for Query.node. */
function resolveNode(forge: SurfaceForge, id: string): { __nodeType: string; entity: unknown } | null {
  const parts = decodeId(id);
  if (!parts) return null;
  switch (parts[0]) {
    case 'Repository': {
      const repo = repoByGlobalId(forge, id);
      return repo ? { __nodeType: 'Repository', entity: repo } : null;
    }
    case 'Issue': {
      const found = issueByGlobalId(forge, id);
      return found ? { __nodeType: 'Issue', entity: tag(found.issue, found.repo) } : null;
    }
    case 'PullRequest': {
      const found = pullByGlobalId(forge, id);
      return found ? { __nodeType: 'PullRequest', entity: tag(found.pull, found.repo) } : null;
    }
    case 'User': {
      const user = forge.userById(Number(parts[1]));
      return user ? { __nodeType: 'User', entity: user } : null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Schema. Only the types and fields the suite's documents touch (spec 03, §2),
// plus the minimum introspection surface. Field lists double as the __type
// answer, so they carry the names §4 #3/#4 pin, with room to spare.
// ---------------------------------------------------------------------------

type Resolver = (source: any, args: Record<string, unknown>, env: ExecEnv) => unknown;

interface FieldDef {
  type: string;
  resolve: Resolver;
}

interface TypeDef {
  kind: 'OBJECT' | 'INTERFACE' | 'ENUM' | 'SCALAR';
  fields?: Record<string, FieldDef>;
  values?: readonly string[];
}

const scalar = (): TypeDef => ({ kind: 'SCALAR' });
const enumOf = (values: readonly string[]): TypeDef => ({ kind: 'ENUM', values });
const objectOf = (fields: Record<string, FieldDef>): TypeDef => ({ kind: 'OBJECT', fields });

/** Apply a pull-request merge to the store: state the REST surface reads, plus a real squash commit on the base ref. */
function mergePullRequest(env: ExecEnv, repo: Repo, pull: PullRequest): void {
  const stamp = nowIso();
  pull.merged = true;
  pull.state = 'closed';
  pull.merged_at = stamp;
  pull.closed_at = stamp;
  pull.updated_at = stamp;
  const baseRef = `refs/heads/${pull.base.ref}`;
  const baseSha = repo.getRef(baseRef);
  const headSha = repo.getRef(`refs/heads/${pull.head.ref}`) ?? pull.head.sha;
  if (!baseSha || !headSha || baseSha === headSha) return;
  const headObject = repo.getObject(headSha);
  if (headObject?.type !== 'commit') return;
  const tree = parseCommit(headObject.data).tree;
  const seconds = Math.floor(Date.now() / 1000);
  const ident = `${env.viewer.name} <${env.viewer.email}> ${seconds} +0000`;
  const commitData = formatCommit({
    tree,
    parents: [baseSha],
    author: ident,
    committer: ident,
    message: `${pull.title} (#${pull.number})\n`,
  });
  const sha = repo.putObject('commit', commitData);
  repo.setRef(baseRef, sha);
  pull.merge_commit_sha = sha;
}

const SCHEMA: Record<string, TypeDef> = {
  String: scalar(),
  Int: scalar(),
  Float: scalar(),
  Boolean: scalar(),
  ID: scalar(),

  IssueState: enumOf(['OPEN', 'CLOSED']),
  PullRequestState: enumOf(['OPEN', 'CLOSED', 'MERGED']),
  MergeableState: enumOf(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']),
  RepositoryPermission: enumOf(['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ']),
  PullRequestMergeMethod: enumOf(['MERGE', 'SQUASH', 'REBASE']),
  IssueOrderField: enumOf(['CREATED_AT', 'UPDATED_AT', 'COMMENTS']),
  OrderDirection: enumOf(['ASC', 'DESC']),
  SearchType: enumOf(['ISSUE', 'REPOSITORY', 'USER']),

  Node: {
    kind: 'INTERFACE',
    fields: {
      id: {
        type: 'ID!',
        resolve: (source, _args, env) => {
          if (source && typeof source === 'object' && 'fullName' in source) return repoGlobalId(source as Repo);
          return null;
        },
      },
    },
  },

  Query: objectOf({
    viewer: {
      type: 'User',
      resolve: (_source, _args, env) => env.viewer,
    },
    repository: {
      type: 'Repository',
      resolve: (_source, args, env) =>
        env.forge.visibleRepo(env.viewer, String(args.owner ?? ''), String(args.name ?? '')) ?? null,
    },
    node: {
      type: 'Node',
      resolve: (_source, args, env) => resolveNode(env.forge, String(args.id ?? '')),
    },
    search: {
      type: 'SearchResultItemConnection',
      resolve: (_source, args, env) => {
        const needle = String(args.query ?? '').toLowerCase();
        const found: Issue[] = [];
        for (const repo of env.forge.reposOf(env.viewer.login)) {
          for (const issue of repo.issues) {
            if (needle === '' || issue.title.toLowerCase().includes(needle)) found.push(tag(issue, repo));
          }
        }
        return paginate(found, args);
      },
    },
    __type: {
      type: '__Type',
      resolve: (_source, args) => ({ __typeName: String(args.name ?? '') }),
    },
  }),

  Mutation: objectOf({
    createIssue: {
      type: 'CreateIssuePayload',
      resolve: (_source, args, env) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = repoByGlobalId(env.forge, String(input.repositoryId ?? ''));
        if (!repo) throw new Error('repository not found for createIssue');
        const issue = env.forge.addIssue(repo, {
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : null,
          user: env.viewer,
        });
        return { issue: tag(issue, repo) };
      },
    },
    closeIssue: {
      type: 'CloseIssuePayload',
      resolve: (_source, args, env) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = issueByGlobalId(env.forge, String(input.issueId ?? ''));
        if (!found) throw new Error('issue not found for closeIssue');
        const stamp = nowIso();
        found.issue.state = 'closed';
        found.issue.closed_at = stamp;
        found.issue.updated_at = stamp;
        return { issue: tag(found.issue, found.repo) };
      },
    },
    createPullRequest: {
      type: 'CreatePullRequestPayload',
      resolve: (_source, args, env) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = repoByGlobalId(env.forge, String(input.repositoryId ?? ''));
        if (!repo) throw new Error('repository not found for createPullRequest');
        const headRefName = String(input.headRefName ?? '');
        const baseRefName = String(input.baseRefName ?? '');
        const pull = env.forge.addPull(repo, {
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : null,
          user: env.viewer,
          head: {
            ref: headRefName,
            sha: repo.getRef(`refs/heads/${headRefName}`) ?? null,
            label: `${repo.owner}:${headRefName}`,
          },
          base: {
            ref: baseRefName,
            sha: repo.getRef(`refs/heads/${baseRefName}`) ?? null,
            label: `${repo.owner}:${baseRefName}`,
          },
        });
        return { pullRequest: tag(pull, repo) };
      },
    },
    mergePullRequest: {
      type: 'MergePullRequestPayload',
      resolve: (_source, args, env) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = pullByGlobalId(env.forge, String(input.pullRequestId ?? ''));
        if (!found) throw new Error('pull request not found for mergePullRequest');
        mergePullRequest(env, found.repo, found.pull);
        return { pullRequest: tag(found.pull, found.repo) };
      },
    },
    addComment: {
      type: 'AddCommentPayload',
      resolve: (_source, args, env) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const subjectId = String(input.subjectId ?? '');
        const issueFound = issueByGlobalId(env.forge, subjectId);
        if (issueFound) {
          const comment = env.forge.addComment(issueFound.issue, {
            body: String(input.body ?? ''),
            user: env.viewer,
          });
          return { commentEdge: { node: comment, cursor: null } };
        }
        const pullFound = pullByGlobalId(env.forge, subjectId);
        if (pullFound) {
          const comment = env.forge.addComment(pullFound.pull, {
            body: String(input.body ?? ''),
            user: env.viewer,
          });
          return { commentEdge: { node: comment, cursor: null } };
        }
        throw new Error('subject not found for addComment');
      },
    },
  }),

  User: objectOf({
    id: { type: 'ID!', resolve: (user: User) => encodeId('User', user.id) },
    login: { type: 'String!', resolve: (user: User) => user.login },
    name: { type: 'String', resolve: (user: User) => user.name },
  }),

  Repository: objectOf({
    id: { type: 'ID!', resolve: (repo: Repo) => repoGlobalId(repo) },
    databaseId: { type: 'Int!', resolve: (repo: Repo) => repo.id },
    name: { type: 'String!', resolve: (repo: Repo) => repo.name },
    nameWithOwner: { type: 'String!', resolve: (repo: Repo) => repo.fullName },
    owner: {
      type: 'User',
      resolve: (repo: Repo, _args, env) =>
        env.forge.userByLogin(repo.owner) ?? { id: 0, login: repo.owner, name: repo.owner, email: '', type: 'User' },
    },
    description: { type: 'String', resolve: (repo: Repo) => repo.description },
    isPrivate: { type: 'Boolean!', resolve: (repo: Repo) => repo.private },
    viewerPermission: { type: 'RepositoryPermission', resolve: () => 'ADMIN' },
    hasIssuesEnabled: { type: 'Boolean!', resolve: () => true },
    defaultBranchRef: {
      type: 'Ref',
      resolve: (repo: Repo) => (repo.headOid() ? { name: repo.defaultBranch } : null),
    },
    issue: {
      type: 'Issue',
      resolve: (repo: Repo, args) => {
        const issue = repo.findIssue(Number(args.number));
        return issue ? tag(issue, repo) : null;
      },
    },
    issues: {
      type: 'IssueConnection',
      resolve: (repo: Repo, args) => {
        let list = repo.issues.map((issue) => tag(issue, repo));
        if (Array.isArray(args.states) && args.states.length > 0) {
          const wanted = new Set(args.states.map((state) => String(state).toLowerCase()));
          list = list.filter((issue) => wanted.has(issue.state));
        }
        const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
        if (orderBy && typeof orderBy.field === 'string') {
          const dir = orderBy.direction === 'DESC' ? -1 : 1;
          const keyOf = (issue: Issue): string | number => {
            if (orderBy.field === 'UPDATED_AT') return issue.updated_at;
            if (orderBy.field === 'COMMENTS') return issue.comments.length;
            return issue.created_at;
          };
          list = [...list].sort((a, b) => {
            const ka = keyOf(a);
            const kb = keyOf(b);
            if (ka < kb) return -dir;
            if (ka > kb) return dir;
            return (a.number - b.number) * dir;
          });
        }
        return paginate(list, args);
      },
    },
    pullRequest: {
      type: 'PullRequest',
      resolve: (repo: Repo, args) => {
        const pull = repo.findPull(Number(args.number));
        return pull ? tag(pull, repo) : null;
      },
    },
    pullRequests: {
      type: 'PullRequestConnection',
      resolve: (repo: Repo, args) => {
        let list = repo.pulls.map((pull) => tag(pull, repo));
        if (Array.isArray(args.states) && args.states.length > 0) {
          const wanted = new Set(args.states.map((state) => String(state)));
          list = list.filter((pull) => wanted.has(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
        } else {
          // GitHub's default for this connection is the open pull requests.
          list = list.filter((pull) => pull.state === 'open' && !pull.merged);
        }
        return paginate(list, args);
      },
    },
  }),

  Ref: objectOf({
    name: { type: 'String!', resolve: (ref: { name: string }) => ref.name },
  }),

  Issue: objectOf({
    id: {
      type: 'ID!',
      resolve: (issue: Issue) => {
        const repo = entityRepo.get(issue);
        return encodeId('Issue', repo ? repo.id : 0, issue.id);
      },
    },
    number: { type: 'Int!', resolve: (issue: Issue) => issue.number },
    title: { type: 'String!', resolve: (issue: Issue) => issue.title },
    state: { type: 'IssueState!', resolve: (issue: Issue) => issue.state.toUpperCase() },
    body: { type: 'String', resolve: (issue: Issue) => issue.body },
    author: { type: 'User', resolve: (issue: Issue) => issue.user },
    labels: {
      type: 'LabelConnection',
      resolve: (issue: Issue, args) => paginate(issue.labels, args),
    },
  }),

  PullRequest: objectOf({
    id: {
      type: 'ID!',
      resolve: (pull: PullRequest) => {
        const repo = entityRepo.get(pull);
        return encodeId('PullRequest', repo ? repo.id : 0, pull.id);
      },
    },
    number: { type: 'Int!', resolve: (pull: PullRequest) => pull.number },
    title: { type: 'String!', resolve: (pull: PullRequest) => pull.title },
    state: {
      type: 'PullRequestState!',
      resolve: (pull: PullRequest) => (pull.merged ? 'MERGED' : pull.state.toUpperCase()),
    },
    merged: { type: 'Boolean!', resolve: (pull: PullRequest) => pull.merged },
    headRefName: { type: 'String!', resolve: (pull: PullRequest) => pull.head.ref },
    baseRefName: { type: 'String!', resolve: (pull: PullRequest) => pull.base.ref },
    mergeable: {
      type: 'MergeableState!',
      resolve: (pull: PullRequest) => (pull.state === 'open' && !pull.merged ? 'MERGEABLE' : 'UNKNOWN'),
    },
    author: { type: 'User', resolve: (pull: PullRequest) => pull.user },
    files: {
      type: 'PullRequestChangedFileConnection',
      resolve: (pull: PullRequest, args) => {
        const repo = entityRepo.get(pull);
        const paths = repo ? pullRequestPaths(repo, pull) : [];
        return paginate(
          paths.map((path) => ({ path })),
          args,
        );
      },
    },
  }),

  PullRequestChangedFile: objectOf({
    path: { type: 'String!', resolve: (file: { path: string }) => file.path },
  }),

  Label: objectOf({
    id: { type: 'ID!', resolve: (label: { id: number }) => encodeId('Label', label.id) },
    name: { type: 'String!', resolve: (label: { name: string }) => label.name },
    color: { type: 'String!', resolve: (label: { color: string }) => label.color },
    description: { type: 'String', resolve: (label: { description: string | null }) => label.description },
  }),

  IssueComment: objectOf({
    id: { type: 'ID!', resolve: (comment: { id: number }) => encodeId('IssueComment', comment.id) },
    body: { type: 'String!', resolve: (comment: { body: string }) => comment.body },
    author: { type: 'User', resolve: (comment: { user: User }) => comment.user },
  }),

  PageInfo: objectOf({
    hasNextPage: { type: 'Boolean!', resolve: (page: PageInfo) => page.hasNextPage },
    endCursor: { type: 'String', resolve: (page: PageInfo) => page.endCursor },
    hasPreviousPage: { type: 'Boolean!', resolve: (page: PageInfo) => page.hasPreviousPage },
    startCursor: { type: 'String', resolve: (page: PageInfo) => page.startCursor },
  }),

  IssueConnection: objectOf({
    nodes: { type: '[Issue]', resolve: (connection: Connection<Issue>) => connection.items },
    pageInfo: { type: 'PageInfo', resolve: (connection: Connection<unknown>) => connection.pageInfo },
  }),
  PullRequestConnection: objectOf({
    nodes: { type: '[PullRequest]', resolve: (connection: Connection<PullRequest>) => connection.items },
    pageInfo: { type: 'PageInfo', resolve: (connection: Connection<unknown>) => connection.pageInfo },
  }),
  PullRequestChangedFileConnection: objectOf({
    nodes: {
      type: '[PullRequestChangedFile]',
      resolve: (connection: Connection<{ path: string }>) => connection.items,
    },
    pageInfo: { type: 'PageInfo', resolve: (connection: Connection<unknown>) => connection.pageInfo },
  }),
  LabelConnection: objectOf({
    nodes: { type: '[Label]', resolve: (connection: Connection<unknown>) => connection.items },
    pageInfo: { type: 'PageInfo', resolve: (connection: Connection<unknown>) => connection.pageInfo },
  }),
  SearchResultItemConnection: objectOf({
    nodes: { type: '[Issue]', resolve: (connection: Connection<Issue>) => connection.items },
    pageInfo: { type: 'PageInfo', resolve: (connection: Connection<unknown>) => connection.pageInfo },
  }),

  CreateIssuePayload: objectOf({
    issue: { type: 'Issue', resolve: (payload: { issue: Issue }) => payload.issue },
  }),
  CloseIssuePayload: objectOf({
    issue: { type: 'Issue', resolve: (payload: { issue: Issue }) => payload.issue },
  }),
  CreatePullRequestPayload: objectOf({
    pullRequest: { type: 'PullRequest', resolve: (payload: { pullRequest: PullRequest }) => payload.pullRequest },
  }),
  MergePullRequestPayload: objectOf({
    pullRequest: { type: 'PullRequest', resolve: (payload: { pullRequest: PullRequest }) => payload.pullRequest },
  }),
  AddCommentPayload: objectOf({
    commentEdge: {
      type: 'AddCommentEdge',
      resolve: (payload: { commentEdge: unknown }) => payload.commentEdge,
    },
  }),
  AddCommentEdge: objectOf({
    node: { type: 'IssueComment', resolve: (edge: { node: unknown }) => edge.node },
    cursor: { type: 'String', resolve: (edge: { cursor: string | null }) => edge.cursor },
  }),

  __Type: objectOf({
    name: { type: 'String', resolve: (type: { __typeName: string }) => type.__typeName },
    kind: {
      type: 'String',
      resolve: (type: { __typeName: string }) => SCHEMA[type.__typeName]?.kind ?? null,
    },
    description: { type: 'String', resolve: () => null },
    fields: {
      type: '[__Field]',
      resolve: (type: { __typeName: string }) => {
        const def = SCHEMA[type.__typeName];
        if (!def || (def.kind !== 'OBJECT' && def.kind !== 'INTERFACE')) return null;
        return Object.keys(def.fields ?? {}).map((name) => ({ name }));
      },
    },
    enumValues: {
      type: '[__EnumValue]',
      resolve: (type: { __typeName: string }) => {
        const def = SCHEMA[type.__typeName];
        if (!def || def.kind !== 'ENUM') return null;
        return (def.values ?? []).map((name) => ({ name }));
      },
    },
  }),
  __Field: objectOf({
    name: { type: 'String!', resolve: (field: { name: string }) => field.name },
    description: { type: 'String', resolve: () => null },
  }),
  __EnumValue: objectOf({
    name: { type: 'String!', resolve: (value: { name: string }) => value.name },
    description: { type: 'String', resolve: () => null },
  }),
};

// ---------------------------------------------------------------------------
// Request execution and the HTTP handler
// ---------------------------------------------------------------------------

function executeRequest(forge: SurfaceForge, viewer: User, entry: unknown): Record<string, unknown> {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { errors: [{ message: 'request entry must be a JSON object' }] };
  }
  const record = entry as Record<string, unknown>;
  if (typeof record.query !== 'string') {
    return { errors: [{ message: 'query must be a string' }] };
  }
  let document: DocumentNode;
  try {
    document = new Parser(record.query).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operation = document.operations[0];
  if (!operation) return { errors: [{ message: 'the document holds no operation' }] };
  const rawVariables = record.variables;
  const env: ExecEnv = {
    forge,
    viewer,
    variables:
      rawVariables && typeof rawVariables === 'object' && !Array.isArray(rawVariables)
        ? (rawVariables as Record<string, unknown>)
        : {},
    fragments: document.fragments,
  };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const errors: GqlError[] = [];
  validateSelectionSet(rootType, operation.selectionSet, env.fragments, errors);
  if (errors.length > 0) return { data: null, errors };
  try {
    const data: Record<string, unknown> = {};
    execSelectionSet(rootType, null, operation.selectionSet, env, data);
    return { data };
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}

export const handleGraphql: SurfaceHandler = (ctx) => {
  // Spec 03, §4 #15: no usable token is exactly 401, before anything else runs.
  const viewer = ctx.requireViewer();
  const body = ctx.jsonBody();
  if (Array.isArray(body)) {
    ctx.sendJson(
      200,
      body.map((entry) => executeRequest(ctx.forge, viewer, entry)),
    );
    return;
  }
  ctx.sendJson(200, executeRequest(ctx.forge, viewer, body));
};
