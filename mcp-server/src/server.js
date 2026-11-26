'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { registerTools } = require('./tools');
const guide = require('./guide');

const NAME = 'tss-pricing';
const VERSION = require('../package.json').version;

/**
 * @param {object} deps  { getClient }  returns the pricing API client for the current call
 * @param {object} opts  { enableAdmin }
 */
function createMcpServer(deps, opts = {}) {
  const server = new McpServer(
    { name: NAME, version: VERSION },
    {
      instructions: 'Landed-cost and price calculation for Trelleborg Sealing Solutions. Read the pricing://guide resource first. MISSING lines are valid answers with a typed reason; never invent a price for them.',
    },
  );
  registerTools(server, deps, opts);
  server.registerResource(
    'guide',
    'pricing://guide',
    { title: 'Pricing engine guide', description: 'Concepts, regions, outcomes and tools of the TSS pricing engine.', mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: guide }] }),
  );
  return server;
}

module.exports = { createMcpServer, NAME, VERSION };
