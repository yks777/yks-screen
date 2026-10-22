(function () {
  'use strict';

  var F = window.YKS_FRAMES;
  var params = new URLSearchParams(window.location.search);

  var room = (params.get('room') || '').trim();
  var user = {
    id: (params.get('user') || '').trim() || ('web-' + F.randomId(8)),
    username: (params.get('name') || '').trim() || 'Participante',
    avatar: null
  };
  var transportKind = (params.get('transport') || 'mqtt');
  var brokerList = (params.get('brokers') || '').split(',').filter(Boolean);
  if (!brokerList.length && params.get('broker')) brokerList = [params.get('broker')];

  ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt'].forEach(function (url) {
    if (brokerList.indexOf(url) === -1) brokerList.push(url);
  });
  var relayUrl = (params.get('relay') || '').trim() || 'ws://localhost:8080';
  var mqttPrefix = (params.get('mqtt') || 'yks').trim() || 'yks';
  var socketPath = (params.get('socketPath') || '/ws').trim() || '/ws';

  var sid = F.randomId(12);

  var transport = null;
  var publishing = false;
  var connected = false;
  var attempts = 0;
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

    if (!connected) {
      pendingMetas.push(meta);
      return;
    }
    transport.sendMeta(meta);
  }

  function connect() {
    if (!room) {
      setStatus('err', 'Sala ausente');
      showError('Não foi possível identificar a sala. Feche esta aba e clique em "Compartilhar tela" de novo na Activity.');
      return;
    }

    if (el.room) el.room.textContent = 'Sala ' + room;

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
        'vendor/socket.io.min.js',
        '/socketio/4.8.4/socket.io.min.js',
        'https://cdn.socket.io/4.8.4/socket.io.min.js'
      ],

      subscribeMedia: false,
      stats: { metaOut: 0, bytesOut: 0 },
      onStatus: function (status, detail) {
        if (status === 'connected') {
          connected = true;
          attempts = 0;
          setStatus('ok', 'Conectado');
          showError('');
          if (el.start) el.start.disabled = false;

          pendingMetas.splice(0).forEach(function (meta) { transport.sendMeta(meta); });
        } else if (status === 'reconnecting') {
          connected = false;
          attempts++;
          setStatus('warn', 'Reconectando…');

          if (attempts >= 2) {
            showError('Sem conexão com o transporte de mídia' +
              (detail ? ' (' + detail + ')' : '') + '. ' +
              'Se você está no Discord, confira o URL Mapping do transporte ' +
              'no Portal do Desenvolvedor; fora do Discord, verifique a internet.');
          }
        } else if (status === 'error') {
          connected = false;
          setStatus('err', 'Sem conexão');
          showError('Não foi possível conectar ao transporte de mídia: ' + (detail || ''));
        }
      },
      onMeta: handleMeta,
      onMedia: function () {  }
    });

    heartbeat = window.setInterval(function () {
      if (!publishing) return;
      sendMeta({ t: 'ping' });
    }, 5000);
  }

  function handleMeta(meta) {
    if (!meta || meta.sid === sid) return;

    if (meta.t === 'needkey' && meta.type) {
      window.YKS_BROADCAST.requestKeyFrame(meta.type);
      return;
    }

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
        el.video.play().catch(function () {  });
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

    window.YKS_BROADCAST.stop('screen');
  }

  function escapeHtml(text) {
    return String(text || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function warnIfBehindProxy() {
    if (!/\.discordsays\.com$/.test(window.location.hostname)) return;

    var site = (params.get('site') || '').trim();
    var target = site
      ? site.replace(/\/+$/, '') + '/capture.html?' + window.location.search.replace(/^\?/, '')
      : '';

    showError('Esta aba foi aberta pelo proxy do Discord, e a CSP dele bloqueia a ' +
      'conexão com o broker de mídia (a aba ficaria em "Reconectando…" para sempre).' +
      (target ? ' Abra o site real: ' + target : ' Abra a aba pelo site publicado ' +
        '(fora do Discord).'));

    if (target) {
      try {
        var link = document.createElement('a');
        link.href = target;
        link.textContent = 'Abrir no site real →';
        link.style.cssText = 'display:inline-block;margin-top:8px;color:#ff2b1b;font-weight:600;';
        link.target = '_blank';
        link.rel = 'noopener';
        if (el.error) el.error.appendChild(link);
      } catch (e) {  }
    }
  }

  warnIfBehindProxy();

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
