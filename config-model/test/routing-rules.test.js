const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ConfigStore } = require('../src/store');
const { MemoryBackend } = require('../src/backend');
const { validateRoutingRules, validateRoutingBooks, ConfigValidationError } = require('../src/validate');
const { HUMAN_PROVENANCE } = require('./fixtures');

function rules(overrides = {}) {
  return {
    key: '*',
    version: '2026.09.1',
    status: 'ACTIVE',
    supersedes: null,
    validFrom: '2026-09-01',
    validTo: null,
    rules: [
      { when: { family: 'O-Rings' }, type: 'PRICE_LIST', book: 'EU_SEALS' },
      { when: { family: 'PTFE bearings' }, type: 'CATALOG_FORMULA', book: 'PTFE_BEARINGS' },
    ],
    provenance: HUMAN_PROVENANCE,
    ...overrides,
  };
}

function priceList(id = 'EU_SEALS', status = 'ACTIVE') {
  return {
    id, name: id, version: '1', status, validFrom: '2026-01-01', currency: 'EUR',
    dimensions: [{ attr: 'tier', weight: 10 }], rows: [{ part: 'X', match: {}, tiers: [{ from: 0, value: '1' }] }], provenance: HUMAN_PROVENANCE,
  };
}

function catalog(id = 'PTFE_BEARINGS', status = 'ACTIVE') {
  return { id, name: id, version: '1', status, validFrom: '2026-01-01', currency: 'EUR', dsl_version: 1, rows: [{ match: { spec: '1', variant: 'a' }, rate: '1' }], provenance: HUMAN_PROVENANCE };
}

async function storeWith(...docs) {
  const store = new ConfigStore();
  await store.load(new MemoryBackend());
  for (const [kind, doc] of docs) await store.save(kind, doc);
  return store;
}

test('the engine-core routing fixture validates as a routing-rules document', () => {
  assert.equal(validateRoutingRules(rules()), true);
});

test('schema: the key is always "*", rule type is PRICE_LIST | CATALOG_FORMULA, `when` needs at least one attribute', () => {
  assert.throws(() => validateRoutingRules(rules({ key: 'EUROPE' })), ConfigValidationError);
  assert.throws(() => validateRoutingRules(rules({ rules: [{ when: { family: 'X' }, type: 'COST_PLUS', book: 'Y' }] })), ConfigValidationError);
  assert.throws(() => validateRoutingRules(rules({ rules: [{ when: {}, type: 'PRICE_LIST', book: 'Y' }] })), ConfigValidationError);
  assert.throws(() => validateRoutingRules(rules({ rules: [{ type: 'PRICE_LIST', book: 'Y' }] })), ConfigValidationError);
});

test('validateRoutingBooks names every rule whose book has no ACTIVE document of the stated type', () => {
  const exists = (kind, id) => kind === 'price-list' && id === 'EU_SEALS';
  assert.throws(() => validateRoutingBooks(rules(), exists), (err) => {
    assert.ok(err instanceof ConfigValidationError);
    assert.equal(err.details.length, 1);
    assert.match(err.details[0], /rules\[1\].*PTFE_BEARINGS.*catalog-book/);
    return true;
  });
  assert.equal(validateRoutingBooks(rules(), () => true), true);
});

test('a routing DRAFT may point at books that do not exist yet; saving it ACTIVE directly may not', async () => {
  const store = await storeWith();
  const draft = await store.save('routing-rules', rules({ status: 'DRAFT' }));
  assert.equal(draft.status, 'DRAFT');
  await assert.rejects(() => store.save('routing-rules', rules({ version: '2026.09.2' })), ConfigValidationError);
});

test('publishing routing rules runs the cross-document check: refused until every book is ACTIVE, then goes live', async () => {
  const store = await storeWith(['price-list', priceList()], ['routing-rules', rules({ status: 'DRAFT' })]);

  await assert.rejects(() => store.publish('routing-rules', '*', '2026.09.1', { publishedBy: 'bob' }), (err) => {
    assert.ok(err instanceof ConfigValidationError);
    assert.match(err.details[0], /PTFE_BEARINGS/);
    return true;
  });
  assert.equal(store.getVersion('routing-rules', '*', '2026.09.1').status, 'DRAFT', 'a refused publish leaves the draft a draft');
  assert.equal(store.getEffective('routing-rules', '*', '2026-09-10'), null);

  await store.save('catalog-book', catalog());
  const live = await store.publish('routing-rules', '*', '2026.09.1', { publishedBy: 'bob' });
  assert.equal(live.status, 'ACTIVE');
  assert.equal(store.getEffective('routing-rules', '*', '2026-09-10').version, '2026.09.1');
});

test('a book that only exists as a DRAFT does not satisfy the routing check — drafts are never used for pricing', async () => {
  const store = await storeWith(['price-list', priceList('EU_SEALS', 'DRAFT')], ['catalog-book', catalog()], ['routing-rules', rules({ status: 'DRAFT' })]);
  await assert.rejects(() => store.publish('routing-rules', '*', '2026.09.1', { publishedBy: 'bob' }), (err) => {
    assert.ok(err instanceof ConfigValidationError);
    assert.match(err.details[0], /EU_SEALS/);
    return true;
  });
});

test('the routing document key is always "*" whatever the document says', async () => {
  const store = await storeWith(['routing-rules', rules({ status: 'DRAFT' })]);
  assert.deepEqual(store.listKeys('routing-rules'), ['*']);
  assert.equal(store.listDrafts('routing-rules')[0].key, '*');
});
