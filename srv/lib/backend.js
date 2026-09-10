const cds = require('@sap/cds');

const { SELECT, INSERT, UPDATE } = cds.ql;
const ENTITY = 'tss.pricing.ConfigDocuments';

/**
 * StoreBackend (config-model/src/backend.js) over the CDS `ConfigDocuments` entity
 * (srv/db/schema.cds). The document itself travels as a JSON string; the envelope columns
 * (status, validFrom, validTo) are copied out so the table reads without parsing.
 * `writeMany` runs a whole publish (supersede old + activate new) in one transaction, so a
 * failure leaves the table exactly as it was — the store only updates its index afterwards.
 */
class CdsBackend {
  constructor(db = cds.db, entity = ENTITY) {
    if (!db) throw new Error('CdsBackend needs a connected cds.db.');
    this.db = db;
    this.entity = entity;
  }

  async loadAll() {
    const rows = await this.db.run(SELECT.from(this.entity));
    return rows.map(fromRow);
  }

  async append(envelope) {
    await this.db.run(INSERT.into(this.entity).entries(toRow(envelope)));
  }

  async update(envelope) {
    const affected = await this.db.run(updateQuery(this.entity, envelope));
    if (!affected) throw new Error(`CdsBackend: ${envelope.kind}|${envelope.docKey}|${envelope.version} does not exist.`);
  }

  async writeMany(ops) {
    await this.db.tx(async (tx) => {
      for (const { op, envelope } of ops) {
        if (op === 'append') {
          await tx.run(INSERT.into(this.entity).entries(toRow(envelope)));
        } else if (op === 'update') {
          const affected = await tx.run(updateQuery(this.entity, envelope));
          if (!affected) throw new Error(`CdsBackend: ${envelope.kind}|${envelope.docKey}|${envelope.version} does not exist.`);
        } else {
          throw new Error(`CdsBackend: unknown op "${op}".`);
        }
      }
    });
  }

  async isEmpty() {
    const [row] = await this.db.run(SELECT.one.from(this.entity).columns('count(*) as n'));
    return !row || Number(row.n) === 0;
  }
}

function updateQuery(entity, e) {
  return UPDATE(entity)
    .set({ status: e.status, validFrom: e.validFrom || null, validTo: e.validTo || null, doc: JSON.stringify(e.doc) })
    .where({ kind: e.kind, docKey: e.docKey, version: e.version });
}

function toRow(e) {
  return {
    kind: e.kind,
    docKey: e.docKey,
    version: e.version,
    status: e.status,
    validFrom: e.validFrom || null,
    validTo: e.validTo || null,
    doc: JSON.stringify(e.doc),
    createdBy: e.createdBy || null,
    createdAt: e.createdAt || new Date().toISOString(),
  };
}

function fromRow(r) {
  return {
    kind: r.kind,
    docKey: r.docKey,
    version: r.version,
    status: r.status,
    validFrom: r.validFrom || null,
    validTo: r.validTo || null,
    doc: typeof r.doc === 'string' ? JSON.parse(r.doc) : r.doc,
    createdBy: r.createdBy || null,
    createdAt: r.createdAt || null,
  };
}

module.exports = { CdsBackend, ENTITY };
