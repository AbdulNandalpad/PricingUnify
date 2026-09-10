const Decimal = require('decimal.js');
const { store } = require('./lib/store');
const { pricePayload, fetchItemAttributes, PricingRequestError } = require('./lib/pricing');
const { storePricingDocument, getPricingDocument, listPricingDocuments } = require('./lib/documents');
const { requireUserPrincipal, whoami } = require('./lib/principal');
const { normalizeKey, requireKind } = require('./lib/keys');

/** Turns the pipeline's typed request errors into clean 400/422s instead of 500s. */
async function guarded(req, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PricingRequestError) return req.reject(err.status, err.message);
    throw err;
  }
}

function lineSummary(line) {
  if (!line) return null;
  return {
    status: line.status,
    technique: line.technique,
    book: line.book || null,
    routedBy: line.routedBy,
    unitPrice: line.result ? line.result.unitPrice : null,
    landedCost: line.result ? line.result.landedCost : null,
    margin: line.result ? line.result.margin : null,
    quantity: line.result ? line.result.quantity : null,
    flags: (line.flags || []).map((f) => f.code),
    missing: line.missing || null,
  };
}

function delta(before, after) {
  if (!before || !after || before.unitPrice == null || after.unitPrice == null) return { delta: null, deltaPct: null };
  const b = new Decimal(before.unitPrice);
  const a = new Decimal(after.unitPrice);
  const d = a.minus(b);
  return { delta: d.toString(), deltaPct: b.isZero() ? null : d.div(b).toDecimalPlaces(4).toString() };
}

/** Rows of a DRAFT price list / catalog that no simulated line ever hit — likely dead. */
function deadRows(draftKind, draftDoc, afterLines) {
  if (draftKind !== 'price-list' && draftKind !== 'catalog-book') return [];
  const hit = new Set();
  for (const l of afterLines) {
    if (l.book !== draftDoc.id || !l.trace) continue;
    if (draftKind === 'price-list' && l.trace.resolution) {
      const won = l.trace.resolution.candidates.find((c) => c.won);
      if (won) hit.add(`${l.partNumber}|${JSON.stringify(won.match)}`);
    }
    if (draftKind === 'catalog-book' && Array.isArray(l.trace.checked)) {
      for (const c of l.trace.checked) if (c.ok) hit.add(c.index);
    }
  }
  return (draftDoc.rows || [])
    .map((row, index) => ({ index, row }))
    .filter(({ index, row }) => (draftKind === 'price-list' ? !hit.has(`${row.part}|${JSON.stringify(row.match || {})}`) : !hit.has(index)))
    .map(({ index, row }) => ({ index, part: row.part, match: row.match || {} }));
}

module.exports = (srv) => {
  // On behalf of user (ARCHITECTURE_V2 §4.2): no anonymous / privileged / client-credentials
  // principal ever reaches a handler. Identity below is always req.user.id.
  srv.before('*', requireUserPrincipal);

  srv.on('whoami', (req) => whoami(req.user));

  srv.on('price', (req) => guarded(req, async () => {
    const payload = req.data.payload || {};
    const response = await pricePayload(payload);
    const documentId = await storePricingDocument({ requestedBy: req.user.id, payload, response: { ...response, ...hostFields(payload) } });
    return { ...response, requestedBy: req.user.id, documentId };
  }));

  srv.on('fetchItemAttributes', (req) => guarded(req, () => fetchItemAttributes(req.data.payload || {})));

  srv.on('getPricingDocument', async (req) => {
    const { id } = req.data;
    if (!id) return req.reject(400, 'id is required.');
    const doc = await getPricingDocument(id);
    if (!doc) return req.reject(404, `No pricing document "${id}".`);
    return doc;
  });

  srv.on('listPricingDocuments', async (req) => {
    const { hostObjectId, from, to, limit } = req.data;
    return { documents: await listPricingDocuments({ hostObjectId, from, to, limit }) };
  });

  /**
   * simulate (§4.3): price the given items and/or stored documents' requests with the LIVE
   * configuration, then again with the DRAFT substituted for its live counterpart, and report
   * per-line before/after, deltas, flag changes, margin-floor crossings and dead draft rows.
   * Read-only: nothing is stored, nothing is published.
   */
  srv.on('simulate', (req) => guarded(req, async () => {
    const payload = req.data.payload || {};
    const draftRef = payload.draft;
    if (!draftRef || !draftRef.kind || !draftRef.version) return req.reject(400, 'payload.draft { kind, key, version } is required.');
    const kind = requireKind(req, draftRef.kind);
    const key = normalizeKey(kind, draftRef.key);
    const draftDoc = store.getVersion(kind, key, draftRef.version);
    if (!draftDoc) return req.reject(404, `No version "${draftRef.version}" of ${kind} "${key}".`);
    const overrides = { [`${kind}|${key}`]: draftDoc };

    const sources = [];
    if (Array.isArray(payload.items) && payload.items.length) {
      const { draft, items, documentIds, ...rest } = payload;
      sources.push({ source: 'ITEMS', payload: { ...rest, items } });
    }
    for (const id of payload.documentIds || []) {
      const doc = await getPricingDocument(id);
      if (!doc) return req.reject(404, `No pricing document "${id}".`);
      sources.push({ source: id, payload: doc.request });
    }
    if (!sources.length) return req.reject(400, 'Give payload.items and/or payload.documentIds to simulate.');

    const lines = [];
    const afterLines = [];
    for (const s of sources) {
      const live = await pricePayload(s.payload);
      const withDraft = await pricePayload(s.payload, { overrides });
      live.items.forEach((beforeLine, i) => {
        const afterLine = withDraft.items[i];
        afterLines.push(afterLine);
        const before = lineSummary(beforeLine);
        const after = lineSummary(afterLine);
        const d = delta(before, after);
        lines.push({
          source: s.source,
          partNumber: beforeLine.partNumber,
          quantity: s.payload.items[i] ? s.payload.items[i].quantity : null,
          before,
          after,
          ...d,
          flagsAdded: after.flags.filter((f) => !before.flags.includes(f)),
          flagsRemoved: before.flags.filter((f) => !after.flags.includes(f)),
          changed: JSON.stringify([before.status, before.technique, before.unitPrice]) !== JSON.stringify([after.status, after.technique, after.unitPrice]) || (d.delta != null && d.delta !== '0'),
          after_trace: afterLine.trace,
        });
      });
    }

    const floorCrossings = lines
      .filter((l) => l.flagsAdded.includes('MARGIN_FLOOR') || l.flagsRemoved.includes('MARGIN_FLOOR'))
      .map((l) => ({ source: l.source, partNumber: l.partNumber, direction: l.flagsAdded.includes('MARGIN_FLOOR') ? 'BELOW_FLOOR' : 'BACK_ABOVE_FLOOR', before: l.before.margin, after: l.after.margin }));

    return {
      draft: { kind, key, version: draftDoc.version, status: draftDoc.status },
      simulatedBy: req.user.id,
      items: lines.map(({ after_trace, ...l }) => l),
      summary: { lines: lines.length, changed: lines.filter((l) => l.changed).length, floorCrossings: floorCrossings.length },
      floorCrossings,
      deadRows: deadRows(kind, draftDoc, afterLines),
    };
  }));
};

function hostFields(payload) {
  const c = payload.context || {};
  return {
    hostSystem: payload.hostSystem || c.hostSystem || 'API',
    hostObjectType: payload.hostObjectType || c.hostObjectType || 'QUOTE',
    hostObjectId: payload.hostObjectId || c.hostObjectId || null,
  };
}
