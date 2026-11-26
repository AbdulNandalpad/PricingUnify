# TSS Pricing — MCP server

Lets AI agents calculate landed cost and prices, explain a calculation, resolve item attributes and search
parts, by calling the pricing REST API ([`docs/API.md`](../docs/API.md)). It holds no pricing logic.

**Read/calculate only, by design.** It exposes no tool that saves configuration or writes back to C4C
(config never changes without a human; write-back is outward-facing). Every call is authorized by the backend
against the credentials the server was given — the MCP layer never widens access.

## Tools

| Tool | Purpose |
|---|---|
| `price_items` | Price 1–200 lines → per-line landed cost, optional selling price, cost source, or a typed MISSING reason with a hint |
| `explain_price` | Price one line and return the step-by-step calculation in plain language |
| `get_item_attributes` | Preview resolved supplier / country / warehouse / stock class (no price) |
| `search_products` | Part-number type-ahead (C4C product master, else local catalog) |
| `whoami` | Which identity and roles the backend sees — call it first on a 401/403 |
| `get_region_config`, `list_suppliers` | Read-only configuration views; only with `--admin`, and the backend still requires PricingAdmin |

Resource `pricing://guide` explains regions, stock class, price unit, margin and the MISSING outcomes.
A `MISSING` line is a valid answer, not an error — agents are told to report the reason, not invent a price.

## Run

```bash
npm install                       # at the repo root (workspaces)
npm run start:srv                 # the backend, port 4004

# stdio (Claude Desktop / Claude Code / IDE agents)
TSS_PRICING_BASE_URL=http://localhost:4004 TSS_PRICING_USER=alice TSS_PRICING_PASSWORD=x \
  node mcp-server/bin/tss-pricing-mcp.js

# Streamable HTTP, stateless, POST /mcp (binds 127.0.0.1 unless --host is given)
node mcp-server/bin/tss-pricing-mcp.js --http --port 3333
```

Claude Code: `claude mcp add tss-pricing -e TSS_PRICING_BASE_URL=http://localhost:4004 -e TSS_PRICING_USER=alice -e TSS_PRICING_PASSWORD=x -- node /abs/path/mcp-server/bin/tss-pricing-mcp.js`

Claude Desktop (`claude_desktop_config.json`):

```json
{ "mcpServers": { "tss-pricing": {
    "command": "node", "args": ["/abs/path/mcp-server/bin/tss-pricing-mcp.js"],
    "env": { "TSS_PRICING_BASE_URL": "http://localhost:4004",
             "TSS_PRICING_USER": "alice", "TSS_PRICING_PASSWORD": "x" } } } }
```

## Configuration (environment only)

| Variable | Meaning |
|---|---|
| `TSS_PRICING_BASE_URL` | Backend URL (default `http://localhost:4004`). In BTP use the **srv** URL for machine clients. |
| `TSS_PRICING_TOKEN` | A bearer token (XSUAA JWT) |
| `TSS_PRICING_TOKEN_URL`, `TSS_PRICING_CLIENT_ID`, `TSS_PRICING_CLIENT_SECRET` | OAuth2 client credentials; the token is cached until shortly before expiry |
| `TSS_PRICING_USER`, `TSS_PRICING_PASSWORD` | HTTP Basic — local development with the mocked users only |
| `TSS_PRICING_TIMEOUT_MS` | Per-request timeout (default 30000) |
| `TSS_MCP_ENABLE_ADMIN=true` | Same as `--admin` |
| `TSS_MCP_HOST`, `TSS_MCP_ALLOWED_ORIGINS` | HTTP transport: bind address; comma-separated browser origins allowed (none by default) |

Secrets are never logged or echoed in errors. Do not commit them; use your secret store.

## HTTP transport and identity

In HTTP mode each caller's own `Authorization` header is forwarded to the pricing API, so every agent is
authorized as itself. Without a header the server falls back to the credentials in its environment (a shared
service identity); with neither, it answers `401`. Browser-origin requests are refused unless allow-listed.
There is no session state — scale it horizontally.

## Tests

`npm test --workspace=mcp-server` — 16 tests, run against a real spawned backend: tool listing and read-only
annotations, pricing/explain/opportunity/margin behavior pinned to the same values as the backend's own tests,
role handling (403 → clear message), unreachable API, token caching, HTTP identity pass-through.
