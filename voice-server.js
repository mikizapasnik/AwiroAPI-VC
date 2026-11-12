/**
 * voice-server.js
 * ────────────────────────────────────────────────────────────────────────
 * Jeden plik = cały serwer głosowy dla kanałów voice w "ms" (Awiro).
 * Zastępuje poprzedni układ (PHP signaling + Upstash/Vercel Redis + Render
 * relay) — bo tamten podział był potrzebny TYLKO dlatego, że funkcje
 * serverless (Vercel) są bezstanowe i musiały trzymać stan pokoi w
 * zewnętrznym Redisie. Na AWS (EC2 / Lightsail — czyli zwykły, cały czas
 * działający proces) stan pokoi trzymamy po prostu w pamięci (Map),
 * więc Redis odpada, PHP-signaling odpada — zostaje jeden proces Node.
 *
 * Co robi:
 *   - WebSocket signaling dla WebRTC (mesh: każdy z każdym w kanale)
 *   - Zarządzanie pokojami = kanałami głosowymi serwerów w "ms"
 *   - Broadcast join/leave/mute do wszystkich w pokoju
 *   - Health-check pod AWS (ALB / target group / po prostu curl)
 *   - Heartbeat (ping/pong), żeby martwe połączenia nie wisiały w pokoju
 *
 * Zależności: TYLKO pakiet "ws" (WebRTC audio leci peer-to-peer,
 * przez ten serwer idzie wyłącznie signaling — więc nie potrzebujesz
 * żadnego serwera TURN/relay do samego dźwięku, chyba że ktoś siedzi
 * za NAT-em symetrycznym; patrz sekcja TURN na końcu pliku).
 *
 * ── INSTALACJA NA AWS (EC2, Amazon Linux / Ubuntu) ──────────────────────
 *   1) sudo yum install -y nodejs   # lub: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash - && sudo apt install -y nodejs
 *   2) mkdir voice && cd voice && cp voice-server.js .
 *   3) npm init -y && npm install ws
 *   4) npm install -g pm2
 *   5) PORT=8443 pm2 start voice-server.js --name vc-relay
 *   6) pm2 save && pm2 startup   # żeby wstawał po restarcie instancji
 *   7) W Security Group otwórz port (np. 8443) dla TCP z 0.0.0.0/0
 *      (albo lepiej: postaw Nginx/ALB z TLS na 443 i przekieruj na 127.0.0.1:8443 -
 *       przeglądarki wymagają wss:// jeśli strona ms jest na https://)
 *
 * ── PRZYKŁAD Nginx reverse-proxy (TLS terminacja) ───────────────────────
 *   location /voice/ {
 *       proxy_pass http://127.0.0.1:8443/;
 *       proxy_http_version 1.1;
 *       proxy_set_header Upgrade $http_upgrade;
 *       proxy_set_header Connection "upgrade";
 *       proxy_read_timeout 3600s;
 *   }
 * ────────────────────────────────────────────────────────────────────────
 */

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

// ── Konfiguracja ─────────────────────────────────────────────────────────
const PORT           = process.env.PORT || 8443;
const MAX_ROOM_SIZE  = parseInt(process.env.MAX_ROOM_SIZE || '12', 10); // limit osób w kanale głosowym
const HEARTBEAT_MS   = 25000; // co ile pingujemy klientów (musi być < timeout ALB/Nginx)
// Prosty "shared secret" - front-end (ms) musi go przesłać w URL (?token=...),
// żeby przypadkowy skaner internetu nie mógł se wchodzić na Twój relay.
// Ustaw swój w zmiennej środowiskowej na serwerze: VOICE_TOKEN=xxxxx
const AUTH_TOKEN     = process.env.VOICE_TOKEN || '';

// ── Stan w pamięci ───────────────────────────────────────────────────────
// rooms: Map<roomId, Map<uid, { ws, name, avatar, muted, deaf }>>
const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Map());
  return rooms.get(roomId);
}

