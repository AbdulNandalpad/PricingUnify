# mcp-server — PricingUnify as MCP tools

An [MCP](https://modelcontextprotocol.io) server (stdio) that lets an AI agent — Claude
Desktop, Claude Code, or any MCP host — price items, explain a stored price, read the
rules in force, simulate a draft and propose a rule change, by calling `srv/`'s REST API
(`docs/ARCHITECTURE_V2.md` §4.3). It is a thin adapter: no pricing logic, no config
store, no cache. Every tool is one HTTP call.

## The one rule: on behalf of the user, always

This server **has no identity of its own**. It starts only when it is given the calling
user's credential and forwards that credential verbatim, as the `Authorization` header,
on every request. `srv` then records that user as `requestedBy` on every pricing
document and as the author of every suggestion. Nothing is ever priced or proposed "by
the MCP server" — it is always "by bob, via MCP".

Consequences you will notice:

- Without `PRICING_USER_TOKEN` or `PRICING_USER`+`PRICING_PASSWORD` the process prints
  why and exits with code 2. There is no fallback, no anonymous mode.
- A client-credentials (technical) token is refused by `srv` with `403 NO_USER_PRINCIPAL`;
  the tool result explains it in plain words instead of a stack trace.
- What the agent may do is exactly what the user may do: `PricingViewer` prices, explains
  and reads rules; `PricingAdmin` additionally proposes changes and lists suggestions.
- **No tool publishes or saves configuration.** `propose_rule_change` creates a
  `PENDING_REVIEW` suggestion; approving it (→ draft) and publishing are human actions in
  the app.

Background and the BTP token flows: `docs/ON_BEHALF_OF_USER.md`.

## Configuration

| Variable | Meaning |
|---|---|
| `PRICING_API_BASE` | Base URL of `srv`. Default `http://localhost:4004`. |
| `PRICING_USER_TOKEN` | The acting user's XSUAA JWT → `Authorization: Bearer …`. Production. |
| `PRICING_USER` + `PRICING_PASSWORD` | Local mocked auth → `Authorization: Basic …`. `alice` = PricingViewer, `bob` = PricingAdmin, any password. |

Exactly one of the two credential forms must be set; the token wins if both are.
No `npm install` beyond the repo root's — dependencies are workspace-installed.

## Run locally

```bash
node srv/server.js                                                  # terminal 1 — backend on :4004
PRICING_USER=bob PRICING_PASSWORD=x node mcp-server/src/index.js    # terminal 2 — MCP over stdio
node mcp-server/src/index.js --help
npm test --workspace=mcp-server                                     # 20 unit tests, fake fetch, no server needed
```

A quick manual check without an MCP host: pipe an `initialize` + `tools/list` JSON-RPC
pair into the process and the nine tools come back on stdout; diagnostics go to stderr
(stdout is the transport, so nothing else may write to it).

## Wire it into Claude Desktop / Claude Code

`claude_desktop_config.json` (Desktop) or `.mcp.json` / `claude mcp add-json` (Code):

```json
{
  "mcpServers": {
    "pricingunify": {
      "command": "node",
      "args": ["C:/path/to/PricingUnify/mcp-server/src/index.js"],
      "env": {
        "PRICING_API_BASE": "http://localhost:4004",
        "PRICING_USER": "bob",
        "PRICING_PASSWORD": "x"
      }
    }
  }
}
```

Against a deployed backend replace the two local variables with
`"PRICING_USER_TOKEN": "<your XSUAA user JWT>"` and set `PRICING_API_BASE` to the CF
route (or approuter). The token is yours, short-lived, and must not be shared — see
`docs/ON_BEHALF_OF_USER.md` for how to obtain one.

## Tools

| Tool | Calls | Role | What it does for the user |
|---|---|---|---|
| `whoami` | `GET /rest/pricing/whoami` | viewer | Who am I acting as, which roles. |
| `price_items` | `POST /rest/pricing/price` | viewer | Price lines (region/customer/date, per-line technique override, margin override, purpose). Stores a pricing document; returns `documentId`. |
| `explain_price` | `GET /rest/pricing/getPricingDocument?id=` | viewer | Full request + result + trace of a stored pricing document. |
| `fetch_item_attributes` | `POST /rest/pricing/fetchItemAttributes` | viewer | Master-data attributes for parts (supplier, warehouse, stock class, family/spec/variant). |
| `get_pricing_rules` | `GET /rest/config/getEffective?kind=&key=&asOf=` | viewer | The ACTIVE `region-config`, `price-list`, `catalog-book` or `routing-rules` document as of a date. |
| `list_books` | `GET /rest/config/listBooks?kind=` | viewer | Price lists or catalog books with ids. |
| `simulate_change` | `POST /rest/pricing/simulate` | viewer | LIVE vs DRAFT pricing of items and/or past documents: deltas, floor crossings, dead rows. Read-only. |
| `propose_rule_change` | `POST /rest/config/suggestChange` | admin | Plain-language instruction → `PENDING_REVIEW` AI suggestion. Never publishes. |
| `list_pending_suggestions` | `GET /rest/config/listSuggestions?status=` | admin | Suggestions awaiting review (or another status). |

Every successful result is two text blocks: a one-line human summary
("2 of 3 lines priced · 1 needs attention · document …") and the server's JSON,
pretty-printed. Every failure is `isError: true` with the server's own message.

## Layout

```
src/index.js   executable entry — env → client → McpServer → stdio; --help
src/client.js  fetch wrapper: base URL, credential → header, CAP error → readable message
src/tools.js   pure tool definitions (name, description, zod schema, handler) — testable with a fake fetch
test/          node --test
```
