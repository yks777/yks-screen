/* ==========================================================================
 * YKS-Screen — Activity para Discord
 * --------------------------------------------------------------------------
 * Sala de reunião privada (estilo Google Meet) iniciada a partir de um
 * canal de voz do Discord.
 *
 * RESTRIÇÃO CRÍTICA DO DISCORD
 * -----------------------------
 * A documentação oficial de Activities afirma: "WebRTC is not supported".
 * Todo o tráfego passa pelo proxy do Discord (https://<client_id>.discordsays.com)
 * e domínios externos só são alcançáveis via URL Mappings configurados no
 * Portal do Desenvolvedor.
 *
 * COMO FUNCIONA SEM NENHUM SERVIDOR PRÓPRIO
 * ------------------------------------------
 * A mídia é roteada por um BROKER MQTT PÚBLICO (broker.emqx.io, gratuito e
 * sem conta). O broker é apenas um "bus" de publish/subscribe: cada
 * participante publica os frames da sua mídia num tópico da sala e recebe
 * os frames dos outros. Ninguém precisa rodar servidor nenhum.
 *
 *   captura (getDisplayMedia/getUserMedia)
 *     -> WebCodecs VideoEncoder (VP8) / PCM 16 kHz
 *     -> frames binários
 *     -> MQTT (tópico yks/<sala>/media) via broker público
 *     -> VideoDecoder no outro cliente -> <canvas>
 *
 * O transporte é plugável: 'mqtt' (padrão, 100% estático) ou 'socketio'
 * (relay próprio, opcional, com melhor privacidade).
 *
 * A sala é derivada do canal de voz: roomId = discordSdk.channelId. Todo
 * mundo que abre a Activity no mesmo canal de voz cai na mesma sala.
 *
 * Dependências: NENHUMA. O SDK do Discord é carregado via CDN (com
 * fallback para URL Mapping), o cliente MQTT é implementado em mqtt.js
 * (sem npm, sem bundler).
 * ========================================================================== */

