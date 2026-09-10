const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ConfigStore } = require('../src/store');
const { MemoryBackend } = require('../src/backend');
const { ConfigValidationError } = require('../src/validate');
const { europeConfig, HUMAN_PROVENANCE } = require('./fixtures');

async function loaded(backend = new MemoryBackend()) {
  const store = new ConfigStore();
  await store.load(backend);
  return { store, backend };
}

const rowsOf = (backend) => [...backend.rows.values()];
const rowFor = (backend, version) => rowsOf(backend).find((r) => r.version === version);

test('save(DRAFT) persists through the backend but is invisible to getEffective', async () => {
  const { store, backend } = await loaded();
  const draft = await store.save('region-config', europeConfig({ status: 'DRAFT' }));
  assert.equal(draft.status, 'DRAFT');
  assert.equal(store.getEffective('region-config', 'EUROPE::*', '2026-08-15'), null);
  assert.equal(store.getEffectiveAsOf('EUROPE', '*', '2026-08-15'), null);
  assert.equal(store.listDrafts().length, 1);
  assert.deepEqual(store.listDrafts('region-config')[0], { kind: 'region-config', key: 'EUROPE::*', version: '2026.08.0', validFrom: '2026-08-01', doc: draft });
  assert.equal(rowFor(backend, '2026.08.0').status, 'DRAFT');
  assert.equal(rowFor(backend, '2026.08.0').doc.status, 'DRAFT');
});

test('publish flips DRAFT -> ACTIVE, stamps publishedBy/publishedAt, supersedes the previous ACTIVE and closes its window — atomically through the backend', async () => {
  const { store, backend } = await loaded();
  await store.save('region-config', europeConfig({ version: '2026.08.0', validFrom: '2026-08-01' }));
  await store.save('region-config', europeConfig({ version: '2026.09.0', status: 'DRAFT', validFrom: '2026-08-01' }));

  const live = await store.publish('region-config', 'EUROPE::*', '2026.09.0', { effectiveFrom: '2026-09-01', publishedBy: 'bob', note: 'September rates' });
  assert.equal(live.status, 'ACTIVE');
  assert.equal(live.validFrom, '2026-09-01', 'effectiveFrom overrides the draft validFrom');
  assert.equal(live.supersedes, '2026.08.0');
  assert.equal(live.provenance.publishedBy, 'bob');
  assert.equal(live.provenance.note, 'September rates');
  assert.ok(live.provenance.publishedAt);
  assert.equal(live.provenance.authoredBy, HUMAN_PROVENANCE.authoredBy, 'the author is kept — publisher is an extra name');

  const old = store.getVersion('region-config', 'EUROPE::*', '2026.08.0');
  assert.equal(old.status, 'SUPERSEDED');
  assert.equal(old.validTo, '2026-09-01');
  assert.equal(store.getEffective('region-config', 'EUROPE::*', '2026-08-15').version, '2026.08.0');
  assert.equal(store.getEffective('region-config', 'EUROPE::*', '2026-09-15').version, '2026.09.0');

  assert.equal(rowFor(backend, '2026.08.0').status, 'SUPERSEDED');
  assert.equal(rowFor(backend, '2026.08.0').validTo, '2026-09-01');
  assert.equal(rowFor(backend, '2026.09.0').status, 'ACTIVE');
  assert.equal(rowFor(backend, '2026.09.0').doc.provenance.publishedBy, 'bob');
});

test('publish requires a named publisher and a DRAFT; ACTIVE/SUPERSEDED/REJECTED versions cannot be published', async () => {
  const { store } = await loaded();
  await store.save('region-config', europeConfig());
  await store.save('region-config', europeConfig({ version: 'd1', status: 'DRAFT' }));
  await assert.rejects(() => store.publish('region-config', 'EUROPE::*', 'd1', {}), /publishedBy/);
  await assert.rejects(() => store.publish('region-config', 'EUROPE::*', '2026.08.0', { publishedBy: 'bob' }), /not DRAFT/);
  await assert.rejects(() => store.publish('region-config', 'EUROPE::*', 'nope', { publishedBy: 'bob' }), (err) => err instanceof ConfigValidationError && err.details.includes('NOT_FOUND'));
});

test('discard turns a DRAFT into REJECTED; it can neither be published nor discarded again, and ACTIVE versions cannot be discarded', async () => {
  const { store, backend } = await loaded();
  await store.save('region-config', europeConfig());
  await store.save('region-config', europeConfig({ version: 'd1', status: 'DRAFT' }));
  const rejected = await store.discard('region-config', 'EUROPE::*', 'd1');
  assert.equal(rejected.status, 'REJECTED');
  assert.equal(rowFor(backend, 'd1').status, 'REJECTED');
  assert.equal(store.listDrafts().length, 0);
  await assert.rejects(() => store.publish('region-config', 'EUROPE::*', 'd1', { publishedBy: 'bob' }), /REJECTED/);
  await assert.rejects(() => store.discard('region-config', 'EUROPE::*', 'd1'), /REJECTED/);
  await assert.rejects(() => store.discard('region-config', 'EUROPE::*', '2026.08.0'), /ACTIVE/);
  assert.equal(store.getEffective('region-config', 'EUROPE::*', '2026-08-15').version, '2026.08.0');
});

