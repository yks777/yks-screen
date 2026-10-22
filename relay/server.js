/* ==========================================================================
 * YKS-Screen — servidor de relay (OPCIONAL)
 * --------------------------------------------------------------------------
 * Esta é a alternativa ao broker MQTT público: um relay próprio, hospedado
 * por você, que repassa as mensagens da sala.
 *
 * Por que ele é OPCIONAL?
 *   O YKS-Screen funciona 100% estático (sem servidor nenhum) usando um
 *   broker MQTT público. Este arquivo existe para quem prefere:
 *     - não publicar a mídia em um broker público (privacidade), e/ou
 *     - ter controle de latência e do número de conexões.
 *
 * O relay é um "bus" dumb: repassa as mensagens de controle (JSON) e os
 * frames de mídia (binário) para os demais participantes da MESMA sala.
 * Ele NUNCA decodifica a mídia.
 *
 * Como rodar:
 *   cd relay
 *   npm install
 *   npm start
 *
 * Variáveis de ambiente:
 *   PORT=8080                 porta HTTP/WS
 *   SOCKET_PATH=/ws           caminho do Socket.IO (igual ao app.js)
 *   STATIC_DIR=..             pasta servida (index.html, styles.css, app.js)
 *   DISCORD_BOT_TOKEN=...     (opcional) habilita a validação de sala
 *   DISCORD_GUILD_ID=...      (opcional) guild usado na validação
 * ========================================================================== */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 8080;
const SOCKET_PATH = process.env.SOCKET_PATH || '/ws';
const STATIC_DIR = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '..'));
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const GUILD_ID = process.env.DISCORD_GUILD_ID || '';

/* ==========================================================================
 * 1. SERVIDOR HTTP (estáticos + fallback)
 * ========================================================================== */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let file = path.join(STATIC_DIR, decodeURIComponent(url.pathname));

  if (!file.startsWith(STATIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
    file = path.join(file, 'index.html');
  }
  if (!fs.existsSync(file)) {
    /* Fallback de SPA apenas para "navegação" (sem extensão). */
    if (path.extname(url.pathname)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    file = path.join(STATIC_DIR, 'index.html');
  }

  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache'
  });
  fs.createReadStream(file).pipe(res);
});

/* ==========================================================================
 * 2. SOCKET.IO — relay de salas
 * ========================================================================== */

const io = new Server(server, {
  path: SOCKET_PATH,
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 10e6,
  transports: ['websocket']
});

/* roomId -> Map<userId, participant> */
const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Map());
  return rooms.get(roomId);
}

/* ==========================================================================
 * 3. SEGURANÇA — o usuário realmente está naquele canal de voz?
 * --------------------------------------------------------------------------
 * O channelId vem do cliente e, portanto, NÃO é confiável. Quando
 * DISCORD_BOT_TOKEN e DISCORD_GUILD_ID estão configurados, o relay exige
 * que o usuário esteja conectado ao canal de voz da sala.
 * ========================================================================== */

async function userIsInVoiceChannel(userId, channelId) {
  if (!BOT_TOKEN || !GUILD_ID) return true; /* modo protótipo */
  try {
    const res = await fetch(
      `https://discord.com/api/v10/guilds/${GUILD_ID}/voice-states`,
      { headers: { Authorization: `Bot ${BOT_TOKEN}` } }
    );
    if (!res.ok) return false;
    const states = await res.json();
    return states.some((s) => s.user_id === userId && s.channel_id === channelId);
  } catch (e) {
    console.error('[relay] falha ao validar membro do canal:', e.message);
    return false;
  }
}

/* ==========================================================================
 * 4. CONEXÕES
 * ========================================================================== */

io.on('connection', async (socket) => {
  const auth = socket.handshake.auth || {};
  const roomId = String(auth.roomId || '');
  const user = auth.user || {};

  if (!roomId) {
    console.warn('[relay] conexão sem roomId — recusada');
    socket.disconnect(true);
    return;
  }

  const userId = String(user.id || socket.id);
  const username = String(user.username || 'Participante');

  const allowed = await userIsInVoiceChannel(userId, roomId);
  if (!allowed) {
    console.warn(`[relay] usuário ${userId} recusado na sala ${roomId}`);
    socket.emit('error-message', { message: 'Você não está neste canal de voz.' });
    socket.disconnect(true);
    return;
  }

  socket.join(roomId);
  console.log(`[relay] ${username} (${userId}) entrou na sala ${roomId}`);

  /* --- controle (presença, stream start/stop) ------------------------ */
  socket.on('meta', (meta) => {
    if (!meta || !meta.user) return;
    /* O relay injeta o próprio userId: o cliente não pode falsificar a
       origem da mensagem. */
    meta.user = Object.assign({}, meta.user, { id: userId });
    socket.to(roomId).emit('meta', meta);
  });

  /* --- mídia binária --------------------------------------------------- */
  socket.on('media', (meta, buffer) => {
    if (!meta || !buffer) return;
    meta.userId = userId;
    socket.to(roomId).emit('media', meta, buffer);
  });

  socket.on('disconnect', () => {
    console.log(`[relay] ${username} saiu da sala ${roomId}`);
  });
});

/* ==========================================================================
 * 5. START
 * ========================================================================== */

server.listen(PORT, () => {
  console.log('');
  console.log('  YKS-Screen relay (opcional)');
  console.log('  ------------------------------------------------------------');
  console.log(`  HTTP/WSS : http://localhost:${PORT}`);
  console.log(`  Socket.IO: ${SOCKET_PATH}`);
  console.log(`  Estáticos: ${STATIC_DIR}`);
  console.log(`  Validação de canal: ${BOT_TOKEN && GUILD_ID ? 'ATIVA (bot token)' : 'DESATIVADA (modo protótipo)'}`);
  console.log('');
  console.log('  Lembre-se: para usar o app SEM servidor, use o transporte MQTT');
  console.log('  (padrão) com ?transport=mqtt — este relay só é necessário com');
  console.log('  ?transport=socketio.');
  console.log('');
});