function peerPublicInfo(uid, p) {
  return { uid, name: p.name, avatar: p.avatar, muted: !!p.muted, deaf: !!p.deaf };
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch (_) {}
  }
}

function broadcastToRoom(roomId, obj, exceptUid = null) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const [uid, p] of room) {
    if (uid !== exceptUid) send(p.ws, obj);
  }
}

function removeFromRoom(ws) {
  if (!ws._roomId || !ws._uid) return;
  const room = rooms.get(ws._roomId);
  if (!room) return;
  room.delete(ws._uid);
  broadcastToRoom(ws._roomId, { type: 'peer-left', uid: ws._uid }, null);
  if (room.size === 0) rooms.delete(ws._roomId);
  console.log(`[voice] ${ws._uid} opuścił kanał ${ws._roomId} (zostało: ${room.size})`);
  ws._roomId = null;
  ws._uid = null;
}

// ── HTTP (health-check dla AWS + upgrade do WS) ─────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    let totalUsers = 0;
    for (const r of rooms.values()) totalUsers += r.size;
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, users: totalUsers }));
    return;
  }
  res.writeHead(404); res.end();
});

// Akceptujemy oba warianty ścieżki, bo reverse proxy może:
//   1) zostawić /voice/ws bez zmian, albo
//   2) obciąć prefiks /voice/ i przekazać do Node jako /ws.
// Używamy noServer, żeby jawnie obsłużyć upgrade i logować błędną ścieżkę.
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  let pathname = '';
  try {
    pathname = new URL(req.url, 'http://localhost').pathname.replace(/\/+$/, '') || '/';
  } catch (_) {
    socket.destroy();
    return;
  }

  if (pathname !== '/ws' && pathname !== '/voice/ws') {
    console.warn(`[voice] Odrzucono WebSocket dla nieznanej sciezki: ${pathname}`);
    try {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    } catch (_) {}
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // Autoryzacja przez query string: /ws?token=...&uid=...&name=...&avatar=...&room=...
  const url = new URL(req.url, 'http://x');
  const token = url.searchParams.get('token') || '';
  if (AUTH_TOKEN && token !== AUTH_TOKEN) {
    console.warn(`[voice] Odrzucono polaczenie WS: nieprawidlowy VOICE_TOKEN (path: ${url.pathname})`);
    send(ws, { type: 'error', msg: 'Zły token' });
    ws.close(4001, 'unauthorized');
    return;
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }

    switch (msg.type) {

      // Dołączenie do kanału głosowego
      case 'join': {
        const roomId = String(msg.room || '').slice(0, 128);
        const uid    = String(msg.uid  || '').slice(0, 128);
        if (!roomId || !uid) return send(ws, { type: 'error', msg: 'Brak room/uid' });

        const room = getRoom(roomId);
        if (room.size >= MAX_ROOM_SIZE) {
          return send(ws, { type: 'error', msg: 'Kanał głosowy jest pełny' });
        }
        // jeśli ten uid już siedzi w innym połączeniu (np. odświeżył kartę) — wywal starą sesję
        if (room.has(uid)) {
          const old = room.get(uid);
          try { old.ws.close(4002, 'replaced'); } catch (_) {}
          room.delete(uid);
        }

        ws._roomId = roomId;
        ws._uid = uid;
        room.set(uid, {
          ws,
          name: String(msg.name || uid).slice(0, 64),
          avatar: String(msg.avatar || '').slice(0, 512),
          muted: !!msg.muted,
          deaf: false,
        });

        // Lista aktualnych uczestników (bez nowego) — nowy peer inicjuje offer do każdego z nich
        const peers = [];
        for (const [pid, p] of room) if (pid !== uid) peers.push(peerPublicInfo(pid, p));
        send(ws, { type: 'joined', room: roomId, peers });

        // Powiadom resztę, że ktoś dołączył
        broadcastToRoom(roomId, { type: 'peer-joined', peer: peerPublicInfo(uid, room.get(uid)) }, uid);
        console.log(`[voice] ${uid} dołączył do kanału ${roomId} (razem: ${room.size})`);
        break;
      }

      // Przekazanie sygnalizacji WebRTC (offer/answer/ICE) do konkretnego peera w tym samym pokoju
      case 'signal': {
        if (!ws._roomId || !ws._uid) return;
        const room = rooms.get(ws._roomId);
        if (!room) return;
        const target = room.get(String(msg.target || ''));
        if (!target) return;
        send(target.ws, { type: 'signal', from: ws._uid, data: msg.data });
        break;
      }

      // Zmiana stanu mikrofonu/głośnika — tylko info wizualne dla innych
      case 'mute': {
        if (!ws._roomId || !ws._uid) return;
        const room = rooms.get(ws._roomId);
        if (!room || !room.has(ws._uid)) return;
        room.get(ws._uid).muted = !!msg.muted;
        broadcastToRoom(ws._roomId, { type: 'peer-muted', uid: ws._uid, muted: !!msg.muted });
        break;
      }

      // Wyjście z kanału (np. przejście do innego kanału na tym samym serwerze)
      case 'leave': {
        removeFromRoom(ws);
        break;
      }

      default:
        // nieznany typ wiadomości - ignorujemy
        break;
    }
  });

  ws.on('close', () => removeFromRoom(ws));
  ws.on('error', () => removeFromRoom(ws));
});

