'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pickOriginOfData, stockClassFromPicked, warehouseFromPicked } = require('../lib/origin-of-data');

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

test('a strategy group blocks the plain StockClass: the real Z8 part (StockClass MTS, but the BI service sent MTO) stays unresolved, never silently MTS', () => {
  const rows = { suppliers: [], warehouses: [wh({ stockClassRaw: 'MTS', strategyCode: 'Z8', strategyDesc: 'MTS-Z & QuickSeal' })] };
  const picked = pickOriginOfData(rows, { partNumber: 'P1', ood: 'SMA' });
  assert.equal(picked.strategyGroupCode, 'Z8');
  const sc = stockClassFromPicked(picked, { MTS: 'MTS', MTO: 'NonMTS' });
  assert.equal(sc.stockClass, undefined);
  assert.equal(sc.note, 'STRATEGY_GROUP_RULE_PENDING:Z8 (MTS-Z & QuickSeal)');
});

test('without a strategy group the stock class resolves through the region map, with typed notes otherwise', () => {
  assert.deepEqual(stockClassFromPicked({ stockClassRaw: 'OMT' }, { OMT: 'NonMTS' }), { stockClass: 'NonMTS' });
  assert.deepEqual(stockClassFromPicked({ stockClassRaw: 'ZZZ' }, { OMT: 'NonMTS' }), { note: 'UNMAPPED:ZZZ' });
  assert.deepEqual(stockClassFromPicked({ stockClassRaw: 'OMT' }, null), { note: 'NO_STOCK_CLASS_MAP_FOR_REGION' });
  assert.deepEqual(stockClassFromPicked({}, { OMT: 'NonMTS' }), {});
});

test('region stockClassRules (owner rule): origin SAP + strategy Z4 = MTS, SAP + anything else NonMTS — only SAP-sourced parts, and only when a warehouse record exists', () => {
  const rules = { rules: [{ ood: 'SAP', strategyCode: 'Z4', stockClass: 'MTS' }], default: 'NonMTS' };
  const picked = (code, extra = {}) => ({ stockClassWarehouse: '1020', stockClassRaw: 'MTS', strategyGroupCode: code, ...extra });
  const sc = (p, ood = 'SAP') => stockClassFromPicked(p, { MTS: 'MTS' }, { rules, ood });

  assert.deepEqual(sc(picked('Z4')), { stockClass: 'MTS', stockClassBy: 'RULE:SAP/Z4' });
  // the real part: StockClass MTS but strategy Z8 -> NonMTS (C4C sent MTO)
  assert.deepEqual(sc(picked('Z8')), { stockClass: 'NonMTS', stockClassBy: 'RULE:DEFAULT' });
  assert.equal(sc(picked('Z3')).stockClass, 'NonMTS');
  assert.equal(sc(picked('Z7')).stockClass, 'NonMTS');
  assert.equal(sc(picked('')).stockClass, 'NonMTS'); // no strategy group -> the else branch
  // the golden rule is about SAP-sourced parts only: a part from another origin is NOT touched by it
  // (its strategy group keeps the typed pending note instead of becoming the default NonMTS)
  assert.equal(sc(picked('Z4'), 'CN').stockClass, undefined);
  assert.equal(sc(picked('Z4'), 'CN').note, 'STRATEGY_GROUP_RULE_PENDING:Z4');
  assert.equal(sc({ stockClassWarehouse: '1', stockClassRaw: 'MTS' }, 'IN').stockClass, 'MTS'); // no strategy group -> raw class via the region map
  assert.equal(sc(picked('Z4'), '000SAP').stockClass, 'MTS'); // leading zeros stripped like C4C
  assert.deepEqual(sc({ strategyGroupCode: 'Z4' }), {}); // no warehouse record -> nothing to classify, never the default
});

test('warehouse (owner rule): the part\'s PREFERRED warehouse, otherwise the configured default — never invented', () => {
  const two = { suppliers: [], warehouses: [wh({ warehouseId: '1020' }), wh({ warehouseId: '1030', preferred: true })] };
  assert.equal(pickOriginOfData(two, { partNumber: 'P1', ood: 'SAP' }).preferredWarehouse, undefined); // rows are SMA in this fixture
  const sap = { suppliers: [], warehouses: [wh({ ood: 'SAP', warehouseId: '1020' }), wh({ ood: 'SAP', warehouseId: '1030', preferred: true })] };
  const picked = pickOriginOfData(sap, { partNumber: 'P1', ood: 'SAP' });
  assert.equal(picked.preferredWarehouse, '1030');
  assert.deepEqual(warehouseFromPicked(picked, '1020'), { warehouse: '1030', warehouseBy: 'PREFERRED' });

  // the real part: warehouses 1020 and 1030, NONE preferred -> the default 1020
  const none = { suppliers: [], warehouses: [wh({ ood: 'SAP', warehouseId: '1020' }), wh({ ood: 'SAP', warehouseId: '1030' })] };
  assert.deepEqual(warehouseFromPicked(pickOriginOfData(none, { partNumber: 'P1', ood: 'SAP' }), '1020'), { warehouse: '1020', warehouseBy: 'DEFAULT' });
  // no preferred and no default configured -> nothing, not a guess
  assert.deepEqual(warehouseFromPicked({}, null), {});
});

test('the owner\'s real SMA part (ORAR00125-N7H07): warehouses CN01 (not preferred) and LG01 (preferred, strategy group 2) -> LG01 by PREFERRED; with none preferred the SMA default LG01 / CN CNSHS1 / IN LCI applies', () => {
  const sma = { suppliers: [], warehouses: [
    wh({ ood: 'SMA', warehouseId: 'CN01', preferred: false, stockClassRaw: 'MTS' }),
    wh({ ood: 'SMA', warehouseId: 'LG01', preferred: true, stockClassRaw: 'MTS', strategyCode: '2', strategyDesc: 'MTS2' }),
  ] };
  const picked = pickOriginOfData(sma, { partNumber: 'P1', ood: 'SMA' });
  assert.deepEqual(warehouseFromPicked(picked, 'LG01'), { warehouse: 'LG01', warehouseBy: 'PREFERRED' });
  const nonePreferred = { suppliers: [], warehouses: [wh({ ood: 'CN', warehouseId: 'X1' }), wh({ ood: 'CN', warehouseId: 'X2' })] };
  assert.deepEqual(warehouseFromPicked(pickOriginOfData(nonePreferred, { partNumber: 'P1', ood: 'CN' }), 'CNSHS1'), { warehouse: 'CNSHS1', warehouseBy: 'DEFAULT' });
});
