/**
 * Golden test runner (ARCHITECTURE_V2 §7): for each tests/golden/<region>/*.json, prices the
 * fixture's `request` through the exact same pipeline srv uses (`pricePayload` — resolves
 * config from the seeded store, resolves facts via api6-client, runs priceItems()) and diffs
 * the result against `expected`. A mismatch fails the run — no config change ships if it
 * breaks a finance-verified number (requirements §6).
 *
 * `facts`/`config.region` in a fixture are documentation of intent, not inputs: the pipeline
 * derives region and the api6-client scenario from `request` itself, exactly as a real caller
 * would — a golden case that can't do that isn't testing the real path.
 */
const fs = require('node:fs');
const path = require('node:path');

const { store } = require('../srv/lib/store');
const { seed } = require('../srv/lib/seed');
const { pricePayload } = require('../srv/lib/pricing');

const GOLDEN_DIR = path.join(__dirname, 'golden');

function loadCases() {
  const cases = [];
  for (const region of fs.readdirSync(GOLDEN_DIR)) {
    const dir = path.join(GOLDEN_DIR, region);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      const full = path.join(dir, file);
      cases.push({ id: `${region}/${file}`, file: full, case: JSON.parse(fs.readFileSync(full, 'utf8')) });
    }
  }
  return cases.sort((a, b) => a.id.localeCompare(b.id));
}

/** Only the fields a fixture actually specifies are checked — a fixture that omits `margin`
 *  makes no claim about it. `flags` is a set of codes that must ALL be present (a fixture
 *  never has to enumerate every info-level flag to pin the ones that matter). */
function diffLine(expected, actual, path_) {
  const diffs = [];
  if (!actual) return [`${path_}: no such line in the response`];
  for (const [key, want] of Object.entries(expected)) {
    if (key === 'flags') {
      const have = (actual.flags || []).map((f) => f.code);
      const missing = want.filter((code) => !have.includes(code));
      if (missing.length) diffs.push(`${path_}.flags: missing ${JSON.stringify(missing)} (has ${JSON.stringify(have)})`);
      continue;
    }
    const got = key === 'unitPrice' || key === 'landedCost' || key === 'margin' || key === 'currency' || key === 'quantity'
      ? (actual.result ? actual.result[key] : null)
      : actual[key];
    if (JSON.stringify(got) !== JSON.stringify(want)) diffs.push(`${path_}.${key}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  }
  return diffs;
}

async function run() {
  seed(store);
  const cases = loadCases();
  if (cases.length === 0) {
    console.error(`No golden cases found under ${GOLDEN_DIR}.`);
    process.exitCode = 1;
    return;
  }

  let failed = 0;
  for (const { id, case: c } of cases) {
    try {
      const response = await pricePayload(c.request);
      const expectedItems = c.expected.items;
      const diffs = expectedItems.flatMap((exp, i) => diffLine(exp, response.items[i], `items[${i}]`));
      if (diffs.length) {
        failed++;
        console.error(`✖ ${id}${c.name ? ` — ${c.name}` : ''}`);
        for (const d of diffs) console.error(`    ${d}`);
      } else {
        console.log(`✔ ${id}`);
      }
    } catch (err) {
      failed++;
      console.error(`✖ ${id} — threw: ${err.message}`);
    }
  }

  console.log(`\n${cases.length - failed}/${cases.length} golden cases passed.`);
  if (failed > 0) process.exitCode = 1;
}

run();
