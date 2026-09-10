/**
 * StoreBackend (ARCHITECTURE_V2 §3.3): the persistence seam behind ConfigStore. The store
 * keeps its in-memory index; every save/publish/discard is written through here as an
 * envelope — the row shape of srv's ConfigDocuments entity:
 *
 *   { kind, docKey, version, status, validFrom, validTo, doc, createdBy, createdAt }
 *
 *   async loadAll()          -> Envelope[]
 *   async append(envelope)   -> void        (a brand-new version)
 *   async update(envelope)   -> void        (status / window / provenance change on an existing version)
 *   async writeMany(ops)     -> void        OPTIONAL: [{ op: 'append'|'update', envelope }] applied
 *                                            atomically (publish = supersede old + activate new).
 *                                            Absent -> the store falls back to sequential calls.
 *
 * MemoryBackend is the reference implementation (tests, and the store's default when no
 * backend is loaded). srv/lib/backend.js implements the same interface over CDS.
 */
class MemoryBackend {
  constructor() {
    this.rows = new Map();
  }

  static keyOf(e) {
    return `${e.kind}|${e.docKey}|${e.version}`;
  }

  async loadAll() {
    return [...this.rows.values()].map(clone);
  }

  async append(envelope) {
    const key = MemoryBackend.keyOf(envelope);
    if (this.rows.has(key)) throw new Error(`MemoryBackend: ${key} already exists.`);
    this.rows.set(key, clone(envelope));
  }

  async update(envelope) {
    const key = MemoryBackend.keyOf(envelope);
    if (!this.rows.has(key)) throw new Error(`MemoryBackend: ${key} does not exist.`);
    this.rows.set(key, clone(envelope));
  }

  async writeMany(ops) {
    for (const { op, envelope } of ops) {
      const key = MemoryBackend.keyOf(envelope);
      if (op === 'append' && this.rows.has(key)) throw new Error(`MemoryBackend: ${key} already exists.`);
      if (op === 'update' && !this.rows.has(key)) throw new Error(`MemoryBackend: ${key} does not exist.`);
    }
    for (const { op, envelope } of ops) await this[op](envelope);
  }
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

module.exports = { MemoryBackend };
