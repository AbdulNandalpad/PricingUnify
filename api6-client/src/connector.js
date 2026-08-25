const fs = require('node:fs/promises');
const path = require('node:path');
const { noAuth } = require('./auth/strategies');

/**
 * Generic outbound connector: replays a recorded JSON payload in dev/test ("recorded"
 * mode, the default — see api6-client/recorded/README.md), or makes a real authenticated
 * HTTP call in "live" mode. API6 module is a thin, named client built on top of this
 * (see index.js); any future middleware connector can reuse it as-is.
 */
function createConnector({ mode = 'recorded', baseUrl, authStrategy = noAuth(), recordedDir, fetchImpl = fetch } = {}) {
  if (mode === 'live' && !baseUrl) {
    throw new Error('createConnector: live mode requires a baseUrl.');
  }
  if (mode === 'recorded' && !recordedDir) {
    throw new Error('createConnector: recorded mode requires a recordedDir.');
  }

  async function callRecorded(scenario) {
    const file = path.join(recordedDir, `${scenario}.json`);
    let raw;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (err) {
      throw new Error(`No recorded payload for scenario "${scenario}" (expected ${file}).`, { cause: err });
    }
    return JSON.parse(raw);
  }

  async function callLive({ method = 'GET', path: reqPath, body, headers = {} }) {
    const authHeaders = await authStrategy.getHeaders();
    const res = await fetchImpl(`${baseUrl}${reqPath}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...authHeaders, ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      throw new Error(`Connector call to ${reqPath} failed: ${res.status} ${res.statusText}`);
    }
    return res.json();
  }

  return {
    mode,
    authType: authStrategy.type,
    /** `scenario` names the recorded fixture in recorded mode; `request` (method/path/body/headers) is used in live mode. */
    async call(scenario, request = {}) {
      return mode === 'recorded' ? callRecorded(scenario) : callLive(request);
    },
  };
}

module.exports = { createConnector };
