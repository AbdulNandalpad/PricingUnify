const path = require('node:path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

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
];

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

  if (config.validTo && config.validFrom && config.validTo <= config.validFrom) {
    errors.push(`validTo (${config.validTo}) must be after validFrom (${config.validFrom}).`);
  }

  return errors;
}

function validateAgainst(schemaFile, doc) {
  const validateFn = validators[schemaFile];
  const valid = validateFn(doc);
  if (!valid) {
    throw new ConfigValidationError(`${schemaFile} validation failed`, validateFn.errors);
  }
}

function validateRegionConfig(config) {
  validateAgainst('region-config.schema.json', config);
  const businessErrors = checkBusinessRules(config);
  if (businessErrors.length > 0) {
    throw new ConfigValidationError('RegionPricingConfig failed business-rule validation', businessErrors);
  }
  return true;
}

function validateAiSuggestion(suggestion) {
  validateAgainst('ai-suggestion.schema.json', suggestion);
  return true;
}

function validateSupplierConfig(config) {
  validateAgainst('supplier-config.schema.json', config);
  if (config.validTo && config.validFrom && config.validTo <= config.validFrom) {
    throw new ConfigValidationError('SupplierConfig failed business-rule validation', [
      `validTo (${config.validTo}) must be after validFrom (${config.validFrom}).`,
    ]);
  }
  return true;
}

function checkValidToAfterValidFrom(label, config) {
  if (config.validTo && config.validFrom && config.validTo <= config.validFrom) {
    throw new ConfigValidationError(`${label} failed business-rule validation`, [
      `validTo (${config.validTo}) must be after validFrom (${config.validFrom}).`,
    ]);
  }
}

function validateRegionRoute(route) {
  validateAgainst('region-route.schema.json', route);
  checkValidToAfterValidFrom('RegionRoute', route);
  return true;
}

function validatePartyConfig(config) {
  validateAgainst('party-config.schema.json', config);
  checkValidToAfterValidFrom('PartyConfig', config);
  return true;
}

module.exports = {
  validateRegionConfig,
  validateAiSuggestion,
  validateSupplierConfig,
  validateRegionRoute,
  validatePartyConfig,
  ConfigValidationError,
};
