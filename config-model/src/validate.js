const path = require('node:path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const { validateFormula } = require('@tss-pricing/engine-core');

const SCHEMA_FILES = [
  'provenance.schema.json',
  'resolution-rule.schema.json',
  'build-up-element.schema.json',
  'constraint.schema.json',
  'region-config.schema.json',
  'ai-suggestion.schema.json',
  'supplier-config.schema.json',
  'region-route.schema.json',
  'party-config.schema.json',
  'price-list.schema.json',
  'catalog-book.schema.json',
  'routing-rules.schema.json',
];

// Mirrors engine-core/src/catalog.js DEFAULT_DIMENSIONS — the attributes a catalog book's
// margin/discount rules may match on when the book declares no dimensions of its own.
const CATALOG_DEFAULT_DIMENSIONS = ['customer', 'tier', 'region'];
const CATALOG_DEFAULT_MATCH_ON = ['spec', 'variant'];

function buildAjv() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  for (const file of SCHEMA_FILES) {
    ajv.addSchema(require(path.join('../schemas', file)));
  }
  return ajv;
}

const ajv = buildAjv();
const validators = Object.fromEntries(SCHEMA_FILES.map((f) => [f, ajv.getSchema(f)]));

class ConfigValidationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ConfigValidationError';
    this.details = details;
  }
}

/** Schema conformance is necessary but not sufficient — these are the non-negotiables
 *  (CLAUDE.md) that a JSON Schema alone can't express, enforced the same way the
 *  kernel itself enforces them, so a config can never pass validate() and then blow
 *  up at price() time for a reason validate() could have caught. */
function checkBusinessRules(config) {
  const errors = [];
  const seenIds = new Set();

  for (const el of config.buildUp || []) {
    if (seenIds.has(el.id)) errors.push(`Duplicate build-up element id "${el.id}".`);
    seenIds.add(el.id);
  }
  for (const c of config.constraints || []) {
    if (seenIds.has(c.id)) errors.push(`Duplicate id "${c.id}" reused by a constraint.`);
    seenIds.add(c.id);
  }

  (config.buildUp || []).forEach((el, index) => {
    if (el.type !== 'FACTOR') return;
    if (!Array.isArray(el.basis) || el.basis.length === 0) {
      errors.push(`FACTOR "${el.id}" has no declared basis — engine refuses to run without one.`);
      return;
    }
    const priorIds = new Set(config.buildUp.slice(0, index).map((e) => e.id));
    for (const basisId of el.basis) {
      if (!priorIds.has(basisId)) {
        errors.push(`FACTOR "${el.id}" basis references "${basisId}", which is not an earlier build-up step.`);
      }
    }
  });

  if (!(config.buildUp || []).some((el) => el.type === 'BASE')) {
    errors.push('buildUp has no BASE element — nothing to price from.');
  }

  if (config.sell && config.sell.defaultMargin !== undefined) {
    const m = Number(config.sell.defaultMargin);
    if (!Number.isFinite(m) || m < 0 || m >= 1) errors.push(`sell.defaultMargin (${config.sell.defaultMargin}) must be a fraction in [0, 1).`);
  }

  errors.push(...validityErrors(config));
  return errors;
}

function validityErrors(doc) {
  if (doc.validTo && doc.validFrom && doc.validTo <= doc.validFrom) {
    return [`validTo (${doc.validTo}) must be after validFrom (${doc.validFrom}).`];
  }
  return [];
}

function validateAgainst(schemaFile, doc) {
  const validateFn = validators[schemaFile];
  const valid = validateFn(doc);
  if (!valid) {
    throw new ConfigValidationError(`${schemaFile} validation failed`, validateFn.errors);
  }
}

function throwIfAny(label, errors) {
  if (errors.length > 0) throw new ConfigValidationError(`${label} failed business-rule validation`, errors);
}

function validateRegionConfig(config) {
  validateAgainst('region-config.schema.json', config);
  throwIfAny('RegionPricingConfig', checkBusinessRules(config));
  return true;
}

