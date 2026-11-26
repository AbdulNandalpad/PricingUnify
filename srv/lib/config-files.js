const fs = require('node:fs');
const path = require('node:path');
const { store } = require('./store');

/**
 * Config as code (owner decision 2026-11-26: no database; one maintainer). On boot, after the built-in seed,
 * every `config/<kind>.json` file is applied to the store. A file is an array of config documents exactly as
 * `exportConfig` produces them (so the flow is: edit in QUA -> Export configuration -> save the JSON under
 * config/ -> commit -> deploy). Applying is idempotent: a (key, version) that already exists is skipped, a
 * new version supersedes the older one through the normal effective-dating rules. An invalid document stops
 * the boot with a message naming the file — a bad rule must never be silently ignored.
 */
const KINDS = {
  'region-config': { versions: (d) => store.listVersions(d.region, d.salesOrg), save: (d) => store.saveVersion(d) },
  'supplier-config': { versions: (d) => store.listSupplierConfigVersions(d.supplier), save: (d) => store.saveSupplierConfig(d) },
  'region-route': { versions: (d) => store.listRegionRouteVersions(d.ood, d.salesOrg), save: (d) => store.saveRegionRoute(d) },
  'party-config': { versions: (d) => store.listPartyConfigVersions(d.customerId), save: (d) => store.savePartyConfig(d) },
  'connection-config': { versions: () => store.listConnectionConfigVersions(), save: (d) => store.saveConnectionConfig(d) },
};

function configDir() {
  return process.env.TSS_CONFIG_DIR || path.join(__dirname, '..', '..', 'config');
}

/** Returns { applied, skipped, files } — never throws for a missing directory/file. */
function loadConfigFiles(dir = configDir()) {
  const result = { applied: 0, skipped: 0, files: [] };
  if (!fs.existsSync(dir)) return result;
  for (const kind of Object.keys(KINDS)) {
    const file = path.join(dir, `${kind}.json`);
    if (!fs.existsSync(file)) continue;
    let docs;
    try {
      docs = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`config/${kind}.json is not valid JSON: ${e.message}`);
    }
    if (!Array.isArray(docs)) throw new Error(`config/${kind}.json must be an array of documents.`);
    result.files.push(`${kind}.json`);
    // Oldest window first, so a file holding a whole history supersedes in the natural order.
    const ordered = [...docs].sort((a, b) => String(a.validFrom || '').localeCompare(String(b.validFrom || '')));
    ordered.forEach((doc, i) => {
      if (KINDS[kind].versions(doc).some((v) => v.version === doc.version)) { result.skipped += 1; return; }
      try {
        KINDS[kind].save(doc);
        result.applied += 1;
      } catch (e) {
        throw new Error(`config/${kind}.json document #${i + 1} (version "${doc.version}") was refused: ${e.message}${e.details ? ' ' + JSON.stringify(e.details) : ''}`);
      }
    });
  }
  return result;
}

module.exports = { loadConfigFiles, configDir };