test('load(backend) rebuilds the index from persisted rows — a restart sees exactly what was published', async () => {
  const backend = new MemoryBackend();
  const first = await loaded(backend);
  await first.store.save('region-config', europeConfig());
  await first.store.save('region-config', europeConfig({ version: 'd1', status: 'DRAFT' }));
  await first.store.save('supplier-config', { supplier: 'ACME', version: '1', status: 'ACTIVE', validFrom: '2026-01-01', validTo: null, supplierCountry: 'DE', provenance: HUMAN_PROVENANCE });
  await first.store.publish('region-config', 'EUROPE::*', 'd1', { effectiveFrom: '2026-09-01', publishedBy: 'bob' });
  first.store.saveSuggestion({ id: 's1', targetKind: 'region-config', targetKey: 'EUROPE::*', baseVersion: 'd1', instruction: 'x', proposedPatch: [], status: 'PENDING_REVIEW', createdAt: '2026-09-01T00:00:00Z' });
  await first.store.flush();

  const second = await loaded(backend);
  assert.equal(second.store.isEmpty, false);
  assert.deepEqual(second.store.listKeys('region-config'), ['EUROPE::*']);
  assert.equal(second.store.getEffective('region-config', 'EUROPE::*', '2026-08-15').version, '2026.08.0');
  assert.equal(second.store.getEffective('region-config', 'EUROPE::*', '2026-09-15').version, 'd1');
  assert.equal(second.store.getVersion('region-config', 'EUROPE::*', '2026.08.0').status, 'SUPERSEDED');
  assert.equal(second.store.getEffectiveSupplierConfig('ACME', '2026-06-01').supplierCountry, 'DE');
  assert.equal(second.store.getSuggestion('s1').status, 'PENDING_REVIEW');
  assert.equal(second.store.listSuggestions({ targetKind: 'region-config' }, 'PENDING_REVIEW').length, 1);
});

test('a backend write failure leaves the index untouched (backend first, index second)', async () => {
  const failing = new MemoryBackend();
  failing.writeMany = async () => { throw new Error('disk on fire'); };
  const { store } = await loaded(failing);
  await assert.rejects(() => store.save('region-config', europeConfig()), /disk on fire/);
  assert.equal(store.listVersions('region-config', 'EUROPE::*').length, 0);
  assert.equal(store.isEmpty, true);
});

test('the sync legacy API writes behind; flush() surfaces the first failure', async () => {
  const failing = new MemoryBackend();
  failing.writeMany = async () => { throw new Error('late failure'); };
  const { store } = await loaded(failing);
  store.saveVersion(europeConfig());
  assert.equal(store.listVersions('EUROPE', '*').length, 1, 'sync callers see the document immediately');
  await assert.rejects(() => store.flush(), /late failure/);
});

test('suggestVersion hands out the next free YYYY-MM-DD-rN for a bucket', async () => {
  const { store } = await loaded();
  assert.equal(store.suggestVersion('region-config', 'EUROPE::*', '2026-09-10'), '2026-09-10-r1');
  await store.save('region-config', europeConfig({ version: '2026-09-10-r1', status: 'DRAFT' }));
  assert.equal(store.suggestVersion('region-config', 'EUROPE::*', '2026-09-10'), '2026-09-10-r2');
  assert.equal(store.suggestVersion('price-list', 'EU_SEALS', '2026-09-10'), '2026-09-10-r1');
});

test('every kind shares one generic API: save/getEffective/listKeys/listVersions work for price lists and parties alike', async () => {
  const { store } = await loaded();
  const list = { id: 'L1', name: 'List', version: '1', status: 'ACTIVE', validFrom: '2026-01-01', currency: 'EUR', dimensions: [], rows: [{ part: 'X', match: {}, tiers: [{ from: 0, value: '1' }] }], provenance: HUMAN_PROVENANCE };
  await store.save('price-list', list);
  await store.save('party-config', { customerId: 'C1', version: '1', status: 'ACTIVE', validFrom: '2026-01-01', tier: 'A', provenance: HUMAN_PROVENANCE });
  assert.deepEqual(store.listKeys('price-list'), ['L1']);
  assert.equal(store.getEffective('price-list', 'L1', '2026-06-01').name, 'List');
  assert.equal(store.getEffective('party-config', 'C1', '2026-06-01').tier, 'A');
  assert.equal(store.getEffectivePartyConfig('C1', '2026-06-01').tier, 'A');
  assert.equal(Object.keys(store.listEffective('price-list', '2026-06-01')).length, 1);
  assert.equal(Object.keys(store.listEffective('price-list', '2025-06-01')).length, 0);
  assert.throws(() => store.getEffective('widgets', 'x', '2026-01-01'), ConfigValidationError);
  await assert.rejects(() => store.save('price-list', list), /already exists/);
});