function validateAiSuggestion(suggestion) {
  validateAgainst('ai-suggestion.schema.json', suggestion);
  return true;
}

function validateSupplierConfig(config) {
  validateAgainst('supplier-config.schema.json', config);
  throwIfAny('SupplierConfig', validityErrors(config));
  return true;
}

function validateRegionRoute(route) {
  validateAgainst('region-route.schema.json', route);
  throwIfAny('RegionRoute', validityErrors(route));
  return true;
}

function validatePartyConfig(config) {
  validateAgainst('party-config.schema.json', config);
  throwIfAny('PartyConfig', validityErrors(config));
  return true;
}

// ---- price list ---------------------------------------------------------------------

function sameMatch(a, b) {
  const ka = Object.keys(a || {}).sort();
  const kb = Object.keys(b || {}).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && String(a[k]) === String(b[k]));
}

/** Two [from, to) windows overlap unless one ends before the other starts; an open end
 *  (null) runs forever. */
function validityOverlaps(a, b) {
  const aFrom = a.validFrom || '0000-00-00';
  const bFrom = b.validFrom || '0000-00-00';
  const aTo = a.validTo || '9999-99-99';
  const bTo = b.validTo || '9999-99-99';
  return aFrom <= bTo && bFrom <= aTo;
}

function undeclaredMatchKeys(match, declared) {
  return Object.keys(match || {}).filter((k) => !declared.includes(k));
}

function checkPriceListRules(book) {
  const errors = [];
  const declared = (book.dimensions || []).map((d) => d.attr);

  (book.rows || []).forEach((row, i) => {
    const bad = undeclaredMatchKeys(row.match, declared);
    if (bad.length) errors.push(`rows[${i}] (${row.part}) matches on undeclared dimension(s) ${bad.join(', ')} — declare them in dimensions or drop them.`);

    const tiers = row.tiers || [];
    if (tiers.length && Number(tiers[0].from) !== 0) errors.push(`rows[${i}] (${row.part}) tiers must start at quantity 0 (first tier starts at ${tiers[0].from}).`);
    for (let t = 1; t < tiers.length; t++) {
      if (!(Number(tiers[t].from) > Number(tiers[t - 1].from))) {
        errors.push(`rows[${i}] (${row.part}) tiers must strictly increase (tier ${t} starts at ${tiers[t].from} after ${tiers[t - 1].from}).`);
      }
    }
    errors.push(...validityErrors(row).map((e) => `rows[${i}] (${row.part}): ${e}`));

    for (let j = i + 1; j < book.rows.length; j++) {
      const other = book.rows[j];
      if (other.part === row.part && sameMatch(row.match, other.match) && validityOverlaps(row, other)) {
        errors.push(`rows[${i}] and rows[${j}] are both for ${row.part} with identical match {${Object.keys(row.match || {}).join(', ') || 'default'}} and overlapping validity — the engine could never choose between them.`);
      }
    }
  });

  (book.discount || []).forEach((rule, i) => {
    const bad = undeclaredMatchKeys(rule.match, declared);
    if (bad.length) errors.push(`discount[${i}] matches on undeclared dimension(s) ${bad.join(', ')}.`);
  });

  errors.push(...validityErrors(book));
  return errors;
}

function validatePriceList(book) {
  validateAgainst('price-list.schema.json', book);
  throwIfAny('PriceList', checkPriceListRules(book));
  return true;
}

// ---- catalog + formula --------------------------------------------------------------

