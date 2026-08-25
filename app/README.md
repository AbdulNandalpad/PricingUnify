# React mashup UI

**Right now:** a standalone dev console (this Vite app) that imports `@tss-pricing/engine-core`
directly and calls `price()` in the browser — no CAP service, no DB, no API6. It exists purely
to see the kernel's build-up and trace working end-to-end while engine-core is being built.
Region config and facts are a synthetic Europe-shaped sample (`src/sampleData.js`), not real
TSS data.

**Phase 3 (later):** the same React app becomes the C4C-embeddable mashup — reads context from
the host object, calls the real CAP pricing API (`srv/`) backed by config-model + API6, and
writes prices back. Framework-neutral by design (not Fiori/UI5) so the same code embeds in
Salesforce/Dynamics later.

## Run it

```bash
npm install   # from repo root — npm workspaces link @tss-pricing/engine-core in
npm run dev --workspace=app
```