// ── Heartbeat: zabij martwe połączenia (np. laptop uśpiony, zerwane WiFi) ─
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { removeFromRoom(ws); ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  }
}, HEARTBEAT_MS);

wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`[voice] Serwer glosowy dziala na porcie ${PORT} (WS: /ws oraz /voice/ws, health: /health)`);
  if (!AUTH_TOKEN) console.log('[voice] UWAGA: VOICE_TOKEN nie ustawiony — endpoint jest otwarty dla każdego, kto zna adres.');
});

/**
 * ── PRZYKŁAD KLIENTA (do wpięcia w chat_view.php, kanał głosowy serwera) ─
 * Tylko dla orientacji jak się łączyć — to NIE jest część serwera:
 *
 *   const ws = new WebSocket(`wss://TWOJA-DOMENA/voice/ws?token=SEKRET&uid=${ME}&name=${myName}&avatar=${myAvatarUrl}&room=${serverId+':'+channelId}`);
 *   ws.onmessage = async (ev) => {
 *     const msg = JSON.parse(ev.data);
 *     if (msg.type === 'joined') {
 *       for (const peer of msg.peers) await callPeer(peer.uid); // ty inicjujesz offer do już obecnych
 *     }
 *     if (msg.type === 'peer-joined') { /* poczekaj aż on zainicjuje offer do Ciebie *\/ }
 *     if (msg.type === 'signal') await handleSignal(msg.from, msg.data);
 *     if (msg.type === 'peer-left') removePeerAudio(msg.uid);
 *     if (msg.type === 'peer-muted') updateMuteIcon(msg.uid, msg.muted);
 *   };
 *   ws.onopen = () => ws.send(JSON.stringify({type:'join', room: serverId+':'+channelId, uid: ME, name: myName, avatar: myAvatarUrl}));
 *
 *   function sendSignal(target, data){ ws.send(JSON.stringify({type:'signal', target, data})); }
 *
 * ── TURN (opcjonalnie) ──────────────────────────────────────────────────
 * Jeśli komuś WebRTC nie połączy się bezpośrednio (symetryczny NAT, część
 * sieci firmowych/komórkowych) — audio samo w sobie NIE leci przez ten
 * plik, tylko peer-to-peer. Wtedy potrzebny jest serwer TURN. Najprościej:
 * AWS ma gotowe obrazy z coturn, albo `sudo apt install coturn` na tej
 * samej instancji i dopisanie go do iceServers w RTCPeerConnection.
 */
