/**
 * Deployment environment (QUA -> PROD), owner request 2026-11-26: "we are doing QUA to test, then switch to PROD
 * after successful testing — make it flexible".
 *
 * ONE switch: TSS_ENVIRONMENT (default QUA). It selects which endpoints and which credentials every outbound
 * adapter (API6 and C4C) uses, so moving to PROD is a deployment setting, not a code or config-document change.
 *
 *  - URLs (not secrets). Precedence: Connections tab (only a document saved FOR this environment) >
 *    <NAME>_<ENV> env var > <NAME> env var > the environment's built-in profile. QUA has a built-in profile;
 *    any other environment (PROD, ...) has NONE — real PROD URLs are never guessed, they come from
 *    API6_BASE_URL_PROD / C4C_URL_PROD (or the Connections tab) and are shown as "missing" until set.
 *  - Credentials. API6_USERNAME_<ENV> / API6_PASSWORD_<ENV> / C4C_USERNAME_<ENV> / C4C_PASSWORD_<ENV>. The
 *    unsuffixed variables (API6_USERNAME, ...) are honoured for QUA ONLY — a PROD run can never silently
 *    pick up QUA credentials (nor send them to the PROD gateway). Credentials are never defaulted or stored.
 */
const PROFILES = {
  QUA: {
    api6BaseUrl: 'https://apimqua.tss.trelleborg.com',
    c4cUrl: 'https://my352500.crm.ondemand.com',
    c4cUsername: 'Tss.integration',
  },
};

function name() {
  const raw = (process.env.TSS_ENVIRONMENT || 'QUA').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{0,15}$/.test(raw)) throw new Error(`TSS_ENVIRONMENT "${process.env.TSS_ENVIRONMENT}" is not a valid environment name (letters/digits, e.g. QUA or PROD).`);
  return raw;
}

function profile() { return PROFILES[name()] || {}; }

/** An env var for this environment: NAME_<ENV> first; the unsuffixed NAME only where allowed. */
function envVar(base, { allowUnsuffixed }) {
  const e = name();
  const suffixed = process.env[`${base}_${e}`];
  if (suffixed !== undefined && suffixed !== '') return suffixed;
  if (allowUnsuffixed) { const plain = process.env[base]; if (plain !== undefined && plain !== '') return plain; }
  return undefined;
}

/** URL-like (non-secret) setting: the unsuffixed variable is fine in every environment. */
const urlVar = (base) => envVar(base, { allowUnsuffixed: true });
/** Credential: the unsuffixed variable counts for QUA only. */
const secretVar = (base) => envVar(base, { allowUnsuffixed: name() === 'QUA' });

/** A connection-config document is only honoured for the environment it was saved under (a QUA URL saved in
 *  the Connections tab must never leak into PROD). Documents with no stamp predate this and are honoured. */
function honours(conn) { return !conn || !conn.environment || conn.environment === name(); }

const flag = (v, dflt) => (v === undefined || v === '' ? dflt : /^(1|true|yes|on)$/i.test(String(v).trim()));

/** Config is CODE (owner decision 2026-11-26: no database; one person maintains it): rules live in the repo
 *  (seed.js + config/*.json) and reach PROD through a deploy. Editing through the Admin screen is therefore
 *  allowed by default in QUA only (experiments; they vanish on restart — export them to keep them) and
 *  refused elsewhere. TSS_CONFIG_EDIT=true|false overrides either way. */
function configEditable() { return flag(process.env.TSS_CONFIG_EDIT, name() === 'QUA'); }

/** Demo suppliers / customers are seeded in QUA only unless TSS_SEED_DEMO=true. */
function seedDemo() { return flag(process.env.TSS_SEED_DEMO, name() === 'QUA'); }

module.exports = { name, profile, urlVar, secretVar, honours, configEditable, seedDemo, PROFILES };
