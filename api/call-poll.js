const { getJSON } = require('../../lib/redis');
const { setCors, handleOptions, keyIncoming, keyCall } = require('../../lib/callUtils');

module.exports = async (req, res) => {
  setCors(res);
  if (handleOptions(req, res)) return;

  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, msg: 'Method not allowed' });
  }

  const userId = req.query.user_id;
  if (!userId) {
    return res.status(400).json({ ok: false, msg: 'Brak user_id' });
  }

  const incoming = await getJSON(keyIncoming(userId));
  if (!incoming) {
    return res.status(200).json({ ok: true, state: 'idle' });
  }

  const call = await getJSON(keyCall(incoming.roomId));
  if (!call) {
    return res.status(200).json({ ok: true, state: 'idle' });
  }

  // Czy ten user jest caller czy callee w tym połączeniu — zwracamy dane drugiej strony
  const isCaller = call.callerId === userId;
  const peerProfile = isCaller ? call.calleeProfile : call.callerProfile;

  return res.status(200).json({
    ok: true,
    state: call.status, // 'ringing' | 'active' | 'rejected'
    roomId: call.roomId,
    isCaller,
    peer: peerProfile,
  });
};
