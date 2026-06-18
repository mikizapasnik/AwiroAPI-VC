const { verifyCallToken } = require('../../lib/verifyToken');
const { setJSON, getJSON } = require('../../lib/redis');
const { setCors, handleOptions, generateRoomId, keyIncoming, keyCall, CALL_TTL_SECONDS } = require('../../lib/callUtils');

module.exports = async (req, res) => {
  setCors(res);
  if (handleOptions(req, res)) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, msg: 'Method not allowed' });
  }

  const { token } = req.body || {};
  const verified = verifyCallToken(token);
  if (!verified.ok) {
    return res.status(401).json({ ok: false, msg: verified.msg });
  }

  const { caller_id: callerId, callee_id: calleeId } = verified.payload;

  // Czy callee już ma jakieś inne przychodzące połączenie (zajęty)?
  const existingIncoming = await getJSON(keyIncoming(calleeId));
  if (existingIncoming && existingIncoming.status === 'ringing') {
    return res.status(409).json({ ok: false, msg: 'Użytkownik jest już w innej rozmowie' });
  }

  // Czy caller już dzwoni gdzieś indziej?
  const callerAlreadyRinging = await getJSON(keyIncoming(callerId));
  if (callerAlreadyRinging && callerAlreadyRinging.status === 'ringing') {
    return res.status(409).json({ ok: false, msg: 'Masz już aktywne połączenie wychodzące' });
  }

  const roomId = generateRoomId();
  const now = Date.now();

  // Dane caller/callee (nazwa+avatar) musiały przyjść z ms już wcześniej —
  // front pobiera je razem z tokenem z issue_call_token i przekazuje tutaj,
  // żeby Vercel nie musiał odpytywać ms drugi raz.
  const { caller_profile: callerProfile, callee_profile: calleeProfile } = req.body;

  const callState = {
    roomId,
    callerId,
    calleeId,
    callerProfile: callerProfile || null,
    calleeProfile: calleeProfile || null,
    status: 'ringing',
    createdAt: now,
  };

  await setJSON(keyCall(roomId), callState, CALL_TTL_SECONDS);
  await setJSON(keyIncoming(calleeId), { roomId, status: 'ringing', from: callerId }, CALL_TTL_SECONDS);
  await setJSON(keyIncoming(callerId), { roomId, status: 'ringing', to: calleeId, outgoing: true }, CALL_TTL_SECONDS);

  return res.status(200).json({ ok: true, roomId, status: 'ringing' });
};
