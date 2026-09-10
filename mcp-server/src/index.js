#!/usr/bin/env node
'use strict';

// stdout is the MCP transport — every diagnostic goes to stderr.

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { createClient, DEFAULT_BASE_URL } = require('./client');
const { createTools } = require('./tools');
const { version } = require('../package.json');

const HELP = `pricingunify-mcp ${version} — MCP server for the PricingUnify pricing engine (stdio).

Acts strictly on behalf of one pricing user: the credential below is forwarded on every
call to srv and the server has no identity of its own. Without a credential it exits.

Environment
  PRICING_API_BASE      srv base URL (default ${DEFAULT_BASE_URL})
  PRICING_USER_TOKEN    user JWT (XSUAA) -> Authorization: Bearer   [production]
  PRICING_USER          local mocked-auth user (alice = viewer, bob = admin)
  PRICING_PASSWORD      its password (any value locally, e.g. x)  -> Authorization: Basic

Tools
  whoami, price_items, explain_price, fetch_item_attributes, get_pricing_rules,
  list_books, simulate_change, propose_rule_change, list_pending_suggestions

Local run
  PRICING_USER=bob PRICING_PASSWORD=x node mcp-server/src/index.js

Docs: mcp-server/README.md, docs/ON_BEHALF_OF_USER.md, docs/ARCHITECTURE_V2.md §5
`;

function log(line) {
  process.stderr.write(`${line}\n`);
}

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return 0;
  }

  let client;
  try {
    client = createClient();
  } catch (err) {
    log(err.message);
    return 2;
  }

  const server = new McpServer({ name: 'pricingunify', version });
  for (const tool of createTools(client)) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema }, tool.handler);
  }

  await server.connect(new StdioServerTransport());
  const who = client.authorization.startsWith('Bearer') ? 'user token' : `local user ${process.env.PRICING_USER}`;
  log(`pricingunify-mcp ${version} ready — ${client.baseUrl}, acting with ${who}`);
  return null;
}

main(process.argv.slice(2)).then((code) => {
  if (code !== null) process.exit(code);
}, (err) => {
  log(`pricingunify-mcp failed to start: ${err.stack || err.message}`);
  process.exit(1);
});
