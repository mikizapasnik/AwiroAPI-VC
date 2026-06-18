const { getJSON, setJSON, del } = require('../../lib/redis');
const { setCors, handleOptions, keyIncoming, keyCall, ACTIVE_CALL_TTL_SECONDS } = require('../../lib/callUtils');

module.exports = async (req, res) => {
  setCors(res);
  if (handleOptions(req, res)) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, msg: 'Method not allowed' });
  }

  const { room_id: roomId, user_id: userId, action } = req.body || {};
  if (!roomId || !userId || !['accept', 'reject'].includes(action)) {
    return res.status(400).json({ ok: false, msg: 'Brak room_id / user_id / poprawnej action' });
  }

  const call = await getJSON(keyCall(roomId));
  if (!call) {
    return res.status(404).json({ ok: false, msg: 'Połączenie nie istnieje lub wygasło' });
  }
  if (call.calleeId !== userId) {
    return res.status(403).json({ ok: false, msg: 'Tylko odbierający może odpowiedzieć na połączenie' });
  }
  if (call.status !== 'ringing') {
    return res.status(409).json({ ok: false, msg: `Połączenie ma już status: ${call.status}` });
  }

  if (action === 'accept') {
    call.status = 'active';
    call.acceptedAt = Date.now();
    await setJSON(keyCall(roomId), call, ACTIVE_CALL_TTL_SECONDS);
    await setJSON(keyIncoming(call.callerId), { roomId, status: 'active' }, ACTIVE_CALL_TTL_SECONDS);
    await setJSON(keyIncoming(call.calleeId), { roomId, status: 'active' }, ACTIVE_CALL_TTL_SECONDS);
    return res.status(200).json({ ok: true, status: 'active', roomId });
  }

  // reject
  call.status = 'rejected';
  await setJSON(keyCall(roomId), call, 30);
  await del(keyIncoming(call.callerId));
  await del(keyIncoming(call.calleeId));
  return res.status(200).json({ ok: true, status: 'rejected' });
};
