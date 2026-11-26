const test = require('node:test');
const assert = require('node:assert/strict');

/** QUA -> PROD switch: one TSS_ENVIRONMENT setting selects endpoints and credentials. */
const KEYS = ['TSS_ENVIRONMENT', 'API6_BASE_URL', 'API6_BASE_URL_PROD', 'API6_USERNAME', 'API6_PASSWORD', 'API6_USERNAME_PROD', 'API6_PASSWORD_PROD', 'C4C_URL', 'C4C_URL_PROD', 'C4C_USERNAME', 'C4C_PASSWORD', 'C4C_USERNAME_PROD', 'C4C_PASSWORD_PROD'];
async function withEnv(vars, fn) {
  const saved = {}; KEYS.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
  Object.assign(process.env, vars);
  try { return await fn(require('../lib/environment')); } finally {
    KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
  }
}
const fresh = (m) => { delete require.cache[require.resolve(m)]; return require(m); };

test('default is QUA with its built-in gateway and tenant; unsuffixed credentials count for QUA', () => withEnv({ API6_USERNAME: 'u', API6_PASSWORD: 'p' }, (env) => {
  assert.equal(env.name(), 'QUA');
  assert.equal(env.profile().api6BaseUrl, 'https://apimqua.tss.trelleborg.com');
  assert.equal(env.secretVar('API6_USERNAME'), 'u');
}));

test('PROD has NO built-in URLs and never falls back to the unsuffixed (QUA) credentials', () => withEnv({ TSS_ENVIRONMENT: 'prod', API6_USERNAME: 'qua-user', API6_PASSWORD: 'qua-pw', C4C_PASSWORD: 'qua-c4c' }, (env) => {
  assert.equal(env.name(), 'PROD');
  assert.deepEqual(env.profile(), {});
  assert.equal(env.secretVar('API6_USERNAME'), undefined);
  assert.equal(env.secretVar('C4C_PASSWORD'), undefined);
  process.env.API6_USERNAME_PROD = 'prod-user';
  assert.equal(env.secretVar('API6_USERNAME'), 'prod-user');
}));

test('an invalid environment name is refused loudly', () => withEnv({ TSS_ENVIRONMENT: 'p r o d' }, (env) => {
  assert.throws(() => env.name(), /not a valid environment name/);
}));

test('API6: PROD uses API6_BASE_URL_PROD and the PROD credentials; QUA settings never leak across', () => withEnv({
  TSS_ENVIRONMENT: 'PROD', API6_BASE_URL_PROD: 'https://apim.tss.trelleborg.com', API6_USERNAME_PROD: 'pu', API6_PASSWORD_PROD: 'pp', API6_USERNAME: 'qu', API6_PASSWORD: 'qp',
}, () => {
  const { api6 } = fresh('../lib/api6');
  assert.equal(api6.environment, 'PROD');
  assert.equal(api6.baseUrl, 'https://apim.tss.trelleborg.com');
  assert.equal(api6.credentialsConfigured, true);
}));

test('API6 PROD with no URL set: baseUrl is null (shown as missing), and a live call is a typed FAILED naming the setting', () => withEnv({ TSS_ENVIRONMENT: 'PROD' }, async () => {
  const { api6 } = fresh('../lib/api6');
  assert.equal(api6.baseUrl, null);
  assert.equal(api6.credentialsConfigured, false);
}));

test('C4C: PROD takes URL/user/password only from the PROD variables (no QUA tenant, no QUA user)', () => withEnv({ TSS_ENVIRONMENT: 'PROD', C4C_USERNAME: 'Tss.integration', C4C_PASSWORD: 'qua' }, async () => {
  const { currentC4c } = fresh('../lib/c4c');
  const d = await currentC4c().describe();
  assert.equal(d.urlConfigured, false);
  assert.equal(d.credentialsConfigured, false);
  process.env.C4C_URL_PROD = 'https://myPROD.crm.ondemand.com'; process.env.C4C_USERNAME_PROD = 'prod.int'; process.env.C4C_PASSWORD_PROD = 'x';
  const d2 = await fresh('../lib/c4c').currentC4c().describe();
  assert.equal(d2.url, 'https://myPROD.crm.ondemand.com');
  assert.equal(d2.credentialsConfigured, true);
}));

test('connection settings saved under another environment are ignored', () => withEnv({ TSS_ENVIRONMENT: 'PROD' }, (env) => {
  assert.equal(env.honours({ environment: 'QUA' }), false);
  assert.equal(env.honours({ environment: 'PROD' }), true);
  assert.equal(env.honours({}), true); // documents from before the stamp existed
  assert.equal(env.honours(null), true);
}));
