'use strict';

const http = require('node:http');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { createMcpServer } = require('./server');
const { clientFromEnv, createPricingClient } = require('./client');

const MAX_BODY = 1024 * 1024;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error('Request body too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined); } catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); } });
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/**
 * Streamable-HTTP MCP endpoint (POST /mcp), STATELESS: a fresh server per request, so it scales
 * horizontally and holds nothing between calls. Each caller's own `Authorization` header is
 * forwarded to the pricing API, which then judges them as themselves — the MCP server never
 * widens anyone's access. Without a header it falls back to credentials configured in the
 * environment (a shared service identity); with neither, the call is refused with 401.
 */
function createHttpServer({ env = process.env, enableAdmin = false, allowedOrigins = [], fetchImpl } = {}) {
  const base = clientFromEnv(env);
  const baseUrl = base.baseUrl;

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { status: 'UP' });
    if (url.pathname !== '/mcp') return send(res, 404, { error: 'Not found. The MCP endpoint is POST /mcp.' });
    if (req.method !== 'POST') return send(res, 405, { error: 'Stateless server: use POST /mcp.' }, { Allow: 'POST' });

    // DNS-rebinding / browser-origin guard: non-browser MCP clients send no Origin at all.
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.includes(origin)) return send(res, 403, { error: 'Origin not allowed.' });

    const inbound = req.headers.authorization;
    const envHasCreds = await base.hasCredentials();
    if (!inbound && !envHasCreds) {
      return send(res, 401, { error: 'Authorization required.' }, { 'WWW-Authenticate': 'Bearer' });
    }

    let body;
    try { body = await readJson(req); } catch (e) { return send(res, e.status || 400, { error: e.message }); }

    const client = inbound
      ? createPricingClient({ baseUrl, authorization: inbound, timeoutMs: env.TSS_PRICING_TIMEOUT_MS ? Number(env.TSS_PRICING_TIMEOUT_MS) : undefined, fetchImpl })
      : base;

    const server = createMcpServer({ getClient: () => client }, { enableAdmin });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) send(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  });
}

module.exports = { createHttpServer };
