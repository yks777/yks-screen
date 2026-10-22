/* ==========================================================================
 * YKS-Screen — aba companheira de compartilhamento
 * --------------------------------------------------------------------------
 * Por que esta aba existe?
 *
 * A Activity do Discord roda dentro de um iframe de outra origem. O Discord
 * não coloca "allow=display-capture" nesse iframe, e o Chromium bloqueia a
 * Screen Capture API ali:
 *
 *   NotAllowedError: Access to the feature "display-capture" is disallowed
 *   by permissions policy.
 *
 * Nenhuma permissão do navegador resolve isso — é uma restrição de
 * plataforma. A saída é capturar FORA do iframe, numa aba normal do
 * navegador, e publicar os frames pelo mesmo transporte da sala. Quem
 * assiste continua dentro do Discord; só quem mostra sai.
 *
 * Esta página NÃO faz handshake com o Discord (não há Activity aqui): ela
 * recebe sala e identidade pela URL, conecta no transporte e publica.
 * ========================================================================== */

(function () {
  'use strict';

  var F = window.YKS_FRAMES;
  var params = new URLSearchParams(window.location.search);

  /* --- identidade e destino (vindos da Activity) ------------------------ */
  var room = (params.get('room') || '').trim();
  var user = {
    id: (params.get('user') || '').trim() || ('web-' + F.randomId(8)),
    username: (params.get('name') || '').trim() || 'Participante',
    avatar: null
  };
  var transportKind = (params.get('transport') || 'mqtt');
  var brokerList = (params.get('brokers') || '').split(',').filter(Boolean);
  if (!brokerList.length && params.get('broker')) brokerList = [params.get('broker')];
  /* Fallback para os brokers públicos: o endereço enviado pela Activity pode
     ser o do proxy do Discord, que nem sempre aceita conexões de fora. O
     proxy encaminha para o mesmo broker público, então a sala continua a
     mesma. */
  ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt'].forEach(function (url) {
    if (brokerList.indexOf(url) === -1) brokerList.push(url);
  });
  var relayUrl = (params.get('relay') || '').trim() || 'ws://localhost:8080';
  var mqttPrefix = (params.get('mqtt') || 'yks').trim() || 'yks';
  var socketPath = (params.get('socketPath') || '/ws').trim() || '/ws';

  /* Identidade desta aba: distingue o eco das nossas próprias mensagens. */
  var sid = F.randomId(12);

  /* --- estado ------------------------------------------------------------ */
  var transport = null;
  var publishing = false;
  var connected = false;
  var heartbeat = null;
  var pendingMetas = [];
  var pub = null;

  var el = {
    room: document.getElementById('capRoom'),
    status: document.getElementById('capStatus'),
    video: document.getElementById('capVideo'),
    idle: document.getElementById('capIdle'),
    preview: document.getElementById('capPreview'),
    start: document.getElementById('capStart'),
    stop: document.getElementById('capStop'),
    note: document.getElementById('capNote'),
    error: document.getElementById('capError')
  };

  /* --- UI ---------------------------------------------------------------- */

  function setStatus(state, text) {
    if (!el.status) return;
    el.status.dataset.state = state;
    el.status.textContent = text;
  }

  function showError(text) {
    if (!el.error) return;
    el.error.textContent = text;
    el.error.hidden = !text;
  }

  function sendMeta(meta) {
    if (!transport) return;
    meta.sid = sid;
    meta.user = user;
    /* Antes de conectar, as mensagens ficam na fila: sem isso o "stream"
       inicial se perderia e a Activity nunca criaria o tile. */
    if (!connected) {
      pendingMetas.push(meta);
      return;
    }
    transport.sendMeta(meta);
  }

  /* --- transporte --------------------------------------------------------- */

  function connect() {
    if (!room) {
      setStatus('err', 'Sala ausente');
      showError('Não foi possível identificar a sala. Feche esta aba e clique em "Compartilhar tela" de novo na Activity.');
      return;
    }

    if (el.room) el.room.textContent = 'Sala ' + room;
    /* Não dá para começar a publicar antes de ter transporte. */
    if (el.start) el.start.disabled = true;

    transport = window.YKS_TRANSPORT.create({
      kind: transportKind,
      room: room,
      user: user,
      guildId: null,
      mqttPrefix: mqttPrefix,
      brokerUrls: brokerList,
      relayUrl: relayUrl,
      socketPath: socketPath,
      socketIoSources: [
        '/socketio/4.7.5/socket.io.min.js',
        'https://cdn.socket.io/4.7.5/socket.io.min.js'
      ],
      /* Não assina o fluxo de vídeo: esta aba só publica. */
      subscribeMedia: false,
      stats: { metaOut: 0, bytesOut: 0 },
      onStatus: function (status, detail) {
        if (status === 'connected') {
          connected = true;
          setStatus('ok', 'Conectado');
          showError('');
          if (el.start) el.start.disabled = false;
          /* Despeja o que foi acumulado antes da conexão. */
          pendingMetas.splice(0).forEach(function (meta) { transport.sendMeta(meta); });
        } else if (status === 'reconnecting') {
          connected = false;
          setStatus('warn', 'Reconectando…');
        } else if (status === 'error') {
          connected = false;
          setStatus('err', 'Sem conexão');
          showError('Não foi possível conectar ao transporte de mídia: ' + (detail || ''));
        }
      },
      onMeta: handleMeta,
      onMedia: function () { /* não recebe mídia */ }
    });

    /* Heartbeat: mantém viva a presença da publicação para a Activity. */
    heartbeat = window.setInterval(function () {
      if (!publishing) return;
      sendMeta({ t: 'ping' });
    }, 5000);
  }

  /* Mensagens de controle vindas da sala. */
  function handleMeta(meta) {
    if (!meta || meta.sid === sid) return;

    /* Alguém que chegou agora precisa de um quadro completo. */
    if (meta.t === 'needkey' && meta.type) {
      window.YKS_BROADCAST.requestKeyFrame(meta.type);
      return;
    }

    /* Alguém acabou de entrar na sala: reanuncia a transmissão, senão essa
       pessoa ficaria sem tile até o compartilhamento parar e voltar. */
    if (meta.t === 'hello' && publishing && pub) {
      sendMeta({
        t: 'stream',
        type: 'screen',
        w: pub.width || 0,
        h: pub.height || 0,
        hasAudio: !!pub.audio
      });
    }
  }

  /* --- captura ------------------------------------------------------------ */

  function startSharing() {
    if (publishing) return;
    showError('');

    if (!window.isSecureContext) {
      showError('O compartilhamento de tela exige HTTPS. Abra o link pelo navegador do Discord (https://).');
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      showError('Este navegador não suporta compartilhamento de tela.');
      return;
    }

    setStatus('warn', 'Escolhendo a tela…');

    /* Se o seletor não for concluído (janela fechada, picker que não abre),
       a promessa pode ficar pendurada: depois de um tempo, volta ao estado
       normal em vez de deixar a interface travada em "Escolhendo…". */
    var pending = window.setTimeout(function () {
      if (publishing) return;
      setStatus('ok', 'Conectado');
      showError('A seleção de tela não foi concluída. Clique em "Compartilhar minha tela" de novo.');
    }, 30000);

    navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: window.YKS_MEDIA.video.width },
        height: { ideal: window.YKS_MEDIA.video.height },
        frameRate: { ideal: window.YKS_MEDIA.video.framerate }
      },
      audio: true
    }).then(function (stream) {
      window.clearTimeout(pending);
      publishing = true;

      if (el.video) {
        el.video.srcObject = stream;
        el.video.play().catch(function () { /* ignora */ });
      }
      if (el.preview) el.preview.classList.add('is-live');
      if (el.idle) el.idle.hidden = true;
      if (el.start) el.start.hidden = true;
      if (el.stop) el.stop.hidden = false;
      if (el.note) {
        el.note.innerHTML = 'Compartilhando <strong>' + escapeHtml(user.username) +
          '</strong>. Você pode voltar ao Discord — mantenha esta aba aberta até parar de compartilhar.';
      }
      setStatus('ok', 'Compartilhando');

      pub = window.YKS_BROADCAST.publish({
        stream: stream,
        type: 'screen',
        user: user,
        sid: sid,
        transport: transport,
        video: window.YKS_MEDIA.video,
        audio: window.YKS_MEDIA.audio,
        stats: { framesEncoded: 0 },
        isMuted: function () { return false; },
        onState: function (kind, msg) {
          if (kind === 'error') showError(msg);
        },
        onStopped: onPublishStopped
      });

      sendMeta({
        t: 'stream',
        type: 'screen',
        w: pub.width || 0,
        h: pub.height || 0,
        hasAudio: !!pub.audio
      });
    }).catch(function (err) {
      window.clearTimeout(pending);
      var info = window.YKS_ERRORS.describeCaptureError(err);
      console.error('[YKS] captura:', err && err.name, err && err.message);
      setStatus('err', 'Falha na captura');
      showError(info.msg + (info.hint ? ' ' + info.hint : ''));
    });
  }

  /* O publicador parou (nosso botão ou a UI "parar compartilhamento" do
     navegador): avisa a sala e volta a interface ao estado inicial. */
  function onPublishStopped() {
    publishing = false;
    pub = null;
    sendMeta({ t: 'stop', type: 'screen' });

    if (el.video) el.video.srcObject = null;
    if (el.preview) el.preview.classList.remove('is-live');
    if (el.idle) el.idle.hidden = false;
    if (el.start) el.start.hidden = false;
    if (el.stop) el.stop.hidden = true;
    if (el.note) {
      el.note.innerHTML = 'Compartilhamento encerrado. Você pode fechar esta aba.';
    }
    setStatus('ok', 'Parado');
  }

  function stopSharing() {
    if (!publishing) return;
    /* YKS_BROADCAST.stop() dispara onStopped(), que faz a limpeza. */
    window.YKS_BROADCAST.stop('screen');
  }

  function escapeHtml(text) {
    return String(text || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* --- início ------------------------------------------------------------- */

  if (el.start) el.start.addEventListener('click', startSharing);
  if (el.stop) el.stop.addEventListener('click', function () {
    stopSharing();
    window.setTimeout(function () { window.close(); }, 150);
  });

  window.addEventListener('beforeunload', function () {
    if (!publishing) return;
    sendMeta({ t: 'stop', type: 'screen' });
  });

  connect();
})();
