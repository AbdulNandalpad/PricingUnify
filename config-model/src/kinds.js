/** The config document kinds (ARCHITECTURE_V2 §3.1) and how each one is keyed. `docKey` is
 *  the string ConfigStore, the REST API and the ConfigDocuments table all agree on:
 *  region::salesOrg / supplier / ood::salesOrg / customerId / book id / "*". Kinds flagged
 *  `wildcard` fall back from `X::salesOrg` to `X::*` on effective lookups. */
const WILDCARD = '*';

const KINDS = Object.freeze({
  'region-config': { label: 'region/salesOrg', keyOf: (d) => `${d.region}::${d.salesOrg}`, wildcard: true },
  'supplier-config': { label: 'supplier', keyOf: (d) => d.supplier },
  'region-route': { label: 'ood/salesOrg', keyOf: (d) => `${d.ood}::${d.salesOrg}`, wildcard: true },
  'party-config': { label: 'customerId', keyOf: (d) => d.customerId },
  'price-list': { label: 'price list', keyOf: (d) => d.id },
  'catalog-book': { label: 'catalog book', keyOf: (d) => d.id },
  'routing-rules': { label: 'routing rules', keyOf: () => WILDCARD },
});

const KIND_NAMES = Object.freeze(Object.keys(KINDS));
const SUGGESTION_KIND = 'ai-suggestion';

function isKind(name) {
  return Object.prototype.hasOwnProperty.call(KINDS, name);
}

function docKeyOf(kind, doc) {
  if (!isKind(kind)) throw new Error(`Unknown config document kind "${kind}".`);
  return KINDS[kind].keyOf(doc);
}

/** `EUROPE::DE01` -> `EUROPE::*`; null when the key is already the wildcard or the kind has none. */
function wildcardKeyOf(kind, key) {
  if (!KINDS[kind] || !KINDS[kind].wildcard) return null;
  const sep = String(key).lastIndexOf('::');
  if (sep < 0) return null;
  const wildcard = `${key.slice(0, sep)}::${WILDCARD}`;
  return wildcard === key ? null : wildcard;
}

module.exports = { KINDS, KIND_NAMES, SUGGESTION_KIND, WILDCARD, isKind, docKeyOf, wildcardKeyOf };
