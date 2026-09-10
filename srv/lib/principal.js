const CLIENT_GRANTS = new Set(['client_credentials', 'client_x509']);

/**
 * On behalf of user (ARCHITECTURE_V2 §4.2, docs/ON_BEHALF_OF_USER.md): every request must
 * carry a real, named user. Returns null when the principal is acceptable, otherwise a
 * short reason. What is checked, and why each check exists:
 *
 *  - no user / `_is_anonymous`      — nobody authenticated (normally already a 401 upstream).
 *  - `_is_privileged`               — cds.User.Privileged bypasses every role check; it must
 *                                     never reach a business endpoint inside a request.
 *  - empty / non-string `id`        — nothing to record as requestedBy / publishedBy.
 *  - id `system` or role system-user — this is exactly how @sap/cds's JWT auth represents an
 *                                     XSUAA/IAS client-credentials token (no user_name →
 *                                     id 'system', roles { 'system-user' }); locally the
 *                                     mocked user `system` mirrors that shape for the tests.
 *  - token payload inspection       — defensive second look at the raw token when present:
 *                                     grant_type client_credentials/client_x509, or an XSUAA
 *                                     token with no user_name at all.
 * Nothing in a payload can influence any of this — identity comes from the token only.
 */
function principalProblem(user) {
  if (!user || user._is_anonymous || user.id === 'anonymous') return 'the request carries no authenticated user';
  if (user._is_privileged) return 'a privileged (technical) principal may not call business endpoints';
  if (typeof user.id !== 'string' || user.id.trim() === '') return 'the principal has no user id';
  const roles = user.roles || {};
  if (user.id === 'system' || roles['system-user'] || (typeof user.is === 'function' && !user._is_privileged && user.is('system-user'))) {
    return 'the token is a client-credentials grant without a user (system-user)';
  }
  const payload = tokenPayload(user);
  if (payload) {
    if (CLIENT_GRANTS.has(payload.grant_type)) return `the token was issued by grant_type=${payload.grant_type} — no user behind it`;
    if (payload.scope && !payload.user_name && !payload.sub) return 'the token names no user (no user_name / sub claim)';
  }
  return null;
}

/** @sap/cds stores the xssec security context on user.authInfo; xssec v4 exposes the token
 *  as `authInfo.token` with `getPayload()`. Older shapes had `getTokenInfo().getPayload()`.
 *  Everything optional — mocked/basic auth has none of it. */
function tokenPayload(user) {
  const info = user.authInfo;
  if (!info) return null;
  try {
    const token = info.token || (typeof info.getTokenInfo === 'function' ? info.getTokenInfo() : null);
    if (token && typeof token.getPayload === 'function') return token.getPayload();
  } catch {
    return null;
  }
  return null;
}

/** `srv.before('*', requireUserPrincipal)` on every service. */
function requireUserPrincipal(req) {
  const problem = principalProblem(req.user);
  if (!problem) return;
  req.reject({
    status: 403,
    code: 'NO_USER_PRINCIPAL',
    message: `NO_USER_PRINCIPAL: ${problem}. This API acts on behalf of a named user only — supply a user token (or a mocked user locally), never a client-credentials token.`,
  });
}

function whoami(user) {
  return {
    id: user.id,
    roles: Object.keys(user.roles || {}).filter((r) => user.roles[r]),
    attr: user.attr && Object.keys(user.attr).length ? user.attr : undefined,
  };
}

module.exports = { principalProblem, requireUserPrincipal, whoami };
