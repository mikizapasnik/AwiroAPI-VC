const { getJSON, setJSON, del } = require('../../lib/redis');
const { setCors, handleOptions, keyIncoming, keyCall } = require('../../lib/callUtils');

module.exports = async (req, res) => {
  setCors(res);
  if (handleOptions(req, res)) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, msg: 'Method not allowed' });
  }

  const { room_id: roomId, user_id: userId } = req.body || {};
  if (!roomId || !userId) {
    return res.status(400).json({ ok: false, msg: 'Brak room_id / user_id' });
  }

  const call = await getJSON(keyCall(roomId));
  if (!call) {
    return res.status(200).json({ ok: true, msg: 'Już zakończone' });
  }
  if (call.callerId !== userId && call.calleeId !== userId) {
    return res.status(403).json({ ok: false, msg: 'Nie jesteś uczestnikiem tego połączenia' });
  }

  call.status = 'ended';
  await setJSON(keyCall(roomId), call, 30);
  await del(keyIncoming(call.callerId));
  await del(keyIncoming(call.calleeId));

  return res.status(200).json({ ok: true, status: 'ended' });
};
