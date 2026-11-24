'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pickOriginOfData } = require('../lib/origin-of-data');

const sup = (o) => ({ partNumber: 'P1', ood: 'SMA', parentOod: 'SMA', supplierId: 'X_TUI', externalId: '113955', name: 'Tuico Products SJC', isDefault: false, ...o });
const wh = (o) => ({ partNumber: 'P1', ood: 'SMA', warehouseId: 'LG01', stockClassRaw: 'OMT', leadTime: '14', country: 'US', preferred: false, ...o });

test('a single supplier row for the line\'s Origin of Data is used even without the default flag (the real X_TUI row)', () => {
  const r = pickOriginOfData({ suppliers: [sup()], warehouses: [wh()] }, { partNumber: 'P1', ood: 'SMA' });
  assert.deepEqual(r.supplier, { id: 'X_TUI', externalId: '113955', name: 'Tuico Products SJC' });
  assert.equal(r.stockClassRaw, 'OMT');
  assert.equal(r.leadTime, '14');
  assert.equal(r.stockClassWarehouse, 'LG01');
});

test('several suppliers: exactly one DefaultSupplier wins; otherwise AMBIGUOUS — never a guess', () => {
  const two = [sup(), sup({ supplierId: 'Y', externalId: '2', isDefault: true })];
  assert.equal(pickOriginOfData({ suppliers: two, warehouses: [] }, { partNumber: 'P1', ood: 'SMA' }).supplier.id, 'Y');
  const none = [sup(), sup({ supplierId: 'Y', externalId: '2' })];
  const r = pickOriginOfData({ suppliers: none, warehouses: [] }, { partNumber: 'P1', ood: 'SMA' });
  assert.equal(r.supplier, undefined);
  assert.equal(r.supplierNote, 'AMBIGUOUS_SUPPLIER:X_TUI/Y');
});

test('only the line\'s own Origin of Data counts (leading zeros stripped, like C4C), other OODs are ignored', () => {
  const rows = { suppliers: [sup({ ood: 'CN', parentOod: 'CN', supplierId: 'CN_SUP' }), sup()], warehouses: [wh({ ood: 'CN', stockClassRaw: 'MTS' }), wh()] };
  const r = pickOriginOfData(rows, { partNumber: 'P1', ood: '000SMA' });
  assert.equal(r.supplier.id, 'X_TUI');
  assert.equal(r.stockClassRaw, 'OMT');
});

test('stock class comes from the PREFERRED warehouse of the node, whatever warehouse the line carries (as C4C does); without one, the first warehouse with a class the region knows', () => {
  const rows = { suppliers: [], warehouses: [wh({ warehouseId: 'A', stockClassRaw: 'MTS' }), wh({ warehouseId: 'B', stockClassRaw: 'OMT', preferred: true })] };
  const r = pickOriginOfData(rows, { partNumber: 'P1', ood: 'SMA', warehouse: 'A' }); // line says A, preferred is B
  assert.equal(r.stockClassRaw, 'OMT');
  assert.equal(r.stockClassWarehouse, 'B');
  const none = { suppliers: [], warehouses: [wh({ warehouseId: 'A', stockClassRaw: 'XYZ' }), wh({ warehouseId: 'B', stockClassRaw: 'MTS' })] };
  assert.equal(pickOriginOfData(none, { partNumber: 'P1', ood: 'SMA' }, { knownStockClasses: new Set(['MTS', 'MTO']) }).stockClassRaw, 'MTS'); // XYZ is not a class the map knows
  assert.equal(pickOriginOfData(none, { partNumber: 'P1', ood: 'SMA' }).stockClassRaw, 'XYZ'); // no map -> first with any class
  assert.equal(pickOriginOfData({ suppliers: [], warehouses: [wh({ stockClassRaw: 'XYZ' })] }, { partNumber: 'P1', ood: 'SMA' }, { knownStockClasses: new Set(['MTS']) }).warehouseNote, 'NO_USABLE_STOCK_CLASS');
});

test('no Origin of Data on the line, or nothing in C4C, is a typed note', () => {
  assert.equal(pickOriginOfData({ suppliers: [], warehouses: [] }, { partNumber: 'P1', ood: '' }).note, 'NO_ORIGIN_OF_DATA_ON_LINE');
  const r = pickOriginOfData({ suppliers: [], warehouses: [] }, { partNumber: 'P1', ood: 'SMA' });
  assert.equal(r.supplierNote, 'NO_SUPPLIER_IN_C4C');
  assert.equal(r.warehouseNote, 'NO_WAREHOUSE_IN_C4C');
});
