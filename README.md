# TSS Pricing Engine
An AI pricing workspace — "a pricing system that never existed."
Landed cost from ERP facts (via API6) + regional configuration, all pricing types,
fully explainable, embeddable as a mashup in any CRM. Built on SAP BTP CF; portable to Postgres for SaaS.

**Start here:** `CLAUDE.md` (project memory) then `docs/PRICING_ENGINE_REQUIREMENTS.md` (binding).

## Run it

```bash
npm install
npm test                      # all workspaces: engine-core, config-model, api6-client, srv

node srv/server.js            # backend — http://localhost:4004 (mocked auth: alice/PricingViewer, bob/PricingAdmin)
npm run dev --workspace=app   # frontend — http://localhost:5173 (Direct or Backend API mode)
```

No external credentials needed — API6 runs on recorded payloads and the AI-suggestion
pipeline reports `AI_NOT_CONFIGURED` until `ANTHROPIC_API_KEY` is set.
