/**
 * Persistence (ARCHITECTURE_V2 §4.1). Two tables carry everything; both hold the business
 * payload as a JSON string so the CDS model never has to chase config-model's schemas, and
 * nothing here is HANA-specific — the same model deploys to SQLite, HANA and Postgres.
 */
namespace tss.pricing;

/** Every version of every rules document (region-config, supplier-config, region-route,
 *  party-config, price-list, catalog-book, routing-rules, ai-suggestion). One row per
 *  (kind, docKey, version); `status`/`validFrom`/`validTo` are copied out of `doc` so the
 *  table is readable without parsing it. Written only through config-model's ConfigStore
 *  via srv/lib/backend.js — never edited directly. */
entity ConfigDocuments {
  key kind      : String(40);
  key docKey    : String(200);
  key version   : String(80);
      status    : String(20);
      validFrom : Date;
      validTo   : Date;
      doc       : LargeString;
      createdBy : String(200);
      createdAt : Timestamp;
}

/** One row per `price` call: who asked (the token's user id, never the payload), for which
 *  host object, under which config versions, with the full request and the full result
 *  including every line's trace — the "why" behind a price that reached a customer. */
entity PricingDocuments {
  key ID             : UUID;
      requestedBy    : String(200);
      hostSystem     : String(40);
      hostObjectType : String(40);
      hostObjectId   : String(200);
      purpose        : String(20);
      region         : String(40);
      salesOrg       : String(40);
      priceDate      : Date;
      configVersions : LargeString;
      request        : LargeString;
      result         : LargeString;
      createdAt      : Timestamp;
}