function checkCatalogBookRules(book) {
  const errors = [];
  const matchOn = book.matchOn || CATALOG_DEFAULT_MATCH_ON;
  const declared = book.dimensions ? book.dimensions.map((d) => d.attr) : CATALOG_DEFAULT_DIMENSIONS;

  (book.rows || []).forEach((row, i) => {
    const missing = matchOn.filter((k) => row.match[k] === undefined);
    if (missing.length) errors.push(`rows[${i}] does not set matchOn attribute(s) ${missing.join(', ')} — it could never match a part.`);
    for (let j = i + 1; j < book.rows.length; j++) {
      const other = book.rows[j];
      if (matchOn.every((k) => String(row.match[k]) === String(other.match[k]))) {
        errors.push(`rows[${i}] and rows[${j}] are the same ${matchOn.map((k) => `${k}=${row.match[k]}`).join(', ')} — rows must be unique on matchOn.`);
      }
    }
  });

  if (book.fallbackFormula) {
    const inputNames = Object.keys(book.costInputs || {}).map((n) => `cost.${n}`);
    const check = validateFormula(book.fallbackFormula);
    if (check.error) errors.push(`fallbackFormula does not parse: ${check.error}`);
    else {
      const unknownCosts = check.variables.filter((v) => v.startsWith('cost.') && !inputNames.includes(v));
      if (unknownCosts.length) errors.push(`fallbackFormula references ${unknownCosts.join(', ')} but costInputs has no such input.`);
    }
  }

  for (const [name, input] of Object.entries(book.costInputs || {})) {
    const versions = Array.isArray(input) ? input : [input];
    versions.forEach((v, i) => errors.push(...validityErrors(v).map((e) => `costInputs.${name}[${i}]: ${e}`)));
  }

  for (const list of ['margin', 'discount']) {
    (book[list] || []).forEach((rule, i) => {
      const bad = undeclaredMatchKeys(rule.match, declared);
      if (bad.length) errors.push(`${list}[${i}] matches on undeclared dimension(s) ${bad.join(', ')}.`);
    });
  }

  for (const field of ['floor']) {
    if (book[field] !== undefined && book[field] !== null) {
      const n = Number(book[field]);
      if (!Number.isFinite(n) || n < 0 || n >= 1) errors.push(`${field} (${book[field]}) must be a fraction in [0, 1).`);
    }
  }

  errors.push(...validityErrors(book));
  return errors;
}

function validateCatalogBook(book) {
  validateAgainst('catalog-book.schema.json', book);
  throwIfAny('CatalogBook', checkCatalogBookRules(book));
  return true;
}

// ---- routing --------------------------------------------------------------------------

/** Schema + validity only. Whether every rule's `book` exists is a cross-document check the
 *  store runs at publish time (validateRoutingBooks below), since it needs the other kinds. */
function validateRoutingRules(doc) {
  validateAgainst('routing-rules.schema.json', doc);
  throwIfAny('RoutingRules', validityErrors(doc));
  return true;
}

const ROUTING_BOOK_KIND = { PRICE_LIST: 'price-list', CATALOG_FORMULA: 'catalog-book' };

/** `bookExists(kind, id)` is supplied by the store. */
function validateRoutingBooks(doc, bookExists) {
  const errors = [];
  (doc.rules || []).forEach((rule, i) => {
    const kind = ROUTING_BOOK_KIND[rule.type];
    if (!kind || !bookExists(kind, rule.book)) {
      errors.push(`rules[${i}] points at ${rule.type} book "${rule.book}", which has no ACTIVE ${kind || 'book'} document.`);
    }
  });
  throwIfAny('RoutingRules', errors);
  return true;
}

const VALIDATORS = {
  'region-config': validateRegionConfig,
  'supplier-config': validateSupplierConfig,
  'region-route': validateRegionRoute,
  'party-config': validatePartyConfig,
  'price-list': validatePriceList,
  'catalog-book': validateCatalogBook,
  'routing-rules': validateRoutingRules,
};

function validateDocument(kind, doc) {
  const fn = VALIDATORS[kind];
  if (!fn) throw new ConfigValidationError(`Unknown config document kind "${kind}".`, [`Known kinds: ${Object.keys(VALIDATORS).join(', ')}`]);
  return fn(doc);
}

module.exports = {
  validateRegionConfig,
  validateAiSuggestion,
  validateSupplierConfig,
  validateRegionRoute,
  validatePartyConfig,
  validatePriceList,
  validateCatalogBook,
  validateRoutingRules,
  validateRoutingBooks,
  validateDocument,
  VALIDATORS,
  ROUTING_BOOK_KIND,
  ConfigValidationError,
};
