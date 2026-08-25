const { price } = require('@tss-pricing/engine-core');
const { store } = require('./lib/store');
const { api6 } = require('./lib/api6');

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

module.exports = (srv) => {
  srv.on('price', async (req) => {
    const payload = req.data.payload || {};
    const { region, salesOrg = '*', purpose = 'INDICATIVE', items, instructions, hostSystem, hostObjectType, hostObjectId, customerId } = payload;
    const priceDate = payload.priceDate || todayIso();

    if (!region) return req.reject(400, 'payload.region is required.');
    if (!Array.isArray(items) || items.length === 0) return req.reject(400, 'payload.items must be a non-empty array.');

    const config = store.getEffectiveAsOf(region, salesOrg, priceDate);
    if (!config) {
      return req.reject(422, `No effective config for region "${region}" / salesOrg "${salesOrg}" as of ${priceDate}.`);
    }

    const facts = await api6.getPricingFacts({ region, salesOrg, items });

    const request = {
      context: { hostSystem: hostSystem || 'API', hostObjectType: hostObjectType || 'QUOTE', hostObjectId, purpose },
      party: { customerId, salesOrg },
      items,
      priceDate,
      instructions,
    };

    const result = price({ request, facts, config });

    return {
      config: { region: config.region, salesOrg: config.salesOrg, version: config.version, status: config.status },
      priceDate,
      requestedBy: req.user.id,
      ...result,
    };
  });
};