(function () {
  'use strict';

  /* ======================================================================
   * 1. CONFIGURAÇÃO
   * ====================================================================== */

  var params = new URLSearchParams(window.location.search);

  var CONFIG = {
    /* Application ID do Discord (OAuth2 Client ID) — Portal do Desenvolvedor
       > General Information > Application ID. */
    clientId: params.get('clientId') || 'SEU_CLIENT_ID',

    /* ------------------------------------------------------------------
     * URL Mappings (Portal do Desenvolvedor > Activities > URL Mappings)
     *   PREFIX     | TARGET
     *   /          | seu-app.exemplo.com   <- a própria Activity
     *   /broker    | broker.emqx.io:8084   <- broker MQTT (WSS)
     *   /sdk       | cdn.jsdelivr.net       <- SDK do Discord
     *   /socketio  | cdn.socket.io          <- Socket.IO (opcional)
     *
     * O TARGET é sempre um HOST (sem protocolo) e precisa apontar para um
     * diretório. O patchUrlMappings() do SDK reescreve
     *   wss://broker.emqx.io:8084/mqtt
     *     -> wss://<client_id>.discordsays.com/broker/mqtt
     * e o proxy do Discord encaminha para o broker real.
     * ------------------------------------------------------------------ */
    urlMappings: [
      { prefix: '/broker', target: 'broker.emqx.io:8084' },
      { prefix: '/sdk', target: 'cdn.jsdelivr.net' },
      { prefix: '/socketio', target: 'cdn.socket.io' }
    ],

    /* ------------------------------------------------------------------
     * Transporte: 'mqtt' (padrão, sem servidor) | 'socketio' (relay próprio)
     * ------------------------------------------------------------------ */
    transport: params.get('transport') || 'mqtt',

    /* Brokers MQTT públicos (WSS). Nenhum cadastro, nenhuma chave.
       O primeiro que responder é usado; os outros são fallback.
       (?broker=... permite apontar para outro broker.) */
    brokerUrls: (params.get('broker') ? [params.get('broker')] : []).concat([
      'wss://broker.emqx.io:8084/mqtt',
      'wss://broker.hivemq.com:8884/mqtt'
    ]),
    /* Prefixo dos tópicos MQTT. */
    mqttPrefix: 'yks',

    /* Relay Socket.IO (só usado com transport=socketio). */
    relayTarget: params.get('relay') || 'relay.exemplo.com',
    relayPrefix: '/socket',
    socketIoPath: params.get('socketPath') || '/ws',
    devRelayUrl: params.get('devRelay') || 'ws://localhost:8080/ws',

    /* Fontes do SDK: 1ª = via URL Mapping (funciona no Discord),
       2ª = CDN direto (funciona em desenvolvimento local). */
    sdkSources: [
      '/sdk/npm/@discord/embedded-app-sdk@2.5.0/output/index.mjs',
      'https://cdn.jsdelivr.net/npm/@discord/embedded-app-sdk@2.5.0/output/index.mjs'
    ],
    socketIoSources: [
      '/socketio/4.7.5/socket.io.min.js',
      'https://cdn.socket.io/4.7.5/socket.io.min.js'
    ],

    /* Modo simulado: usa o DiscordSDKMock do SDK oficial, permitindo rodar
       e testar a Activity fora do Discord (?mock=1&channel=ID&user=ID). */
    mock: params.get('mock') === '1',
    mockChannelId: params.get('channel') || '999888777666555444',
    mockUserId: params.get('user') || '111222333444555666',
    mockUserName: params.get('name') || 'Visitante',

    /* --- mídia --- */
    video: {
      width: 1280,
      height: 720,
      framerate: 15,
      bitrate: 1200000,
      codec: 'vp8'
    },
    audio: {
      sampleRate: 16000,   /* PCM mono 16 kHz ≈ 32 KB/s por participante */
    },

    /* Presença: heartbeat e expiração dos participantes.
       O timeout é a rede de segurança: se o "bye" se perder (ex.: o
       usuário fechou a aba), o participante some da lista assim mesmo. */
    heartbeatMs: 5000,
    peerTimeoutMs: 20000
  };

  /* ======================================================================
   * 2. ESTADO
   * ====================================================================== */

  var state = {
    sdk: null,
    transport: null,
    roomId: null,        /* chave da sala (channelId do Discord) */
    guildId: null,
    user: { id: null, username: 'Participante', avatar: null },
    connected: false,
    peers: {},           /* userId -> { id, username, avatar, streams, lastSeen } */
    tiles: {},           /* "userId:type" -> tile */
    publishers: {},      /* "userId:type" -> publicação local */
    muted: true,         /* começa mutado por privacidade */
    left: false
  };

  var publishersByType = {};

  /* ======================================================================
   * 3. HELPERS DE UI
   * ====================================================================== */

  /* Diagnóstico exposto para depuração (console do Discord) e testes. */
  var stats = {
    framesEncoded: 0,
    framesDecoded: 0,
    audioChunksPlayed: 0,
    bytesOut: 0,
    bytesIn: 0,
    metaIn: 0,
    metaOut: 0,
    lastMeta: []      /* últimos tipos de meta recebidos (depuração) */
  };
  window.__yks = { state: state, stats: stats, config: CONFIG };

  function $(id) { return document.getElementById(id); }

  var els = {
    splash: $('splash'),
    app: $('app'),
    roomChip: $('roomChip'),
    netChip: $('netChip'),
    grid: $('grid'),
    rosterList: $('rosterList'),
    rosterCount: $('rosterCount'),
    roomCode: $('roomCode'),
    copyRoomBtn: $('copyRoomBtn'),
    btnScreen: $('btnScreen'),
    btnCam: $('btnCam'),
    btnMic: $('btnMic'),
    btnLeave: $('btnLeave'),
    toasts: $('toasts')
  };

  function showToast(message, type, timeout) {
    if (!els.toasts) return;
    var toast = document.createElement('div');
    toast.className = 'toast toast--' + (type || 'info');
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    /* textContent: nomes de usuário são entrada arbitrária do cliente */
    toast.textContent = message;
    els.toasts.appendChild(toast);
    window.setTimeout(function () {
      toast.classList.add('is-out');
      window.setTimeout(function () {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 300);
    }, timeout || 5000);
  }

  function setNetChip(chipState, text) {
    els.netChip.dataset.state = chipState;
    els.netChip.textContent = text;
  }

  function setRoomChip(text) {
    els.roomChip.textContent = text;
  }

  function initials(name) {
    return (name || '?').trim().charAt(0).toUpperCase() || '?';
  }

  function randomId(len) {
    var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    var out = '';
    for (var i = 0; i < (len || 8); i++) {
      out += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return out;
  }

  /* ======================================================================
   * 4. SPLASH SCREEN (mesma animação do loader, ~3s)
   * ====================================================================== */

  function initSplash() {
    var reduced = window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var duration = reduced ? 900 : 3000;
    var dismissed = false;

    function dismiss() {
      if (dismissed) return;
      dismissed = true;
      els.splash.classList.add('is-hiding');
      document.body.classList.add('is-ready');
      window.setTimeout(function () { els.splash.setAttribute('hidden', 'hidden'); }, 600);
    }

    window.setTimeout(dismiss, duration);
    ['click', 'keydown', 'touchstart', 'wheel'].forEach(function (evt) {
      window.addEventListener(evt, dismiss, { once: true, passive: true });
    });
  }

  /* ======================================================================
   * 5. CARREGAMENTO DAS BIBLIOTECAS (CDN, com fallback)
   * ====================================================================== */

  /* Carrega um script clássico, tentando as fontes em ordem.
     Após o carregamento, valida que o global esperado existe — assim uma
     fonte que responde 200 com HTML (ex.: fallback de SPA) não "passa". */
  function loadScript(sources, globalName) {
    return sources.reduce(function (chain, src) {
      return chain.catch(function () {
        return new Promise(function (resolve, reject) {
          var el = document.createElement('script');
          el.src = src;
          el.async = true;
          el.onload = function () {
            if (globalName && typeof window[globalName] === 'undefined') {
              el.remove();
              reject(new Error('"' + globalName + '" não foi definido por ' + src));
              return;
            }
            resolve(src);
          };
          el.onerror = function () {
            el.remove();
            reject(new Error('Falha ao carregar ' + src));
          };
          document.head.appendChild(el);
        });
      });
    }, Promise.reject(new Error('nenhuma fonte')));
  }

  /* Carrega o SDK (ESM) via import() dinâmico, tentando as fontes em ordem. */
  function loadSdk(sources) {
    return sources.reduce(function (chain, src) {
      return chain.catch(function () { return import(src); });
    }, Promise.reject(new Error('nenhuma fonte')));
  }

  /* ======================================================================
   * 6. INICIALIZAÇÃO DO DISCORD (SDK + sala)
   * ====================================================================== */

  /* Dentro do Discord, a Activity roda no proxy
     (https://<client_id>.discordsays.com) e a CSP bloqueia qualquer host
     externo. Fora do Discord (dev local / GitHub Pages direto), não há
     proxy: o patchUrlMappings só atrapalharia, porque reescreveria a URL
     do broker para o host local. */
  var IN_DISCORD_PROXY = /\.discordsays\.com$/.test(window.location.hostname) ||
    params.get('proxy') === '1';

  function initDiscord() {
    return loadSdk(CONFIG.sdkSources).then(function (sdk) {
      /* ----------------------------------------------------------------
       * patchUrlMappings(): DEVE ser chamado ANTES de qualquer requisição
       * para um domínio externo. Ele reescreve window.fetch, window.WebSocket
       * e XMLHttpRequest.open para que as URLs mapeadas passem pelo proxy
       * do Discord em vez de serem bloqueadas por CSP ("blocked:csp").
       *
       * Exemplo (produção):
       *   wss://broker.emqx.io:8084/mqtt
       *     -> wss://<client_id>.discordsays.com/broker/mqtt
       * e o proxy do Discord encaminha para o broker real.
       * ---------------------------------------------------------------- */
      if (IN_DISCORD_PROXY && typeof sdk.patchUrlMappings === 'function') {
        try {
          patchUrlMappings(sdk, CONFIG.urlMappings);
          console.info('[YKS] patchUrlMappings aplicado:', JSON.stringify(CONFIG.urlMappings));
        } catch (e) {
          console.warn('[YKS] falha ao aplicar patchUrlMappings:', e);
        }
      }

      var sdkInstance;
      if (CONFIG.mock) {
        /* Modo simulado: mesmo contrato de API, sem Discord. */
        sdkInstance = new sdk.DiscordSDKMock(
          CONFIG.clientId, '999999999999999999', CONFIG.mockChannelId, 'mock-location'
        );
      } else {
        sdkInstance = new sdk.DiscordSDK(CONFIG.clientId);
      }

      return sdkInstance.ready().then(function () { return sdkInstance; });
    });
  }

  /* Aplica as URL Mappings (helper isolado para tratamento de erro). */
  function patchUrlMappings(sdk, mappings) {
    sdk.patchUrlMappings(mappings);
  }

  /* Descobre o canal de voz atual e o transforma no ID da sala. */
  function resolveRoom(sdk) {
    state.sdk = sdk;

    /* channelId = o canal (de voz) onde a Activity foi aberta.
       É ele que define a sala: quem abrir a Activity no mesmo canal
       entra na mesma sala. */
    var channelId = sdk.channelId || (CONFIG.mock ? CONFIG.mockChannelId : null);
    if (!channelId) {
      throw new Error('Não foi possível identificar o canal de voz. Abra a Activity a partir de um canal de voz.');
    }

    state.roomId = String(channelId);
    state.guildId = sdk.guildId;
    setRoomChip('Sala ' + state.roomId);

    /* Fora do Discord (uso como site comum) a sala vem da URL. */
    if (!CONFIG.mock && !sdk.channelId) {
      var code = (params.get('room') || '').trim();
      if (code) state.roomId = code;
    }

    /* Os dados do canal são buscados apenas para enriquecimento (nome/tipo).
       Nomes vêm do cliente e não são confiáveis — nunca são usados como
       chave de sala. */
    return sdk.commands.getChannel({ channel_id: channelId })
      .then(function (channel) {
        state.channelName = (channel && channel.name) || null;
        return state.roomId;
      })
      .catch(function () { return state.roomId; });
  }

  /* Identifica o usuário atual. */
  function resolveUser(sdk) {
    if (CONFIG.mock) {
      state.user = {
        id: CONFIG.mockUserId,
        username: CONFIG.mockUserName,
        avatar: null
      };
      return Promise.resolve(state.user);
    }

    /* O evento CURRENT_USER_UPDATE traz o usuário do cliente Discord. */
    return new Promise(function (resolve) {
      var done = false;
      function finish(user) {
        if (done || !user) return;
        done = true;
        state.user = {
          id: String(user.id),
          username: user.username || user.global_name || 'Participante',
          avatar: user.avatar || null
        };
        resolve(state.user);
      }

      try {
        sdk.subscribe('CURRENT_USER_UPDATE', function (event) { finish(event); });
      } catch (e) { /* ignora: fallback abaixo */ }

      /* Último recurso: identidade provisória (o relay continua funcionando).
         O evento CURRENT_USER_UPDATE costuma chegar em ~100ms após o
         handshake, então esse prazo raramente é usado. */
      window.setTimeout(function () {
        finish({ id: 'anon-' + randomId(8), username: 'Participante' });
      }, 1200);
    });
  }

  /* Sincroniza a lista de participantes informada pelo Discord. */
  function subscribeParticipants(sdk) {
    try {
      sdk.subscribe('ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE', function (event) {
        var list = (event && event.participants) || [];
        console.info('[YKS] participantes da instância:', list.length);
        /* O Discord sabe quem está na Activity; o protocolo de presença
           (via broker) diz quem está transmitindo. */
        list.forEach(function (p) {
          if (p && p.id && !state.peers[p.id]) {
            state.peers[p.id] = {
              id: String(p.id),
              username: p.username || 'Participante',
              avatar: p.avatar || null,
              streams: {},
              lastSeen: Date.now()
            };
          }
        });
        updateRoster();
      });
    } catch (e) {
      console.warn('[YKS] não foi possível assinar participantes:', e);
    }
  }

  /* ======================================================================
   * 7. TRANSPORTE (WebSocket)
   * --------------------------------------------------------------------------
   * Interface comum:
   *   transport.sendMeta(meta)        -> mensagem de controle (JSON)
   *   transport.sendMedia(meta, bytes)-> frame de mídia (binário)
   *   handlers.status(status, detail) -> 'connecting'|'connected'|'error'...
   *   handlers.meta(meta)             -> controle recebido
   *   handlers.media(meta, bytes)     -> mídia recebida
   * ====================================================================== */

  var textEncoder = new TextEncoder();
  var textDecoder = new TextDecoder();

  /* Empacota metadados + payload em um único frame binário. */
  function encodeFrame(meta, payload) {
    var metaBytes = textEncoder.encode(JSON.stringify(meta));
    var out = new Uint8Array(4 + metaBytes.length + payload.length);
    new DataView(out.buffer).setUint32(0, metaBytes.length);
    out.set(metaBytes, 4);
    out.set(payload, 4 + metaBytes.length);
    return out;
  }

  /* Desempacota um frame binário. */
  function decodeFrame(bytes) {
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var len = view.getUint32(0);
    var meta = JSON.parse(textDecoder.decode(bytes.subarray(4, 4 + len)));
    return { meta: meta, payload: bytes.subarray(4 + len) };
  }

  /* --- Transporte MQTT (padrão): broker público, sem servidor próprio --- */
  function createMqttTransport(room, handlers) {
    var topicBase = CONFIG.mqttPrefix + '/' + room;
    var urls = CONFIG.brokerUrls.slice();
    var client = null;

    function connectNext() {
      var url = urls.shift();
      if (!url) {
        handlers.status('error', 'Nenhum broker MQTT disponível');
        return;
      }
      client = new window.MqttClient({
        url: url,
        clientId: 'yks-' + randomId(10),
        keepalive: 30,
        onStatus: function (status, detail) {
          if (status === 'connected') {
            client.subscribe(topicBase + '/media');
            client.subscribe(topicBase + '/ctrl');
            handlers.status('connected', url);
          } else if (status === 'reconnecting') {
            handlers.status('reconnecting', detail);
          } else if (status === 'error') {
            handlers.status('error', detail);
            /* tenta o próximo broker */
            if (url) connectNext();
          }
        },
        onMessage: function (topic, bytes) {
          if (topic === topicBase + '/ctrl') {
            var meta;
            try { meta = JSON.parse(textDecoder.decode(bytes)); } catch (e) { return; }
            handlers.meta(meta);
          } else if (topic === topicBase + '/media') {
            var frame = decodeFrame(bytes);
            handlers.media(frame.meta, frame.payload);
          }
        }
      });
      client.connect();
    }

    connectNext();

    return {
      kind: 'mqtt',
    sendMeta: function (meta) {
      if (!client) return;
      stats.metaOut++;
      client.publish(topicBase + '/ctrl', textEncoder.encode(JSON.stringify(meta)));
    },
    /* Versão confiável (QoS 1): espera o PUBACK do broker. Usada na
       mensagem de saída, que não pode se perder. */
    sendMetaAck: function (meta) {
      if (!client) return Promise.resolve(false);
      stats.metaOut++;
      return client.publishAck(topicBase + '/ctrl', textEncoder.encode(JSON.stringify(meta)), 5000)
        .catch(function () { return false; });
    },
      sendMedia: function (meta, payload) {
        if (!client) return;
        stats.bytesOut += payload.length;
        client.publish(topicBase + '/media', encodeFrame(meta, payload));
      },
      close: function () { if (client) client.disconnect(); }
    };
  }

  /* --- Transporte Socket.IO (opcional): relay próprio ------------------- */
  function relayUrl() {
    var useExternal = /\.discordsays\.com$/.test(window.location.hostname) ||
      params.get('external') === '1';
    var raw = useExternal ? 'wss://' + CONFIG.relayTarget : CONFIG.devRelayUrl;

    /* O Socket.IO deriva o NAMESPACE do path da URL: a URL deve ser a
       origem pura; o caminho do transporte vai na opção `path`. */
    try {
      var u = new URL(raw);
      u.pathname = '/';
      u.search = '';
      u.hash = '';
      return u.toString().replace(/\/$/, '');
    } catch (e) {
      return raw.replace(/\/+$/, '');
    }
  }

  function createSocketIoTransport(room, user, handlers) {
    var socket = null;

    loadScript(CONFIG.socketIoSources, 'io').then(function () {
      if (typeof window.io !== 'function') throw new Error('Socket.IO indisponível.');

      socket = window.io(relayUrl(), {
        path: CONFIG.socketIoPath,
        transports: ['websocket'],
        reconnection: true,
        reconnectionDelay: 1500,
        auth: { roomId: room, guildId: state.guildId, user: user }
      });

      socket.on('connect', function () { handlers.status('connected'); });
      socket.on('disconnect', function (r) { handlers.status('reconnecting', r); });
      socket.on('connect_error', function (e) { handlers.status('error', e && e.message); });
      socket.on('meta', function (meta) { handlers.meta(meta); });
      socket.on('media', function (meta, buffer) {
        handlers.media(meta, new Uint8Array(buffer));
      });
    }).catch(function (e) {
      handlers.status('error', e && e.message);
    });

    return {
      kind: 'socketio',
      sendMeta: function (meta) {
        if (!socket) return;
        stats.metaOut++;
        socket.emit('meta', meta);
      },
      sendMedia: function (meta, payload) {
        if (!socket) return;
        stats.bytesOut += payload.length;
        socket.emit('media', meta, payload.buffer);
      },
      close: function () { if (socket) socket.disconnect(); }
    };
  }

  function createTransport(room, handlers) {
    if (CONFIG.transport === 'socketio') {
      return createSocketIoTransport(room, state.user, handlers);
    }
    return createMqttTransport(room, handlers);
  }

  /* ======================================================================
   * 8. PRESENÇA (roster) — protocolo próprio sobre o transporte
   * --------------------------------------------------------------------------
   *   { t:'hello', user }  -> "oi, estou na sala" (também responde aos outros)
   *   { t:'ping',  user }  -> heartbeat
   *   { t:'bye',   user }  -> "saí"
   *   { t:'stream', user, type, w, h, hasAudio } -> comecei a transmitir
   *   { t:'stop',   user, type }                   -> parei de transmitir
   * ====================================================================== */

  function onTransportMeta(meta) {
    if (!meta || !meta.user || !meta.user.id) return;
    /* Ignora as próprias mensagens (o broker retransmite o que publicamos). */
    if (meta.user.id === state.user.id) return;
    stats.metaIn++;
    stats.lastMeta.push(meta.t + ':' + meta.user.username);
    if (stats.lastMeta.length > 12) stats.lastMeta.shift();

    var peer = state.peers[meta.user.id];
    if (!peer) {
      peer = {
        id: String(meta.user.id),
        username: meta.user.username || 'Participante',
        avatar: meta.user.avatar || null,
        streams: {},
        lastSeen: Date.now()
      };
      state.peers[peer.id] = peer;
    } else {
      peer.username = meta.user.username || peer.username;
      peer.avatar = meta.user.avatar || peer.avatar;
    }
    peer.lastSeen = Date.now();

    if (meta.t === 'hello') {
      /* Responde para que o novo participante também nos conheça.
         (O par se apresenta no máximo 2x — sem loop.) */
      if (!peer.greeted) {
        peer.greeted = true;
        sendMeta({ t: 'hello', user: state.user });
      }
      updateRoster();
      return;
    }

    if (meta.t === 'ping') { updateRoster(); return; }

    if (meta.t === 'bye') {
      removePeer(peer.id);
      return;
    }

    if (meta.t === 'stream') {
      peer.streams[meta.type] = {
        type: meta.type,
        width: meta.w || 0,
        height: meta.h || 0,
        hasAudio: !!meta.hasAudio
      };
      ensureRemoteTile(peer.id, meta.type, peer);
      updateRoster();
      return;
    }

    if (meta.t === 'stop') {
      delete peer.streams[meta.type];
      destroyTile(peer.id + ':' + meta.type);
      updateRoster();
      updateGrid();
    }
  }

  function sendMeta(meta) {
    if (!state.transport) return Promise.resolve(false);
    return state.transport.sendMeta(meta);
  }

  /* Envia uma meta de forma confiável (aguardando confirmação do broker). */
  function sendMetaAck(meta) {
    if (!state.transport || !state.transport.sendMetaAck) return Promise.resolve(false);
    return state.transport.sendMetaAck(meta);
  }

  function removePeer(peerId) {
    delete state.peers[peerId];
    Object.keys(state.tiles).forEach(function (key) {
      if (key.indexOf(peerId + ':') === 0) destroyTile(key);
    });
    updateRoster();
    updateGrid();
  }

  function startPresence() {
    /* Anúncio inicial */
    sendMeta({ t: 'hello', user: state.user });

    /* Heartbeat: mantém a lista viva e detecta peers que saíram. */
    state.heartbeat = setInterval(function () {
      sendMeta({ t: 'ping', user: state.user });
      var now = Date.now();
      Object.keys(state.peers).forEach(function (peerId) {
        if (now - state.peers[peerId].lastSeen > CONFIG.peerTimeoutMs) {
          removePeer(peerId);
        }
      });
    }, CONFIG.heartbeatMs);
  }

  /* ======================================================================
   * 9. PUBLICAÇÃO DE MÍDIA (captura -> WebCodecs -> WebSocket)
   * ====================================================================== */

  function announceStream(pub) {
    sendMeta({
      t: 'stream',
      user: state.user,
      type: pub.type,
      w: pub.width,
      h: pub.height,
      hasAudio: !!pub.audio
    });
  }

  function publishStream(stream, type) {
    var pub = {
      type: type,
      stream: stream,
      active: true,
      video: null,
      audio: null,
      width: 0,
      height: 0,
      seq: 0
    };
    publishersByType[type] = pub;
    state.publishers[state.user.id + ':' + type] = pub;

    var videoTrack = stream.getVideoTracks()[0];
    var audioTrack = stream.getAudioTracks()[0];

    if (videoTrack) {
      startVideoPublisher(pub, videoTrack).catch(function (e) {
        console.error('[YKS] falha no encoder de vídeo:', e);
        showToast('Não foi possível codificar o vídeo: ' + e.message, 'error', 7000);
      });
    }
    if (audioTrack) {
      startAudioPublisher(pub, audioTrack);
    }

    /* Quando o usuário para o compartilhamento pela UI do navegador. */
    pub.onEnded = function () {
      if (pub.active) stopPublishing(type, 'O compartilhamento foi encerrado.');
    };
    stream.getTracks().forEach(function (track) {
      track.addEventListener('ended', pub.onEnded);
    });

    announceStream(pub);
    showToast(type === 'screen' ? 'Compartilhando sua tela.' : 'Câmera ligada.', 'success');
    return pub;
  }

  /* Codifica os frames do vídeo com WebCodecs (VP8) e envia via WebSocket. */
  function startVideoPublisher(pub, track) {
    if (typeof window.VideoEncoder === 'undefined') {
      throw new Error('WebCodecs (VideoEncoder) não está disponível neste navegador.');
    }

    var video = document.createElement('video');
    video.srcObject = new MediaStream([track]);
    video.muted = true;
    video.playsInline = true;
    video.style.display = 'none';
    document.body.appendChild(video);
    pub.videoEl = video;

    return video.play().then(function () {
      var encoder = new window.VideoEncoder({
        output: function (chunk) { sendVideoChunk(pub, chunk); },
        error: function (e) { console.error('[YKS] VideoEncoder:', e); }
      });
      pub.video = encoder;

      var settings = {
        codec: CONFIG.video.codec,
        width: CONFIG.video.width,
        height: CONFIG.video.height,
        bitrate: CONFIG.video.bitrate,
        framerate: CONFIG.video.framerate,
        latencyMode: 'realtime'
      };

      return window.VideoEncoder.isConfigSupported(settings).then(function (res) {
        if (!res.supported) throw new Error('Codeco ' + settings.codec + ' não suportado.');
        encoder.configure(settings);

        var keyFrameEvery = Math.max(1, Math.round(CONFIG.video.framerate * 4));
        var count = 0;
        var lastEncode = 0;

        function encodeNow() {
          if (!pub.active || !encoder || encoder.state !== 'configured') return;
          /* Não enfileira demais: mantém a latência baixa. */
          if (encoder.encodeQueueSize >= 3) return;

          var w = video.videoWidth, h = video.videoHeight;
          if (w && h && (w !== pub.width || h !== pub.height)) {
            /* A resolução mudou (ex.: redimensionou a janela): reconfigura. */
            pub.width = w; pub.height = h;
            try {
              encoder.configure({
                codec: CONFIG.video.codec, width: w, height: h,
                bitrate: CONFIG.video.bitrate,
                framerate: CONFIG.video.framerate, latencyMode: 'realtime'
              });
            } catch (e) { /* mantém a config anterior */ }
          }

          try {
            var frame = new window.VideoFrame(video, {
              timestamp: Math.round(performance.now() * 1000)
            });
            encoder.encode(frame, { keyFrame: (count % keyFrameEvery) === 0 });
            frame.close();
            count++;
            stats.framesEncoded++;
            lastEncode = Date.now();
          } catch (e) {
            console.warn('[YKS] frame descartado:', e.message);
          }
        }

        /* Caminho preferencial: um encode por frame novo da captura. */
        function pumpByFrameCallback() {
          if (!pub.active) return;
          encodeNow();
          video.requestVideoFrameCallback(pumpByFrameCallback);
        }

        if (video.requestVideoFrameCallback) {
          video.requestVideoFrameCallback(pumpByFrameCallback);
        }

        /* Watchdog: se o requestVideoFrameCallback não disparar, continuamos
           codificando por temporizador. */
        pub.watchdog = window.setInterval(function () {
          if (pub.active && Date.now() - lastEncode > 400) encodeNow();
        }, 200);
      });
    });
  }

  function sendVideoChunk(pub, chunk) {
    if (!state.transport) return;
    var data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    state.transport.sendMedia({
      t: 'v',
      userId: state.user.id,
      type: pub.type,
      seq: pub.seq++,
      ts: chunk.timestamp,
      key: chunk.type === 'key',
      w: pub.width,
      h: pub.height,
      codec: CONFIG.video.codec
    }, data);
  }

  /* Captura o áudio, converte para PCM 16 kHz mono e envia via WebSocket. */
  function startAudioPublisher(pub, track) {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;

    var ctx = new Ctx();
    var source = ctx.createMediaStreamSource(new MediaStream([track]));
    var processor = ctx.createScriptProcessor(4096, 1, 1);
    var sink = ctx.createGain();
    sink.gain.value = 0;              /* evita eco no microfone local */

    processor.onaudioprocess = function (event) {
      if (!pub.active || state.muted) return;
      var input = event.inputBuffer.getChannelData(0);
      var pcm = downsampleToPcm16(input, ctx.sampleRate, CONFIG.audio.sampleRate);
      if (!pcm.length || !state.transport) return;
      var bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      state.transport.sendMedia({
        t: 'a',
        userId: state.user.id,
        type: pub.type,
        seq: pub.seq++,
        rate: CONFIG.audio.sampleRate
      }, bytes);
    };

    source.connect(processor);
    processor.connect(sink);
    sink.connect(ctx.destination);

    pub.audio = { ctx: ctx, processor: processor, source: source, sink: sink };
  }

  /* Converte Float32 -> PCM 16 bits, reamostrando para a taxa alvo. */
  function downsampleToPcm16(input, inRate, outRate) {
    if (inRate === outRate) {
      var same = new Int16Array(input.length);
      for (var i = 0; i < input.length; i++) {
        var s = Math.max(-1, Math.min(1, input[i]));
        same[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      return same;
    }
    var ratio = inRate / outRate;
    var outLen = Math.floor(input.length / ratio);
    var out = new Int16Array(outLen);
    for (var j = 0; j < outLen; j++) {
      var pos = j * ratio;
      var idx = Math.floor(pos);
      var frac = pos - idx;
      var a = input[idx];
      var b = idx + 1 < input.length ? input[idx + 1] : a;
      var v = a * (1 - frac) + b * frac;
      v = Math.max(-1, Math.min(1, v));
      out[j] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    return out;
  }

  function stopPublishing(type, message) {
    var pub = publishersByType[type];
    if (!pub) return;
    pub.active = false;

    if (pub.video) { try { pub.video.close(); } catch (e) { /* ignora */ } }
    if (pub.watchdog) { clearInterval(pub.watchdog); pub.watchdog = null; }
    if (pub.audio) {
      try { pub.audio.processor.disconnect(); } catch (e) { /* ignora */ }
      try { pub.audio.source.disconnect(); } catch (e) { /* ignora */ }
      try { pub.audio.ctx.close(); } catch (e) { /* ignora */ }
    }
    if (pub.videoEl) {
      pub.videoEl.srcObject = null;
      pub.videoEl.remove();
    }
    if (pub.stream) {
      pub.stream.getTracks().forEach(function (t) {
        if (pub.onEnded) t.removeEventListener('ended', pub.onEnded);
        try { t.stop(); } catch (e) { /* ignora */ }
      });
    }

    sendMeta({ t: 'stop', user: state.user, type: type });
    delete publishersByType[type];
    delete state.publishers[state.user.id + ':' + type];

    /* remove o tile local */
    destroyTile(state.user.id + ':' + type);
    updateGrid();
    updateControls();

    if (message) showToast(message, 'info');
  }

  /* ======================================================================
   * 10. RECEPÇÃO DE MÍDIA (WebSocket -> WebCodecs -> canvas)
   * ====================================================================== */

  function handleRemoteMedia(meta, bytes) {
    if (!meta || !meta.userId) return;
    /* Ignora o próprio eco (o broker retransmite o que publicamos). */
    if (meta.userId === state.user.id) return;

    var tile = state.tiles[meta.userId + ':' + meta.type];
    if (!tile) return;
    stats.bytesIn += bytes.length;

    if (meta.t === 'v') {
      decodeVideoForTile(tile, bytes, meta);
    } else if (meta.t === 'a') {
      playAudioForTile(tile, bytes, meta);
    }
  }

  /* Cria (ou reaproveita) o tile de um participante remoto. */
  function ensureRemoteTile(userId, type, participant) {
    var key = userId + ':' + type;
    if (state.tiles[key]) return state.tiles[key];

    var peer = state.peers[userId] || participant ||
      { id: userId, username: 'Participante' };
    var tile = createTile(userId, type, peer, false);
    state.tiles[key] = tile;
    updateGrid();
    return tile;
  }

  /* ======================================================================
   * 11. TILES (grade de vídeo)
   * ====================================================================== */

  function createTile(userId, type, participant, isLocal) {
    var article = document.createElement('article');
    article.className = 'tile tile--' + type + (isLocal ? ' tile--local' : '');
    article.dataset.key = userId + ':' + type;

    var video = document.createElement('video');
    video.className = 'tile__video';
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;                 /* áudio é tocado pelo Web Audio */

    var canvas = document.createElement('canvas');
    canvas.className = 'tile__canvas';

    var placeholder = document.createElement('div');
    placeholder.className = 'tile__placeholder';
    placeholder.textContent = initials(participant.username);

    var meta = document.createElement('div');
    meta.className = 'tile__meta';

    var name = document.createElement('span');
    name.className = 'tile__name';
    name.textContent = participant.username + (isLocal ? ' (você)' : '');

    var tag = document.createElement('span');
    tag.className = 'tile__tag';
    tag.textContent = type === 'screen' ? 'TELA' : 'CÂMERA';

    /* selo "ao vivo" (aparece só quando há imagem) */
    var live = document.createElement('div');
    live.className = 'tile__live';
    live.textContent = 'AO VIVO';

    meta.appendChild(name);
    meta.appendChild(tag);
    article.appendChild(video);
    article.appendChild(canvas);
    article.appendChild(placeholder);
    article.appendChild(live);
    article.appendChild(meta);

    var controller = {
      key: userId + ':' + type,
      userId: userId,
      type: type,
      el: article,
      video: video,
      canvas: canvas,
      ctx: canvas.getContext('2d'),
      placeholder: placeholder,
      decoder: null,
      decoderCodec: null,
      audioCtx: null,
      audioNextTime: 0,
      isLocal: isLocal
    };

    /* Esconde o placeholder assim que houver imagem (vídeo local ou
       primeiro frame decodificado do remoto). */
    ['loadeddata', 'playing', 'canplay'].forEach(function (evt) {
      video.addEventListener(evt, function () { article.classList.add('is-live'); });
    });

    return controller;
  }

  /* Decodifica um chunk VP8 e desenha no canvas do tile. */
  function decodeVideoForTile(tile, bytes, meta) {
    if (typeof window.VideoDecoder === 'undefined') return;

    var codec = meta.codec || CONFIG.video.codec;
    var needInit = !tile.decoder || tile.decoder.state !== 'configured' || tile.decoderCodec !== codec;

    if (needInit) {
      if (tile.decoder) { try { tile.decoder.close(); } catch (e) { /* ignora */ } }
      tile.decoder = new window.VideoDecoder({
        output: function (frame) { drawFrame(tile, frame); },
        error: function (e) { console.error('[YKS] VideoDecoder:', e); }
      });
      /* VP8 não precisa de "description" (SPS/PPS) no decoder. */
      tile.decoder.configure({
        codec: codec,
        codedWidth: meta.w || CONFIG.video.width,
        codedHeight: meta.h || CONFIG.video.height
      });
      tile.decoderCodec = codec;
    }

    var chunk = new window.EncodedVideoChunk({
      type: meta.key ? 'key' : 'delta',
      timestamp: meta.ts,
      data: bytes
    });
    tile.decoder.decode(chunk);
  }

  function drawFrame(tile, frame) {
    var w = frame.displayWidth || frame.codedWidth;
    var h = frame.displayHeight || frame.codedHeight;
    if (tile.canvas.width !== w || tile.canvas.height !== h) {
      tile.canvas.width = w;
      tile.canvas.height = h;
    }
    tile.ctx.drawImage(frame, 0, 0, w, h);
    frame.close();
    stats.framesDecoded++;
    tile.el.classList.add('is-live');
  }

  /* Agenda a reprodução de um chunk de áudio PCM. */
  function playAudioForTile(tile, bytes, meta) {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!tile.audioCtx) {
      tile.audioCtx = new Ctx();
      tile.audioNextTime = 0;
    }
    var ctx = tile.audioCtx;
    if (ctx.state === 'suspended') ctx.resume();

    var rate = meta.rate || CONFIG.audio.sampleRate;
    var samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
    var buffer = ctx.createBuffer(1, samples.length, rate);
    var channel = buffer.getChannelData(0);
    for (var i = 0; i < samples.length; i++) channel[i] = samples[i] / 32768;

    var source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    if (tile.audioNextTime < ctx.currentTime) tile.audioNextTime = ctx.currentTime + 0.05;
    source.start(tile.audioNextTime);
    tile.audioNextTime += buffer.duration;
    stats.audioChunksPlayed++;
  }

  function destroyTile(key) {
    var tile = state.tiles[key];
    if (!tile) return;
    if (tile.decoder) { try { tile.decoder.close(); } catch (e) { /* ignora */ } }
    if (tile.audioCtx) { try { tile.audioCtx.close(); } catch (e) { /* ignora */ } }
    if (tile.el && tile.el.parentNode) tile.el.parentNode.removeChild(tile.el);
    delete state.tiles[key];
  }

  /* Reconstrói a grade de tiles. */
  function updateGrid() {
    /* Cria/atualiza o tile local de cada publicação ativa. */
    Object.keys(publishersByType).forEach(function (type) {
      var pub = publishersByType[type];
      var key = state.user.id + ':' + type;
      if (!state.tiles[key]) {
        var tile = createTile(state.user.id, type, state.user, true);
        /* Preview local: o navegador renderiza o MediaStream nativamente
           (não há ida e volta pelo encoder). */
        tile.video.srcObject = pub.stream;
        tile.video.play().catch(function () { /* ignora */ });
        state.tiles[key] = tile;
      }
    });

    /* Remove tiles locais de publicações que já pararam. */
    Object.keys(state.tiles).forEach(function (key) {
      var tile = state.tiles[key];
      if (tile.isLocal && !publishersByType[tile.type]) destroyTile(key);
    });

    /* Garante a ordem no DOM: locais primeiro, remotos depois. */
    var ordered = Object.keys(state.tiles).sort(function (a, b) {
      var ta = state.tiles[a], tb = state.tiles[b];
      if (ta.isLocal !== tb.isLocal) return ta.isLocal ? -1 : 1;
      return 0;
    });
    ordered.forEach(function (key) {
      var tile = state.tiles[key];
      if (tile.el.parentNode !== els.grid) els.grid.appendChild(tile.el);
    });

    /* Layout "palco": se alguém compartilhou a tela, ela ocupa a área
       principal e as câmeras ficam numa faixa abaixo. */
    var hasScreen = Object.keys(state.tiles).some(function (key) {
      return state.tiles[key].type === 'screen';
    });
    els.grid.classList.toggle('has-screen', hasScreen);

    /* conta os TILES (o estado vazio também é filho da grade) */
    var tileCount = els.grid.querySelectorAll('.tile').length;
    els.grid.classList.toggle('is-empty', tileCount === 0);
  }

  /* ======================================================================
   * 12. LISTA DE PARTICIPANTES
   * ====================================================================== */

  function updateRoster() {
    /* A lista inclui o próprio usuário (primeiro) + os demais. */
    var list = [];
    if (state.user && state.user.id) {
      list.push({
        id: state.user.id,
        username: state.user.username,
        streams: (function () {
          var s = {};
          Object.keys(publishersByType).forEach(function (type) { s[type] = { type: type }; });
          return s;
        })(),
        isSelf: true
      });
    }
    Object.keys(state.peers).forEach(function (id) { list.push(state.peers[id]); });

    els.rosterList.innerHTML = '';
    els.rosterCount.textContent = String(list.length);

    list.forEach(function (p) {
      var li = document.createElement('li');
      li.className = 'roster__item';

      var avatar = document.createElement('span');
      avatar.className = 'roster__avatar';
      avatar.textContent = initials(p.username);

      var name = document.createElement('span');
      name.className = 'roster__name';
      name.textContent = p.username + (p.isSelf ? ' (você)' : '');

      var tags = document.createElement('span');
      tags.className = 'roster__tags';
      if (p.streams) {
        if (p.streams.screen) tags.textContent += 'TELA ';
        if (p.streams.camera) tags.textContent += 'CÂM ';
      }

      li.appendChild(avatar);
      li.appendChild(name);
      li.appendChild(tags);
      els.rosterList.appendChild(li);
    });

    if (!list.length) {
      var empty = document.createElement('li');
      empty.className = 'roster__empty';
      empty.textContent = 'Ninguém na sala ainda.';
      els.rosterList.appendChild(empty);
    }
  }

  /* ======================================================================
   * 13. CONTROLES
   * ====================================================================== */

  function updateControls() {
    var screen = publishersByType.screen;
    var cam = publishersByType.camera;

    els.btnScreen.classList.toggle('is-active', !!screen);
    els.btnScreen.setAttribute('aria-pressed', String(!!screen));
    els.btnScreen.querySelector('.ctl__label').textContent = screen ? 'Parar tela' : 'Compartilhar tela';

    els.btnCam.classList.toggle('is-active', !!cam);
    els.btnCam.setAttribute('aria-pressed', String(!!cam));
    els.btnCam.querySelector('.ctl__label').textContent = cam ? 'Parar câmera' : 'Ligar câmera';

    els.btnMic.classList.toggle('is-active', !state.muted);
    els.btnMic.setAttribute('aria-pressed', String(!state.muted));
    els.btnMic.querySelector('.ctl__label').textContent = state.muted ? 'Ativar microfone' : 'Silenciar';
  }

  function toggleScreen() {
    if (publishersByType.screen) {
      stopPublishing('screen', 'Compartilhamento de tela encerrado.');
      return;
    }
    if (!window.isSecureContext) {
      showToast('O compartilhamento de tela exige HTTPS (o Discord já serve a Activity em HTTPS).', 'error', 8000);
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      showToast('Este navegador não suporta compartilhamento de tela.', 'error');
      return;
    }
    navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: CONFIG.video.width }, height: { ideal: CONFIG.video.height }, frameRate: { ideal: CONFIG.video.framerate } },
      audio: true
    }).then(function (stream) {
      publishStream(stream, 'screen');
      updateControls();
      updateGrid();
    }).catch(function (err) {
      reportCaptureError(err);
    });
  }

  function toggleCamera() {
    if (publishersByType.camera) {
      stopPublishing('camera', 'Câmera desligada.');
      return;
    }
    if (!window.isSecureContext) {
      showToast('A câmera exige HTTPS (o Discord já serve a Activity em HTTPS).', 'error', 8000);
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showToast('Este navegador não suporta captura de mídia.', 'error');
      return;
    }
    navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15 } },
      audio: false
    }).then(function (stream) {
      publishStream(stream, 'camera');
      updateControls();
      updateGrid();
    }).catch(function (err) {
      reportCaptureError(err);
    });
  }

  function toggleMic() {
    state.muted = !state.muted;
    showToast(state.muted ? 'Microfone silenciado.' : 'Microfone ativado.', 'info');
    updateControls();
  }

  function leaveRoom() {
    if (state.left) return;
    state.left = true;

    /* 1) Para as transmissões: o fluxo de mídia some da fila do broker. */
    Object.keys(publishersByType).forEach(function (type) { stopPublishing(type); });
    clearInterval(state.heartbeat);

    /* 2) Espera a fila de envio drenar antes do aviso de saída — com a
       mídia em fila, o "bye" (que é pequeno) ficaria atrás dela e poderia
       ser descartado no fechamento do socket. */
    window.setTimeout(function () {
      /* 3) Envia o "bye" de forma CONFIAVEL (QoS 1: espera o PUBACK) e só
         então fecha o socket — assim os demais realmente sabem que saímos. */
      sendMetaAck({ t: 'bye', user: state.user }).then(function () {
        window.setTimeout(function () {
          if (state.transport) state.transport.close();
        }, 200);
      });
    }, 900);

    setNetChip('err', 'Saiu da sala');
    document.body.classList.add('has-left');
    showToast('Você saiu da sala.', 'info');
  }

  function reportCaptureError(err) {
    var name = err && err.name;
    var msg;
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      msg = 'Permissão negada. Libere o acesso à tela/câmera nas permissões do navegador e tente de novo.';
    } else if (name === 'NotFoundError') {
      msg = 'Nenhuma fonte de captura encontrada.';
    } else if (name === 'NotSupportedError') {
      msg = 'Este navegador não suporta esse tipo de captura.';
    } else if (name === 'AbortError') {
      msg = 'A captura foi cancelada.';
    } else {
      msg = 'Falha ao capturar a mídia: ' + ((err && err.message) || err);
    }
    console.error('[YKS] captura:', err);
    showToast(msg, 'error', 8000);
  }

  /* Copia o código da sala (para uso fora do Discord). */
  function copyRoomCode() {
    var code = state.roomId;
    if (!code) return;
    var fallback = function () {
      var input = document.createElement('input');
      input.value = code;
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.appendChild(input);
      input.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      input.remove();
      showToast(ok ? 'Código da sala copiado!' : 'Copie manualmente: ' + code, ok ? 'success' : 'error');
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(code)
        .then(function () { showToast('Código da sala copiado!', 'success'); })
        .catch(fallback);
    } else {
      fallback();
    }
  }

  /* ======================================================================
   * 14. BOOT
   * ====================================================================== */

  function bindControls() {
    els.btnScreen.addEventListener('click', toggleScreen);
    els.btnCam.addEventListener('click', toggleCamera);
    els.btnMic.addEventListener('click', toggleMic);
    els.btnLeave.addEventListener('click', leaveRoom);
    if (els.copyRoomBtn) els.copyRoomBtn.addEventListener('click', copyRoomCode);

    window.addEventListener('beforeunload', function () {
      Object.keys(publishersByType).forEach(function (type) { stopPublishing(type); });
      sendMeta({ t: 'bye', user: state.user });
    });
  }

  function boot() {
    initSplash();
    bindControls();
    updateControls();
    updateRoster();
    updateGrid();   /* estado inicial: nenhum tile -> mostra o estado vazio */

    initDiscord()
      .then(function (sdk) { return resolveRoom(sdk).then(function () { return sdk; }); })
      .then(function (sdk) { return resolveUser(sdk).then(function () { return sdk; }); })
      .then(function (sdk) {
        subscribeParticipants(sdk);
        updateRoster();          /* agora já sabemos quem é o próprio usuário */
        setNetChip('warn', 'Conectando…');
        if (els.roomCode) els.roomCode.textContent = state.roomId;

        /* Conecta ao transporte (broker MQTT público, por padrão). */
        var warnedOutage = false;
        state.transport = createTransport(state.roomId, {
          status: function (status, detail) {
            if (status === 'connected') {
              state.connected = true;
              warnedOutage = false;
              setNetChip('ok', 'Conectado');
              startPresence();
            } else if (status === 'reconnecting') {
              state.connected = false;
              setNetChip('warn', 'Reconectando…');
              if (!warnedOutage) {
                warnedOutage = true;
                showToast(
                  'Sem conexão com o transporte de mídia. Verifique o URL Mapping no Portal do Desenvolvedor (ou a internet).',
                  'error', 9000
                );
              }
            } else if (status === 'error') {
              state.connected = false;
              setNetChip('err', 'Sem conexão');
              console.error('[YKS] transporte:', detail);
              if (!warnedOutage) {
                warnedOutage = true;
                showToast(
                  'Não foi possível conectar ao transporte de mídia. Verifique o URL Mapping no Portal do Desenvolvedor.',
                  'error', 9000
                );
              }
            }
          },
          meta: onTransportMeta,
          media: handleRemoteMedia
        });
      })
      .catch(function (err) {
        console.error('[YKS] falha na inicialização:', err);
        setNetChip('err', 'Erro');
        showToast(
          'Não foi possível iniciar a Activity: ' + ((err && err.message) || err),
          'error', 12000
        );
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
