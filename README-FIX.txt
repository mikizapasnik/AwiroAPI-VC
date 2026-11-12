AWIRO VOICECALL - FIX /voice/ws

Problem:
Frontend laczy sie z wss://voice-call.awiro.xyz/voice/ws, a stary serwer Node akceptowal tylko /ws.
Dlatego health-check domeny dzialal, ale handshake WebSocket byl odrzucany.

Naprawa:
- voice-server.js akceptuje teraz /ws ORAZ /voice/ws
- dziala zarowno z reverse proxy, ktore usuwa /voice/, jak i takim, ktore zostawia pelna sciezke
- bledna sciezka i bledny VOICE_TOKEN sa logowane w konsoli/PM2

Po podmianie pliku na VPS:
  cd /SCIEZKA/DO/VOICECALL
  npm install
  pm2 restart vc-relay --update-env
  pm2 logs vc-relay

Jesli proces ma inna nazwe:
  pm2 list
  pm2 restart NAZWA --update-env

Test lokalny HTTP:
  curl http://127.0.0.1:8443/health

Wazne dla reverse proxy Nginx/aaPanel:
Przy proxy do 127.0.0.1:8443 musza byc naglowki WebSocket:
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_read_timeout 3600s;

Serwer po poprawce toleruje oba warianty proxy_pass:
  location /voice/ { proxy_pass http://127.0.0.1:8443/; }
ORAZ proxy, ktore przekazuje /voice/ws bez obcinania prefixu.
