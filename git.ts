// Git smart HTTP surface (spec 01-git-protocol.md).
//
//   GET  /{owner}/{repo}.git/info/refs?service=git-upload-pack    v2 advertisement when the
//                                                                 request carries
//                                                                 Git-Protocol: version=2,
//                                                                 else the v0 advertisement
//   GET  /{owner}/{repo}.git/info/refs?service=git-receive-pack   v0 advertisement
//   POST /{owner}/{repo}.git/git-upload-pack                      v2 ls-refs and fetch;
//                                                                 v0 fetch when no v2 header
//   POST /{owner}/{repo}.git/git-receive-pack                     v0 push with report-status
//
// Objects move byte-verbatim between packs and the store (spec 01, §3.3): the serving path
// never re-serialises a commit, tree or tag. Fetch packs are plain (no deltas — never
// required, §3.2) and hold exactly the closure the negotiation selects: the wants' closure
// minus the haves' closure, or the depth-cut closure for shallow fetches (§5.4). A refused
// push is still a 200 exchange whose report-status carries the refusal in band (§1.9).

import { HttpError, type SurfaceContext, type SurfaceHandler } from './app.ts';
import {
  objectNeighbours,
  parseCommit,
  parseTag,
  ZERO_OID,
  type ObjectType,
  type Repo,
} from './store.ts';
import { buildPack, readPack } from './pack.ts';
import {
  parsePktLines,
  parsePktStream,
  pktFlush,
  pktLine,
  pktText,
  type PktPacket,
} from './pktline.ts';

const UPLOAD_PACK = 'git-upload-pack';
const RECEIVE_PACK = 'git-receive-pack';
const AGENT = 'makefun-forge/1.0';

/** Data bytes per sideband pkt-line: 65516 payload bytes minus the band byte (spec 01, §2.28). */
const SIDEBAND_CHUNK = 65515;

const OID_RE = /^[0-9a-f]{40}$/;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** True when the request asks for protocol v2 (the Git-Protocol header, upload-pack only). */
function wantsV2(ctx: SurfaceContext): boolean {
  const header = ctx.req.headers['git-protocol'];
  const value = Array.isArray(header) ? header.join(' ') : (header ?? '');
  return value.includes('version=2');
}

/** The repo's refs as [name, oid] pairs in git's advertisement order (name-sorted). */
function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** Follow tag objects to the commit they ultimately point at; undefined when not resolvable. */
function peelToCommit(repo: Repo, oid: string): string | undefined {
  let current = oid;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const object = repo.getObject(current);
    if (!object) return undefined;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return undefined;
    current = parseTag(object.data).object;
  }
  return undefined;
}

/** Chunk bytes into sideband band-1 pkt-lines (the packfile section's framing, §1.7). */
function sideband(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let off = 0; off < data.length; off += SIDEBAND_CHUNK) {
    out.push(pktLine(Buffer.concat([Buffer.from([1]), data.subarray(off, off + SIDEBAND_CHUNK)])));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Advertisements (GET info/refs)
// ---------------------------------------------------------------------------

/**
 * The v0 advertisement shared by both services (§1.4/§1.5): preamble, HEAD first when it
 * resolves, then the sorted refs with peeled lines after annotated tags; the capability list
 * rides after the NUL on the first ref line, or on the capabilities^{} pseudo-ref of an
 * empty repository. HEAD's target travels only in the symref capability.
 */
function advertiseV0(repo: Repo, service: string): Buffer {
  const caps =
    service === UPLOAD_PACK
      ? `side-band-64k thin-pack ofs-delta shallow agent=${AGENT} symref=HEAD:${repo.headRef}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const lines: string[] = [];
  const headOid = repo.headOid();
  if (headOid) lines.push(`${headOid} HEAD`);
  for (const [name, oid] of sortedRefs(repo)) {
    lines.push(`${oid} ${name}`);
    if (repo.getObject(oid)?.type === 'tag') {
      const peeled = peelToCommit(repo, oid);
      if (peeled) lines.push(`${peeled} ${name}^{}`);
    }
  }
  const parts: Buffer[] = [pktLine(`# service=${service}\n`)];
  if (lines.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    lines.forEach((line, index) => {
      parts.push(pktLine(index === 0 ? `${line}\0${caps}\n` : `${line}\n`));
    });
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The v2 advertisement (§1.3): version line, then one capability per pkt-line, then flush. */
function advertiseV2(repo: Repo): Buffer {
  void repo;
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    pktFlush(),
  ]);
}

// ---------------------------------------------------------------------------
// ls-refs (v2)
// ---------------------------------------------------------------------------

/** The argument packets of a v2 command: everything after the delim packet. */
function argumentPackets(packets: PktPacket[]): PktPacket[] {
  const delim = packets.findIndex((packet) => packet.kind === 'delim');
  return delim === -1 ? [] : packets.slice(delim + 1);
}

function handleLsRefs(ctx: SurfaceContext, repo: Repo, packets: PktPacket[]): void {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const packet of argumentPackets(packets)) {
    if (packet.kind !== 'data') continue;
    const line = pktText(packet);
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
    // Unknown arguments are accepted and ignored.
  }
  // ref-prefix filtering is server-side and exact (§1.6): a ref is listed only when its
  // name starts with at least one requested prefix.
  const matches = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));

  const lines: string[] = [];
  if (matches('HEAD')) {
    const headOid = repo.headOid();
    if (headOid) {
      lines.push(`${headOid} HEAD${symrefs ? ` symref-target:${repo.headRef}` : ''}`);
    } else if (unborn) {
      lines.push(`unborn HEAD${symrefs ? ` symref-target:${repo.headRef}` : ''}`);
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (peel && repo.getObject(oid)?.type === 'tag') {
      const peeled = peelToCommit(repo, oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    lines.push(line);
  }
  const body = Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), pktFlush()]);
  ctx.sendBytes(200, 'application/x-git-upload-pack-result', body);
}

