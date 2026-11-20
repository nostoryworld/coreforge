// The HTTP server: one process serving four surfaces over one shared store.
//
//   GET  /healthz                    the env's boot check (spec 00, §4.3): 200 {"ok": true}
//   /{owner}/{repo}.git/...          git smart HTTP          -> git.ts
//   /api/v3/...                      REST v3                 -> rest.ts
//   /api/graphql                     GraphQL v4              -> graphql.ts
//   /mcp                             MCP (streamable HTTP)   -> mcp.ts
//   anything else                    404 {"message": "Not Found"}
//
// app.ts owns the cross-cutting discipline and nothing else: it reads and caps the request
// body, extracts the Bearer token and resolves it to the viewer through the store, stamps
// every JSON reply with X-GitHub-Request-Id (spec 00, §5.3), and turns any error a surface
// throws into the JSON error shape {"message": ...} — an HttpError keeps its status, anything
// else is a 500. Surfaces own their own statuses and bodies from there.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { Forge, type User } from './store.ts';
import { handleGit } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** Bodies are small in this contest (the largest push is a few hundred KB); the cap is sanity. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** An error a surface throws to answer with a status and GitHub's JSON error shape. */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Everything a surface handler needs, and the only way it answers. `viewer` is the user the
 * request's Bearer token names, or null when the request carries no usable token — surfaces
 * that require auth call requireViewer() (401) and read foreign repos as not found (404).
 */
export interface SurfaceContext {
  readonly forge: Forge;
  readonly viewer: User | null;
  readonly token: string;
  readonly method: string;
  /** The request path, no query string. */
  readonly path: string;
  readonly query: URLSearchParams;
  /** Route parameters: owner/repo/gitPath for git routes; the REST surface fills its own. */
  readonly params: Record<string, string>;
  /** The whole request body (empty for requests that carry none). */
  readonly body: Buffer;
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  /** Parse the body as JSON; throws HttpError(400) when it is not a JSON value. */
  jsonBody(): unknown;
  /** The viewer, or throw HttpError(401, "Requires authentication"). */
  requireViewer(): User;
  /** Answer with a JSON body and the request-id header. */
  sendJson(status: number, body: unknown, headers?: Readonly<Record<string, string>>): void;
  /** Answer with raw bytes (git pack streams, advertisements). */
  sendBytes(status: number, contentType: string, data: Buffer, headers?: Readonly<Record<string, string>>): void;
}

export type SurfaceHandler = (ctx: SurfaceContext) => Promise<void> | void;

let requestCounter = 0;

/** A non-empty, unique X-GitHub-Request-Id value. */
function nextRequestId(): string {
  requestCounter += 1;
  return `${requestCounter.toString(36)}-${randomBytes(6).toString('hex')}`;
}

/** Answer one request with a JSON body; the request-id header rides on every JSON reply. */
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  if (res.writableEnded) return;
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendBytes(
  res: ServerResponse,
  status: number,
  contentType: string,
  data: Buffer,
  headers: Readonly<Record<string, string>> = {},
): void {
  if (res.writableEnded) return;
  res.writeHead(status, { 'content-type': contentType, 'content-length': data.length, ...headers });
  res.end(data);
}

/** Read a whole request body under the sanity cap; rejects with HttpError(413) past it. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) reject(new HttpError(413, 'Request Entity Too Large'));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', () => reject(new HttpError(400, 'Bad Request')));
  });
}

/** The Bearer token of a request, or '' when the header is absent or not Bearer. */
function bearerToken(req: IncomingMessage): string {
  const header = req.headers.authorization;
  if (!header) return '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : '';
}

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/;

/** Build the server. It binds nothing until the caller listens (main.ts binds port 0). */
export function createApp(): Server {
  const forge = new Forge();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        // The env's boot check calls this twice, unauthenticated: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const token = bearerToken(req);
        const body = method === 'POST' || method === 'PUT' || method === 'PATCH' ? await readBody(req) : Buffer.alloc(0);
        const params: Record<string, string> = {};
        const ctx: SurfaceContext = {
          forge,
          viewer: forge.viewerForToken(token),
          token,
          method,
          path,
          query: url.searchParams,
          params,
          body,
          req,
          res,
          jsonBody(): unknown {
            try {
              return JSON.parse(body.toString('utf8'));
            } catch {
              throw new HttpError(400, 'Problems parsing JSON');
            }
          },
          requireViewer(): User {
            if (!this.viewer) throw new HttpError(401, 'Requires authentication');
            return this.viewer;
          },
          sendJson: (status, replyBody, headers) => sendJson(res, status, replyBody, headers),
          sendBytes: (status, contentType, data, headers) => sendBytes(res, status, contentType, data, headers),
        };

        if (path === '/mcp') {
          await handleMcp(ctx);
          return;
        }
        if (path === '/api/graphql') {
          await handleGraphql(ctx);
          return;
        }
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          await handleRest(ctx);
          return;
        }
        const gitMatch = GIT_PATH.exec(path);
        if (gitMatch) {
          params.owner = gitMatch[1];
          params.repo = gitMatch[2];
          params.gitPath = gitMatch[3] ?? '';
          await handleGit(ctx);
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        if (res.writableEnded) return;
        if (err instanceof HttpError) {
          sendJson(res, err.status, { message: err.message });
        } else {
          process.stderr.write(`[entry] unhandled error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
          sendJson(res, 500, { message: 'Internal Server Error' });
        }
      }
    })();
  });
}
