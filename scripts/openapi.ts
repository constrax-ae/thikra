// Builds docs/openapi.json from the routes the server REALLY registers (app.routes) plus hand-written notes (docs/api-notes.json).
// A route nobody described still appears (with a generated summary), so the contract can never silently miss an endpoint;
// a note for a route that no longer exists fails the test. Run: pnpm openapi
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface Note { summary?: string; request?: Record<string, string>; response?: Record<string, string>; query?: Record<string, string>; errors?: string[]; status?: number }
export type Notes = Record<string, Note>;

const PUBLIC = new Set(['GET /healthz', 'POST /api/auth/request', 'POST /api/auth/verify', 'POST /api/auth/pin', 'POST /api/auth/pin-forgot', 'POST /api/auth/logout', 'GET /api/app-config', 'POST /api/stripe/webhook']);

const schemaOf = (fields: Record<string, string>) => ({
  type: 'object',
  properties: Object.fromEntries(Object.entries(fields).map(([k, v]) => {
    const t = v.split(/[ (]/)[0];
    return [k, { ...( ['string', 'integer', 'number', 'boolean', 'object', 'array'].includes(t) ? { type: t } : {}), description: v }];
  })),
});

/** Routes (as `app.routes` gives them) to a deduplicated, ordered list of API operations: middleware (ALL) and the web page fallback are not endpoints. */
export function operations(routes: Array<{ method: string; path: string }>) {
  const seen = new Set<string>(), out: Array<{ method: string; path: string; key: string }> = [];
  for (const r of routes) {
    if (r.method === 'ALL' || !(r.path.startsWith('/api/') || r.path === '/healthz')) continue;
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) continue;
    seen.add(key); out.push({ method: r.method, path: r.path, key });
  }
  return out;
}

export function buildSpec(routes: Array<{ method: string; path: string }>, notes: Notes) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const { method, path, key } of operations(routes)) {
    const n = notes[key] ?? {};
    const oaPath = path.replace(/:(\w+)/g, '{$1}');
    const tag = path === '/healthz' ? 'health' : path.split('/')[2] ?? 'api';
    const admin = path.startsWith('/api/admin/');
    const op: Record<string, unknown> = {
      tags: [tag],
      summary: n.summary ?? `${method} ${path}`,
      ...(admin ? { description: 'Platform administrators only.' } : {}),
      parameters: [
        ...[...path.matchAll(/:(\w+)/g)].map(m => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } })),
        ...Object.entries(n.query ?? {}).map(([name, d]) => ({ name, in: 'query', required: false, description: d, schema: { type: 'string' } })),
      ],
      ...(PUBLIC.has(key) ? { security: [] } : {}),
      ...(n.request ? { requestBody: { required: true, content: { 'application/json': { schema: schemaOf(n.request) } } } } : {}),
      responses: {
        [String(n.status ?? 200)]: { description: 'OK', ...(n.response ? { content: { 'application/json': { schema: schemaOf(n.response) } } } : {}) },
        ...(PUBLIC.has(key) ? {} : { '401': { description: 'Not signed in', content: { 'application/json': { schema: schemaOf({ error: 'string: "unauthorized"' }) } } } }),
        ...(n.errors?.length ? { default: { description: `Error. \`error\` is one of: ${n.errors.join(', ')}`, content: { 'application/json': { schema: schemaOf({ error: 'string' }) } } } } : {}),
      },
    };
    (paths[oaPath] ??= {})[method.toLowerCase()] = op;
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Thekra API',
      version: '0.1.0',
      description: 'Generated from the routes the server registers; summaries and shapes come from docs/api-notes.json (partial: endpoints without notes only list their path and method).\n\n'
        + 'Live gateway: a WebSocket at `/ws` (same session cookie). Frames (JSON, `t` = type). Client to server: `ping`, `join {circle}`, `visible {on}`, `send {circle, body, client_msg_id, reply_to?}`, `read {circle, seq}`, `typing {circle, on}`, `sync {circle, after_seq | after_rev}`. '
        + 'Server to client: `hello {circles}`, `pong`, `ack {client_msg_id, id, seq, duplicate}`, `err {error, client_msg_id?}`, `msg`, `update`, `changed`, `receipt`, `pins`, `typing`, `sync {messages, more}`. The socket only makes things faster: every screen still works through the HTTP endpoints.',
    },
    components: { securitySchemes: { cookieAuth: { type: 'apiKey', in: 'cookie', name: 'thikra_session' } } },
    security: [{ cookieAuth: [] }],
    paths,
  };
}

// `pnpm openapi`: write docs/openapi.json
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.env.THIKRA_DB ??= ':memory:'; process.env.THIKRA_NO_LISTEN = '1';
  const { app } = await import('../server/index.ts');
  const notes = JSON.parse(readFileSync(new URL('../docs/api-notes.json', import.meta.url), 'utf8')) as Notes;
  const spec = buildSpec(app.routes, notes);
  writeFileSync(new URL('../docs/openapi.json', import.meta.url), JSON.stringify(spec, null, 1) + '\n');
  console.log(`docs/openapi.json: ${operations(app.routes).length} operations, ${Object.keys(notes).length} with notes`);
  process.exit(0);
}
