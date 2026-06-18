/**
 * Weryfikacja tokenu wystawionego przez ms (call.php / issue_call_token).
 *
 * Format tokenu: base64url(payload_json) + "." + base64url(hmac_sha256(payload, SECRET))
 * Musi być identyczny algorytm jak w ms/call.php (callTokenSign).
 *
 * Wymaga zmiennej środowiskowej MS_CALL_TOKEN_SECRET — DOKŁADNIE tej samej
 * wartości co CALL_TOKEN_SECRET w ms/call_config.php.
 */

const crypto = require('crypto');

const SECRET = process.env.MS_CALL_TOKEN_SECRET;

function b64urlToBuffer(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64');
}

function verifyCallToken(token) {
  if (!SECRET) {
    return { ok: false, msg: 'Serwer nieskonfigurowany (brak MS_CALL_TOKEN_SECRET)' };
  }
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    return { ok: false, msg: 'Brak/niepoprawny token' };
  }

  const [body, sigB64] = token.split('.');
  const expectedSig = crypto.createHmac('sha256', SECRET).update(body).digest();
  const expectedSigB64 = expectedSig.toString('base64url');

  // hash_equals-style: porównanie odporne na timing attack
  const a = Buffer.from(expectedSigB64);
  const b = Buffer.from(sigB64 || '');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, msg: 'Niepoprawny podpis' };
  }

  let payload;
  try {
    payload = JSON.parse(b64urlToBuffer(body).toString('utf8'));
  } catch {
    return { ok: false, msg: 'Uszkodzony token' };
  }

  if (!payload || !payload.caller_id || !payload.callee_id || !payload.exp) {
    return { ok: false, msg: 'Niekompletny token' };
  }
  if (Math.floor(Date.now() / 1000) > payload.exp) {
    return { ok: false, msg: 'Token wygasł' };
  }

  return { ok: true, payload };
}

module.exports = { verifyCallToken };
