const crypto = require('crypto');

const CALL_TTL_SECONDS = 45; // ringing wygasa po 45s jeśli nikt nie odpowie
const ACTIVE_CALL_TTL_SECONDS = 3600; // aktywne połączenie - max 1h zapisu stanu

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function handleOptions(req, res) {
  if (req.method === 'OPTIONS') {
    setCors(res);
    res.status(204).end();
    return true;
  }
  return false;
}

function generateRoomId() {
  return crypto.randomBytes(16).toString('hex');
}

// ── Klucze Redis ──────────────────────────────────────────────────────────────
// incoming:{userId}     -> aktualne przychodzące połączenie dla danego usera (ringing)
// call:{roomId}         -> stan połączenia (caller/callee/status/roomId)
const keyIncoming = (userId) => `vc:incoming:${userId}`;
const keyCall = (roomId) => `vc:call:${roomId}`;

module.exports = {
  CALL_TTL_SECONDS,
  ACTIVE_CALL_TTL_SECONDS,
  setCors,
  handleOptions,
  generateRoomId,
  keyIncoming,
  keyCall,
};