// ---------------------------------------------------------------------------
// Fetch (v2 and the v0 fallback share the object selection)
// ---------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen?: number;
}

interface FetchPlan {
  pack: Buffer;
  boundary: string[];
  unshallow: string[];
  shallowInvolved: boolean;
}

/**
 * The closure of `tips` that does not cross the parents of the client's declared shallow
 * boundary commits (a fetch that carries shallow state but no deepen request): boundary
 * commits contribute themselves and their tree closure, never their ancestry.
 */
function boundaryCut(repo: Repo, tips: string[], boundaryCommits: ReadonlySet<string>): Set<string> {
  const included = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (included.has(oid)) continue;
    const object = repo.getObject(oid);
    if (!object) continue;
    included.add(oid);
    if (object.type === 'commit' && boundaryCommits.has(oid)) {
      stack.push(parseCommit(object.data).tree);
      continue;
    }
    for (const next of objectNeighbours(repo, oid)) {
      if (!included.has(next)) stack.push(next);
    }
  }
  return included;
}

/**
 * Select the objects a fetch delivers and the shallow boundary it reports (§1.7, §3.2, §5.4).
 * Depth counts commit generations from the wants; every delivered commit keeps its full
 * tree closure. The have closure is subtracted whole — an object the client already holds
 * is never re-sent as a plain entry.
 */
function planFetch(repo: Repo, args: FetchArgs): FetchPlan {
  const wants = args.wants.filter((oid) => OID_RE.test(oid) && repo.hasObject(oid));
  const shallowInvolved = args.deepen !== undefined || args.shallow.length > 0;

  let include: Set<string>;
  if (args.deepen !== undefined) include = repo.reachableShallow(wants, args.deepen);
  else if (args.shallow.length > 0) include = boundaryCut(repo, wants, new Set(args.shallow));
  else include = repo.reachable(wants);

  // The shallow boundary of the delivered history, computed before the have subtraction:
  // an included commit with a parent outside the set sits on the cut.
  const boundary: string[] = [];
  const unshallow: string[] = [];
  if (shallowInvolved) {
    for (const oid of include) {
      const object = repo.getObject(oid);
      if (object?.type !== 'commit') continue;
      if (parseCommit(object.data).parents.some((parent) => !include.has(parent))) {
        boundary.push(oid);
      }
    }
    const boundarySet = new Set(boundary);
    for (const oid of args.shallow) {
      const object = repo.getObject(oid);
      if (!object || object.type !== 'commit' || !include.has(oid) || boundarySet.has(oid)) continue;
      if (parseCommit(object.data).parents.every((parent) => include.has(parent))) {
        unshallow.push(oid);
      }
    }
  }

  if (args.haves.length > 0) {
    const haveIds = args.haves.filter((oid) => OID_RE.test(oid));
    // What the client actually holds: the haves' closure, but cut at its declared shallow
    // boundary — a shallow client's have does not mean it holds the boundary's ancestry,
    // and subtracting that ancestry would starve a deepen fetch of the very commits it
    // asked to deepen into (§5.4, check 17).
    const exclude =
      args.shallow.length > 0
        ? boundaryCut(repo, haveIds, new Set(args.shallow))
        : repo.reachable(haveIds);
    for (const oid of exclude) include.delete(oid);
  }

  const objects: { oid: string; type: ObjectType; data: Buffer }[] = [];
  for (const oid of include) {
    const object = repo.getObject(oid);
    if (object) objects.push({ oid, type: object.type, data: object.data });
  }
  return { pack: buildPack(objects), boundary, unshallow, shallowInvolved };
}

