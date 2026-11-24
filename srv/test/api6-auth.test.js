const test = require('node:test');
const assert = require('node:assert/strict');

test('API6 credentials come from the environment only: Basic auth when both are set, none otherwise', async () => {
  const saved = { u: process.env.API6_USERNAME, p: process.env.API6_PASSWORD };
  try {
    delete process.env.API6_USERNAME; delete process.env.API6_PASSWORD;
    delete require.cache[require.resolve('../lib/api6')];
    let { api6, DEFAULT_BASE_URL } = require('../lib/api6');
    assert.equal(DEFAULT_BASE_URL, 'https://apimqua.tss.trelleborg.com');
    assert.equal(api6.credentialsConfigured, false);
    assert.equal(api6.authType, 'NONE');

    process.env.API6_USERNAME = 'svc-user'; process.env.API6_PASSWORD = 'pw';
    delete require.cache[require.resolve('../lib/api6')];
    ({ api6 } = require('../lib/api6'));
    assert.equal(api6.credentialsConfigured, true);
    assert.equal(api6.authType, 'BASIC');
    assert.equal(api6.baseUrl, process.env.API6_BASE_URL || DEFAULT_BASE_URL);
  } finally {
    for (const [k, v] of [['API6_USERNAME', saved.u], ['API6_PASSWORD', saved.p]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});
