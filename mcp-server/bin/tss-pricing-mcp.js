#!/usr/bin/env node
'use strict';

/**
 *   tss-pricing-mcp                         stdio transport (Claude Desktop, Claude Code, IDE agents)
 *   tss-pricing-mcp --http [--port 3333] [--host 127.0.0.1]   Streamable HTTP at POST /mcp
 *   --admin    also expose the read-only configuration tools (needs PricingAdmin credentials)
 *
 * Configuration is environment-only — see mcp-server/README.md.
 */
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { createMcpServer } = require('../src/server');
const { clientFromEnv } = require('../src/client');
const { createHttpServer } = require('../src/http');

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const enableAdmin = flag('--admin') || process.env.TSS_MCP_ENABLE_ADMIN === 'true';

async function main() {
  if (flag('--http')) {
    const port = Number(opt('--port', process.env.PORT || 3333));
    const host = opt('--host', process.env.TSS_MCP_HOST || '127.0.0.1');
    const allowedOrigins = (process.env.TSS_MCP_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    createHttpServer({ enableAdmin, allowedOrigins }).listen(port, host, () => {
      console.error(`tss-pricing MCP (streamable HTTP) listening on http://${host}:${port}/mcp  → ${clientFromEnv().baseUrl}`);
    });
    return;
  }
  const client = clientFromEnv();
  const server = createMcpServer({ getClient: () => client }, { enableAdmin });
  await server.connect(new StdioServerTransport());
  console.error(`tss-pricing MCP (stdio) → ${client.baseUrl}`); // stderr only: stdout is the protocol channel
}

main().catch((e) => { console.error(e); process.exit(1); });