function handleFetchV2(ctx: SurfaceContext, repo: Repo, packets: PktPacket[]): void {
  const args: FetchArgs = { wants: [], haves: [], shallow: [] };
  for (const packet of argumentPackets(packets)) {
    if (packet.kind !== 'data') continue;
    const line = pktText(packet);
    if (line.startsWith('want ')) args.wants.push(line.slice('want '.length).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice('have '.length).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice('shallow '.length).trim());
    else if (line.startsWith('deepen ')) {
      const depth = Number.parseInt(line.slice('deepen '.length), 10);
      if (Number.isFinite(depth) && depth > 0) args.deepen = depth;
    }
    // thin-pack, no-progress, ofs-delta, done and anything else: accepted, nothing to do.
  }
  const plan = planFetch(repo, args);
  const parts: Buffer[] = [];
  if (plan.boundary.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.boundary) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktFlush());
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sideband(plan.pack));
  parts.push(pktFlush());
  ctx.sendBytes(200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

/**
 * The v0 fetch fallback (§1.8): two flush-terminated request segments (wants, then haves
 * and done), answered with a NAK line, any shallow lines, and the sideband-framed pack.
 * The checks drive fetch over v2; this path keeps a v0-only answer parseable.
 */
function handleFetchV0(ctx: SurfaceContext, repo: Repo): void {
  const args: FetchArgs = { wants: [], haves: [], shallow: [] };
  let offset = 0;
  for (let segment = 0; segment < 2 && offset < ctx.body.length; segment += 1) {
    const { packets, nextOffset } = parsePktLines(ctx.body, offset);
    offset = nextOffset;
    for (const packet of packets) {
      if (packet.kind !== 'data') continue;
      const line = pktText(packet);
      // The first want line also carries the negotiated capability list after a space.
      if (line.startsWith('want ')) args.wants.push(line.slice('want '.length).split(' ')[0]);
      else if (line.startsWith('have ')) args.haves.push(line.slice('have '.length).trim());
      else if (line.startsWith('shallow ')) args.shallow.push(line.slice('shallow '.length).trim());
      else if (line.startsWith('deepen ')) {
        const depth = Number.parseInt(line.slice('deepen '.length), 10);
        if (Number.isFinite(depth) && depth > 0) args.deepen = depth;
      }
    }
  }
  const plan = planFetch(repo, args);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of plan.boundary) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(...sideband(plan.pack));
  parts.push(pktFlush());
  ctx.sendBytes(200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

function handleUploadPack(ctx: SurfaceContext, repo: Repo): void {
  if (!wantsV2(ctx)) {
    handleFetchV0(ctx, repo);
    return;
  }
  const packets = parsePktStream(ctx.body);
  const first = packets.find((packet) => packet.kind === 'data');
  const command = first ? pktText(first) : '';
  if (command === 'command=ls-refs') {
    handleLsRefs(ctx, repo, packets);
    return;
  }
  if (command === 'command=fetch') {
    handleFetchV2(ctx, repo, packets);
    return;
  }
  throw new HttpError(400, 'unsupported upload-pack command');
}

// ---------------------------------------------------------------------------
// Receive-pack (push, v0 only)
// ---------------------------------------------------------------------------

interface RefCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/**
 * Apply one ref command against the store (its pack objects are already stored). Refusals:
 * a create over an existing ref or a stale old value (compare-and-swap, unobserved by the
 * suite but git's contract), a new tip the pack did not deliver, and — the one refusal the
 * suite asserts, with this exact reason — a non-fast-forward update.
 */
function applyRefUpdate(repo: Repo, command: RefCommand, unpackOk: boolean): string {
  const { oldOid, newOid, ref } = command;
  if (!unpackOk) return `ng ${ref} unpack failed`;
  if (!ref.startsWith('refs/')) return `ng ${ref} invalid refname`;
  const current = repo.getRef(ref) ?? ZERO_OID;
  if (current !== oldOid) {
    return `ng ${ref} ${oldOid === ZERO_OID ? 'reference already exists' : 'stale info'}`;
  }
  if (newOid === ZERO_OID) {
    repo.deleteRef(ref);
    return `ok ${ref}`;
  }
  if (!repo.hasObject(newOid)) return `ng ${ref} missing object`;
  if (oldOid !== ZERO_OID && oldOid !== newOid && !repo.isAncestor(oldOid, newOid)) {
    return `ng ${ref} non-fast-forward`;
  }
  repo.setRef(ref, newOid);
  return `ok ${ref}`;
}

function handleReceivePack(ctx: SurfaceContext, repo: Repo): void {
  // The command list is a pkt-line stream ended by a flush; the pack (when the rules below
  // call for one) is the raw bytes after it.
  const { packets, nextOffset } = parsePktLines(ctx.body, 0);
  const commands: RefCommand[] = [];
  let capabilities = new Set<string>();
  let firstLine = true;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    let text = pktText(packet);
    if (firstLine) {
      firstLine = false;
      const nul = text.indexOf('\0');
      if (nul !== -1) {
        capabilities = new Set(text.slice(nul + 1).split(' ').filter(Boolean));
        text = text.slice(0, nul);
      }
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(text);
    if (!match) throw new HttpError(400, 'malformed receive-pack command');
    commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
  }

  // Pack presence is decided by the command list, never by probing (§1.9): a pack follows
  // when any command creates or updates (even one carrying zero new objects); a delete-only
  // push has no pack bytes at all.
  const packFollows = commands.some((command) => command.newOid !== ZERO_OID);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packFollows) {
    try {
      const entries = readPack(ctx.body.subarray(nextOffset));
      for (const entry of entries) {
        repo.storeObject(entry.oid, { type: entry.type, data: entry.data });
      }
    } catch (err) {
      unpackOk = false;
      const message = err instanceof Error ? err.message : String(err);
      unpackDetail = message.replace(/[\r\n]+/g, ' ').slice(0, 120) || 'error';
      if (unpackDetail === 'ok') unpackDetail = 'error';
    }
  }

  // Each ref is applied or refused independently, and the report names each exactly once,
  // in command order, behind the unpack line.
  const reportLines = [`unpack ${unpackOk ? 'ok' : unpackDetail}`];
  for (const command of commands) {
    reportLines.push(applyRefUpdate(repo, command, unpackOk));
  }

  // The report is a pkt-line stream of its own; with side-band-64k negotiated, that
  // stream travels chunked inside band-1 packets and a plain flush ends the response.
  const reportStream = Buffer.concat([
    ...reportLines.map((line) => pktLine(`${line}\n`)),
    pktFlush(),
  ]);
  const body = capabilities.has('side-band-64k')
    ? Buffer.concat([...sideband(reportStream), pktFlush()])
    : reportStream;
  // A refused update is a successful exchange reported in-band: the status is 200 (§1.9).
  ctx.sendBytes(200, 'application/x-git-receive-pack-result', body);
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export const handleGit: SurfaceHandler = async (ctx) => {
  const viewer = ctx.requireViewer();
  const repo = ctx.forge.visibleRepo(viewer, ctx.params.owner, ctx.params.repo);
  const gitPath = ctx.params.gitPath;

  if (gitPath === '/info/refs' && ctx.method === 'GET') {
    if (!repo) throw new HttpError(404, 'Not Found');
    const service = ctx.query.get('service');
    if (service === UPLOAD_PACK) {
      const body = wantsV2(ctx) ? advertiseV2(repo) : advertiseV0(repo, UPLOAD_PACK);
      ctx.sendBytes(200, 'application/x-git-upload-pack-advertisement', body);
      return;
    }
    if (service === RECEIVE_PACK) {
      ctx.sendBytes(200, 'application/x-git-receive-pack-advertisement', advertiseV0(repo, RECEIVE_PACK));
      return;
    }
    throw new HttpError(400, 'unknown service');
  }

  if (gitPath === '/git-upload-pack' && ctx.method === 'POST') {
    if (!repo) throw new HttpError(404, 'Not Found');
    try {
      handleUploadPack(ctx, repo);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      // A malformed body must never crash the server (spec 01, check 30).
      throw new HttpError(400, 'Bad Request');
    }
    return;
  }

  if (gitPath === '/git-receive-pack' && ctx.method === 'POST') {
    if (!repo) throw new HttpError(404, 'Not Found');
    try {
      handleReceivePack(ctx, repo);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, 'Bad Request');
    }
    return;
  }

  throw new HttpError(404, 'Not Found');
};
