(function () {
  'use strict';

  var params = new URLSearchParams(window.location.search);

  var SDK_PREFIX = '/sdk';
  var BROKER_PREFIX = (params.get('brokerPrefix') || '/broker').trim();
  var RELAY_PREFIX = (params.get('relayPrefix') || '/relay').trim();

  var RELAY_TARGET = (params.get('relay') || 'relay.exemplo.com').trim();
  var HAS_RELAY = !!RELAY_TARGET && RELAY_TARGET !== 'relay.exemplo.com' &&
    RELAY_TARGET !== 'SEU_RELAY';

  var CONFIG = {

    clientId: params.get('clientId') || '1562645997308481539',

    activityUrl: params.get('activityUrl') || 'https://yks777.github.io/yks-screen',

    urlMappings: [
      { prefix: SDK_PREFIX, target: 'cdn.jsdelivr.net' },
      { prefix: BROKER_PREFIX, target: 'broker.emqx.io:8084' }
    ].concat(HAS_RELAY ? [{ prefix: RELAY_PREFIX, target: RELAY_TARGET }] : []),

    transport: (params.get('transport') || '').trim(),

    brokerUrls: (function () {
      if (IN_DISCORD_PROXY) {
        return ['wss://' + window.location.host + BROKER_PREFIX + '/mqtt'];
      }
      return (params.get('broker') ? [params.get('broker')] : []).concat([
        'wss://broker.emqx.io:8084/mqtt',
        'wss://broker.hivemq.com:8884/mqtt'
      ]);
    })(),

    mqttPrefix: 'yks',

    relayTarget: RELAY_TARGET,
    socketIoPath: params.get('socketPath') || '/ws',

    sdkSources: [
      SDK_PREFIX + '/npm/@discord/embedded-app-sdk@2.5.0/output/index.mjs',
      'https://cdn.jsdelivr.net/npm/@discord/embedded-app-sdk@2.5.0/output/index.mjs'
    ],

    socketIoSources: [
      'vendor/socket.io.min.js',
      '/socketio/4.8.4/socket.io.min.js',
      'https://cdn.socket.io/4.8.4/socket.io.min.js'
    ],

    mock: params.get('mock') === '1',
    mockChannelId: params.get('channel') || '999888777666555444',
    mockUserId: params.get('user') || '111222333444555666',
    mockUserName: params.get('name') || 'Visitante',

    video: window.YKS_MEDIA.video,
    audio: window.YKS_MEDIA.audio,

    heartbeatMs: 5000,
    peerTimeoutMs: 20000
  };

  var state = {
    sdk: null,
    transport: null,
    roomId: null,
    guildId: null,
    user: { id: null, username: 'Participante', avatar: null },
    connected: false,
    peers: {},
    tiles: {},
    publishers: {},
    muted: true,
    left: false,

    sid: (window.YKS_FRAMES ? window.YKS_FRAMES.randomId(12) : String(Date.now())),

    selfCompanion: {},

    selfStreams: {}
  };

  var publishersByType = {};

  var stats = {
    framesEncoded: 0,
    framesDecoded: 0,
    audioChunksPlayed: 0,
    bytesOut: 0,
    bytesIn: 0,
    metaIn: 0,
    metaOut: 0,
    lastMeta: []
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
    btnLeave: $('btnLeave'),
    toasts: $('toasts')
  };

  var lastTransportError = null;

  function showToast(message, type, timeout) {
    if (!els.toasts) return;
    var toast = document.createElement('div');
    toast.className = 'toast toast--' + (type || 'info');
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');

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
    return window.YKS_FRAMES.randomId(len);
  }

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

  function loadSdk(sources) {
    var failures = [];

    return sources.reduce(function (chain, src) {
      return chain.catch(function () {
        return import(src).catch(function (err) {
          failures.push({ src: src, message: (err && err.message) || String(err) });
          throw err;
        });
      });
    }, Promise.reject(new Error('nenhuma fonte'))).catch(function (err) {
      var error = new Error('Falha ao carregar o SDK do Discord.');
      error.failures = failures;
      error.cause = err;
      throw error;
    });
  }

  function preflightSdk() {
    if (!IN_DISCORD_PROXY) return Promise.resolve(null);

    var url = CONFIG.sdkSources[0];
    return Promise.race([
      fetch(url, { method: 'GET', cache: 'no-store' }).then(function (res) {
        if (res.status === 404) {
          var error = new Error('URL Mapping do SDK ausente');
          error.status = 404;
          error.kind = 'sdk';
          error.url = url;
          throw error;
        }
        return null;
      }),
      new Promise(function (_, reject) {
        window.setTimeout(function () {
          reject(new Error('Timeout ao verificar URL Mapping do SDK (/sdk).'));
        }, 5000);
      })
    ]).catch(function (err) {
      if (err && err.status === 404) throw err;
      return null;
    });
  }

  var IN_DISCORD_PROXY = /\.discordsays\.com$/.test(window.location.hostname) ||
    params.get('proxy') === '1';

  function insideDiscordFrame() {
    return /\.discordsays\.com$/.test(window.location.hostname) || window.parent !== window;
  }

  function initDiscord() {

    if (!CONFIG.mock && !insideDiscordFrame() && (params.get('room') || '').trim()) {
      return Promise.resolve(null);
    }

    return preflightSdk()
      .then(function () { return loadSdk(CONFIG.sdkSources); })
      .then(function (sdk) {

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

          sdkInstance = new sdk.DiscordSDKMock(
            CONFIG.clientId, '999999999999999999', CONFIG.mockChannelId, 'mock-location'
          );
        } else {
          sdkInstance = new sdk.DiscordSDK(CONFIG.clientId);
        }

        return Promise.race([
          sdkInstance.ready().then(function () { return sdkInstance; }),
          new Promise(function (_, reject) {
            window.setTimeout(function () {
              reject(new Error('O Discord não respondeu ao handshake da Activity (timeout do ready()). Verifique o Application ID e tente abrir a Activity de um canal de voz.'));
            }, 8000);
          })
        ]);
      }).catch(function (err) {
        throw new Error(describeInitError(err));
      });
  }

  function describeInitError(err) {
    var msg = (err && err.message) || String(err);

    if (!CONFIG.clientId || CONFIG.clientId === 'SEU_CLIENT_ID') {
      return 'Application ID do Discord não configurado (valor atual: "' +
        (CONFIG.clientId || 'vazio') + '"). Atualize o app.js publicado e recarregue ' +
        'sem cache (Ctrl+Shift+R).';
    }

    if (err && err.status === 404 && err.kind === 'sdk') {
      return 'O URL Mapping do SDK não está configurado: o proxy do Discord devolveu 404 para ' +
        (err.url || CONFIG.sdkSources[0]) + '. No Portal do Desenvolvedor > Activities > ' +
        'URL Mappings, cadastre PREFIX ' + SDK_PREFIX + ' | TARGET cdn.jsdelivr.net e salve.';
    }

    if (err && err.status === 404) {
      var prefix = err.kind === 'mqtt' ? BROKER_PREFIX : RELAY_PREFIX;
      var target = err.kind === 'mqtt' ? 'broker.emqx.io:8084' : CONFIG.relayTarget;
      return 'O URL Mapping do transporte não está configurado: o proxy do Discord devolveu 404 para ' +
        (err.url || prefix) + '. No Portal do Desenvolvedor > Activities > URL Mappings, cadastre ' +
        'PREFIX ' + prefix + ' | TARGET ' + target + ' e salve.';
    }

    if ((err && err.failures && err.failures.length) ||
        /dynamically imported module|Failed to fetch|import\(/i.test(msg)) {
      return describeSdkLoadFailures(err);
    }

    if (!insideDiscordFrame() && !CONFIG.mock) {
      return 'O SDK do Discord não respondeu (' + msg + '). Fora do Discord, use ?room=CODIGO ' +
        'para entrar numa sala.';
    }
    return 'O Discord recusou o handshake da Activity (' + msg + '). Verifique o Application ID ' +
      'e abra a Activity a partir de um canal de voz.';
  }

  function describeSdkLoadFailures(err) {
    var failures = (err && err.failures) || [];
    var mapped = failures.filter(function (f) { return f.src.charAt(0) === '/'; });
    var direct = failures.filter(function (f) { return /^https?:/i.test(f.src); });
    var parts = [];

    parts.push('Não foi possível carregar o SDK do Discord.');

    if (mapped.length) {
      parts.push('O proxy do Discord não devolveu o SDK em "' + mapped[0].src + '" ' +
        '(404 = URL Mapping ausente). Cadastre no Portal do Desenvolvedor > Activities > ' +
        'URL Mappings: PREFIX ' + SDK_PREFIX + ' | TARGET cdn.jsdelivr.net.');
    }
    if (direct.length) {
      parts.push('O CDN direto (' + direct[0].src + ') é bloqueado pela CSP do proxy do ' +
        'Discord (script-src não inclui cdn.jsdelivr.net) — isso é esperado dentro do ' +
        'Discord e não é a causa do erro.');
    }
    if (!mapped.length && !direct.length) {
      parts.push('Detalhe: ' + ((err && err.message) || err));
    }

    return parts.join(' ');
  }

  function patchUrlMappings(sdk, mappings) {
    sdk.patchUrlMappings(mappings, { patchWebSocket: false });
  }

  function resolveRoom(sdk) {
    state.sdk = sdk;

    var channelId = sdk.channelId || (CONFIG.mock ? CONFIG.mockChannelId : null);

    var manualRoom = (params.get('room') || '').trim();

    state.roomId = String(channelId || manualRoom || '');
    state.guildId = sdk.guildId;
    setRoomChip('Sala ' + (state.roomId || '—'));

    console.info('[YKS] sala resolvida:', state.roomId || '(sem sala — aguardando canal de voz ou ?room=)');

    if (!state.roomId) return Promise.resolve(null);

    return sdk.commands.getChannel({ channel_id: channelId })
      .then(function (channel) {
        state.channelName = (channel && channel.name) || null;
        return state.roomId;
      })
      .catch(function () { return state.roomId; });
  }

  function resolveUser(sdk) {
    if (CONFIG.mock) {
      state.user = {
        id: CONFIG.mockUserId,
        username: CONFIG.mockUserName,
        avatar: null
      };
      return Promise.resolve(state.user);
    }

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
      } catch (e) {  }

      window.setTimeout(function () {
        finish({ id: 'anon-' + randomId(8), username: 'Participante' });
      }, 1200);
    });
  }

  function subscribeParticipants(sdk) {
    try {
      sdk.subscribe('ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE', function (event) {
        var list = (event && event.participants) || [];
        console.info('[YKS] participantes da instância:', list.length);

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

  function transportKind() {
    if (CONFIG.transport) return CONFIG.transport;
    if (hasRelay()) return 'socketio';
    return 'mqtt';
  }

  function hasRelay() {
    return HAS_RELAY;
  }

  function relayEndpoint() {
    if (IN_DISCORD_PROXY) {
      return {
        url: 'wss://' + window.location.host,
        path: RELAY_PREFIX + CONFIG.socketIoPath
      };
    }

    var devRelay = (params.get('devRelay') || '').trim();
    if (/^(wss?|https?):\/\//i.test(devRelay)) {
      return {
        url: devRelay.replace(/\/+$/, '').replace(/\/ws$/, ''),
        path: CONFIG.socketIoPath
      };
    }
    return { url: 'wss://' + CONFIG.relayTarget, path: CONFIG.socketIoPath };
  }

  function preflightTransport(kind) {
    if (!IN_DISCORD_PROXY) return Promise.resolve(null);

    var path = kind === 'mqtt'
      ? BROKER_PREFIX + '/mqtt'
      : RELAY_PREFIX + CONFIG.socketIoPath;

    return fetch(path, { method: 'GET', cache: 'no-store' }).then(function (res) {
      if (res.status === 404) {
        var error = new Error('URL Mapping do transporte ausente');
        error.status = 404;
        error.url = path;
        error.kind = kind;
        throw error;
      }
      return null;
    }).catch(function (err) {

      if (err && err.status === 404) throw err;
      return null;
    });
  }

  function createTransport(room, handlers) {
    var kind = transportKind();
    var relay = relayEndpoint();

    return window.YKS_TRANSPORT.create({
      kind: kind,
      room: room,
      user: state.user,
      guildId: state.guildId,
      mqttPrefix: CONFIG.mqttPrefix,
      brokerUrls: CONFIG.brokerUrls,

      proxyBase: IN_DISCORD_PROXY ? ('wss://' + window.location.host) : null,
      proxyPath: kind === 'mqtt' ? BROKER_PREFIX : RELAY_PREFIX,
      relayUrl: relay.url,
      socketPath: relay.path,
      socketIoSources: CONFIG.socketIoSources,
      subscribeMedia: true,
      stats: stats,
      onStatus: handlers.status,
      onMeta: handlers.meta,
      onMedia: handlers.media
    });
  }

  function onTransportMeta(meta) {
    if (!meta || !meta.user || !meta.user.id) return;

    if (meta.sid) {
      if (meta.sid === state.sid) return;
    } else if (meta.user.id === state.user.id) {

      return;
    }
    stats.metaIn++;
    stats.lastMeta.push(meta.t + ':' + meta.user.username);
    if (stats.lastMeta.length > 12) stats.lastMeta.shift();

    if (meta.user.id === state.user.id) {
      onSelfCompanionMeta(meta);
      return;
    }

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

      if (!peer.greeted) {
        peer.greeted = true;
        sendMeta({ t: 'hello', user: state.user });

        Object.keys(publishersByType).forEach(function (type) {
          announceStream(publishersByType[type]);
        });

        Object.keys(state.selfStreams).forEach(function (type) {
          sendMeta({
            t: 'stream',
            user: state.user,
            type: type,
            w: state.selfStreams[type].width || 0,
            h: state.selfStreams[type].height || 0,
            hasAudio: !!state.selfStreams[type].hasAudio
          });
        });
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
      requestKeyFrameIfNeeded(peer.id, meta.type);
      updateRoster();
      return;
    }

    if (meta.t === 'stop') {
      delete peer.streams[meta.type];
      destroyTile(peer.id + ':' + meta.type);
      updateRoster();
      updateGrid();
      return;
    }

    if (meta.t === 'needkey') {

      if (publishersByType[meta.type]) {
        window.YKS_BROADCAST.requestKeyFrame(meta.type);
      }
      return;
    }
  }

  function onSelfCompanionMeta(meta) {
    var type = meta.type;

    if (meta.t === 'ping') {
      state.selfCompanion.lastSeen = Date.now();
      return;
    }

    if (meta.t === 'stream') {
      state.selfCompanion.lastSeen = Date.now();
      state.selfStreams[type] = {
        type: type,
        width: meta.w || 0,
        height: meta.h || 0,
        hasAudio: !!meta.hasAudio
      };
      ensureRemoteTile(state.user.id, type, {
        id: state.user.id,
        username: state.user.username,
        avatar: state.user.avatar
      });
      requestKeyFrameIfNeeded(state.user.id, type);
      updateRoster();
      updateGrid();
      return;
    }

    if (meta.t === 'stop') {
      state.selfCompanion.lastSeen = Date.now();
      delete state.selfStreams[type];

      var key = state.user.id + ':' + type;
      var tile = state.tiles[key];
      if (tile && !tile.isLocal) destroyTile(key);
      updateRoster();
      updateGrid();
    }
  }

  function requestKeyFrameIfNeeded(userId, type) {
    window.setTimeout(function () {
      var tile = state.tiles[userId + ':' + type];
      if (!tile || tile.hasFrame) return;
      sendMeta({ t: 'needkey', user: state.user, type: type });
    }, 1500);
  }

  function sendMeta(meta) {
    if (!state.transport) return Promise.resolve(false);
    meta.sid = state.sid;
    return state.transport.sendMeta(meta);
  }

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

    sendMeta({ t: 'hello', user: state.user });

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

  function startCompanionWatchdog() {
    state.companionWatchdog = setInterval(function () {
      var seen = state.selfCompanion.lastSeen;
      if (!seen) return;
      if (Date.now() - seen <= CONFIG.peerTimeoutMs) return;

      Object.keys(state.selfStreams).forEach(function (type) {
        delete state.selfStreams[type];
        destroyTile(state.user.id + ':' + type);
      });
      state.selfCompanion.lastSeen = 0;
      updateRoster();
      updateGrid();
    }, 5000);
  }

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
    var pub = window.YKS_BROADCAST.publish({
      stream: stream,
      type: type,
      user: state.user,
      sid: state.sid,
      transport: state.transport,
      video: CONFIG.video,
      audio: CONFIG.audio,
      stats: stats,
      isMuted: function () { return false; },
      onState: function (kind, msg) {
        if (kind === 'error') showToast(msg, 'error', 7000);
      },
      onStopped: function (stoppedType) {

        sendMeta({ t: 'stop', user: state.user, type: stoppedType });
        delete publishersByType[stoppedType];
        delete state.publishers[state.user.id + ':' + stoppedType];
        destroyTile(state.user.id + ':' + stoppedType);
        updateGrid();
        updateControls();
        showToast(pendingStopMessage || 'O compartilhamento foi encerrado.', 'info');
        pendingStopMessage = null;
      }
    });

    publishersByType[type] = pub;
    state.publishers[state.user.id + ':' + type] = pub;

    announceStream(pub);
    showToast(type === 'screen' ? 'Compartilhando sua tela.' : 'Câmera ligada.', 'success');
    return pub;
  }

  var pendingStopMessage = null;

  function stopPublishing(type, message) {
    if (!publishersByType[type]) return;
    pendingStopMessage = message || 'O compartilhamento foi encerrado.';
    window.YKS_BROADCAST.stop(type);
  }

  function handleRemoteMedia(meta, bytes) {
    if (!meta || !meta.userId) return;

    if (meta.sid) {
      if (meta.sid === state.sid) return;
    } else if (meta.userId === state.user.id) {
      return;
    }

    var tile = state.tiles[meta.userId + ':' + meta.type];
    if (!tile) return;
    stats.bytesIn += bytes.length;

    if (meta.t === 'v') {
      decodeVideoForTile(tile, bytes, meta);
    } else if (meta.t === 'a') {
      playAudioForTile(tile, bytes, meta);
    }
  }

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

  function createTile(userId, type, participant, isLocal) {
    var article = document.createElement('article');
    article.className = 'tile tile--' + type + (isLocal ? ' tile--local' : '');
    article.dataset.key = userId + ':' + type;

    var video = document.createElement('video');
    video.className = 'tile__video';
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;

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

    var fsBtn = document.createElement('button');
    fsBtn.className = 'tile__fullscreen';
    fsBtn.type = 'button';
    fsBtn.setAttribute('aria-label', 'Tela cheia');
    fsBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      toggleFullscreen(article);
    });
    article.appendChild(fsBtn);

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
      hasFrame: false,
      isLocal: isLocal
    };

    ['loadeddata', 'playing', 'canplay'].forEach(function (evt) {
      video.addEventListener(evt, function () { article.classList.add('is-live'); });
    });

    return controller;
  }

  function decodeVideoForTile(tile, bytes, meta) {
    if (typeof window.VideoDecoder === 'undefined') return;

    var codec = meta.codec || CONFIG.video.codec;
    var needInit = !tile.decoder || tile.decoder.state !== 'configured' || tile.decoderCodec !== codec;

    if (needInit) {
      if (tile.decoder) { try { tile.decoder.close(); } catch (e) {  } }
      tile.decoder = new window.VideoDecoder({
        output: function (frame) { drawFrame(tile, frame); },
        error: function (e) { console.error('[YKS] VideoDecoder:', e); }
      });

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
    tile.hasFrame = true;
    tile.el.classList.add('is-live');
  }

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
    if (document.fullscreenElement === tile.el) {
      document.exitFullscreen().catch(function () {  });
    }
    if (tile.decoder) { try { tile.decoder.close(); } catch (e) {  } }
    if (tile.audioCtx) { try { tile.audioCtx.close(); } catch (e) {  } }
    if (tile.el && tile.el.parentNode) tile.el.parentNode.removeChild(tile.el);
    delete state.tiles[key];
  }

  function updateGrid() {

    Object.keys(publishersByType).forEach(function (type) {
      var pub = publishersByType[type];
      var key = state.user.id + ':' + type;
      if (!state.tiles[key]) {
        var tile = createTile(state.user.id, type, state.user, true);

        tile.video.srcObject = pub.stream;
        tile.video.play().catch(function () {  });
        state.tiles[key] = tile;
      }
    });

    Object.keys(state.tiles).forEach(function (key) {
      var tile = state.tiles[key];
      if (tile.isLocal && !publishersByType[tile.type]) destroyTile(key);
    });

    var ordered = Object.keys(state.tiles).sort(function (a, b) {
      var ta = state.tiles[a], tb = state.tiles[b];
      if (ta.isLocal !== tb.isLocal) return ta.isLocal ? -1 : 1;
      return 0;
    });
    ordered.forEach(function (key) {
      var tile = state.tiles[key];
      if (tile.el.parentNode !== els.grid) els.grid.appendChild(tile.el);
    });

    var hasScreen = Object.keys(state.tiles).some(function (key) {
      return state.tiles[key].type === 'screen';
    });
    els.grid.classList.toggle('has-screen', hasScreen);

    var tileCount = els.grid.querySelectorAll('.tile').length;
    els.grid.classList.toggle('is-empty', tileCount === 0);
  }

  function updateRoster() {

    var list = [];
    if (state.user && state.user.id) {

      var selfStreams = {};
      Object.keys(publishersByType).forEach(function (type) { selfStreams[type] = { type: type }; });
      Object.keys(state.selfStreams).forEach(function (type) { selfStreams[type] = state.selfStreams[type]; });

      list.push({
        id: state.user.id,
        username: state.user.username,
        streams: selfStreams,
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
      empty.textContent = 'Vai tomar no cu piranha, ninguém entrou na sala ainda.';
      els.rosterList.appendChild(empty);
    }
  }

  function updateControls() {
    var screen = publishersByType.screen;

    els.btnScreen.classList.toggle('is-active', !!screen);
    els.btnScreen.setAttribute('aria-pressed', String(!!screen));
    els.btnScreen.querySelector('.ctl__label').textContent = screen ? 'Parar tela' : 'Compartilhar tela';
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

    if (!window.YKS_ERRORS.canCaptureHere()) {
      openCompanionTab();
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

  function leaveRoom() {
    if (state.left) return;
    state.left = true;

    Object.keys(publishersByType).forEach(function (type) { stopPublishing(type); });
    clearInterval(state.heartbeat);

    window.setTimeout(function () {

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
    var info = window.YKS_ERRORS.describeCaptureError(err);
    console.error('[YKS] captura:', err && err.name, err && err.message,
      '| podeCapturarAqui:', window.YKS_ERRORS.canCaptureHere());

    if (info.blocked) {

      showToast(info.msg, 'error', 8000);
      openCompanionTab();
      return;
    }

    showToast(info.msg + (info.hint ? ' ' + info.hint : ''), 'error', 8000);
  }

  function companionBaseUrl() {
    var configured = (CONFIG.activityUrl || '').trim();
    if (configured && configured !== 'SEU_URL_PUBLICADA') {
      return configured.replace(/\/+$/, '') + '/capture.html';
    }

    var dir = window.location.pathname.replace(/[^/]*$/, '');
    return window.location.origin + dir + 'capture.html';
  }

  function companionTransportUrls() {
    var brokers = CONFIG.brokerUrls.slice();

    return {
      kind: transportKind(),
      broker: brokers[0] || '',
      brokers: brokers,
      relay: 'wss://' + CONFIG.relayTarget,
      mqttPrefix: CONFIG.mqttPrefix,
      socketPath: CONFIG.socketIoPath
    };
  }

  function companionUrl() {
    var urls = companionTransportUrls();
    var q = new URLSearchParams();
    q.set('capture', '1');
    q.set('room', state.roomId || '');
    q.set('user', state.user.id || '');
    q.set('name', state.user.username || '');
    q.set('transport', urls.kind);
    q.set('broker', urls.broker);
    q.set('brokers', urls.brokers.join(','));
    q.set('relay', urls.relay);
    q.set('mqtt', urls.mqttPrefix);
    q.set('socketPath', urls.socketPath);

    var site = (CONFIG.activityUrl || '').trim();
    if (site && site !== 'SEU_URL_PUBLICIDA') q.set('site', site.replace(/\/+$/, ''));
    return companionBaseUrl() + '?' + q.toString();
  }

  function openCompanionTab() {
    var url = companionUrl();
    showToast('O Discord bloqueia a captura de tela dentro da Activity — abrindo uma aba no seu navegador.', 'info', 7000);

    if (state.sdk && state.sdk.commands && typeof state.sdk.commands.openExternalLink === 'function') {
      try {
        state.sdk.commands.openExternalLink({ url: url }).then(function () {
          showToast('Clique em "Compartilhar minha tela" na aba que abriu. Você pode voltar ao Discord.', 'success', 9000);
        }).catch(function (err) {
          console.warn('[YKS] openExternalLink falhou:', err);
          openCompanionFallback(url);
        });
        return;
      } catch (e) {
        console.warn('[YKS] openExternalLink indisponível:', e);
      }
    }

    openCompanionFallback(url);
  }

  function openCompanionFallback(url) {
    var win = null;
    try {
      win = window.open(url, '_blank', 'noopener');
    } catch (e) {
      win = null;
    }
    if (win) {
      showToast('Clique em "Compartilhar minha tela" na aba que abriu. Você pode voltar ao Discord.', 'success', 9000);
      return;
    }

    showToast('Não foi possível abrir a aba automaticamente. Abra o link abaixo para compartilhar a tela.', 'error', 12000);
    showCompanionLink(url);
  }

  function showCompanionLink(url) {
    var box = document.getElementById('companionLink');
    if (!box) return;
    var input = box.querySelector('input');
    if (input) input.value = url;
    box.hidden = false;
    if (input) input.select();
  }

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

  function transportErrorHint(detail) {
    var kind = transportKind();
    var extra = detail ? ' (' + detail + ')' : '';

    if (!IN_DISCORD_PROXY) {
      return 'Sem conexão com o transporte de mídia' + extra + '. Verifique a internet e, se usar o relay, se ele está no ar.';
    }
    if (kind === 'socketio') {
      return 'O proxy do Discord não conseguiu abrir o WebSocket do relay' + extra + '. ' +
        'Verifique o URL Mapping ' + RELAY_PREFIX + ' → ' + CONFIG.relayTarget +
        ' no Portal do Desenvolvedor (o relay precisa estar em HTTPS na porta 443).';
    }
    return 'O proxy do Discord não conseguiu abrir o WebSocket do broker' + extra + '. ' +
      'Verifique o URL Mapping ' + BROKER_PREFIX + ' → broker.emqx.io:8084 no Portal do ' +
      'Desenvolvedor (404 = prefixo não cadastrado). Se o proxy não aceitar destino com ' +
      'porta, use um relay próprio (?transport=socketio).';
  }

  function toggleFullscreen(tileEl) {
    if (!document.fullscreenEnabled) return;
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      tileEl.requestFullscreen().catch(function () {  });
    }
  }

  function bindControls() {
    els.btnScreen.addEventListener('click', toggleScreen);
    els.btnLeave.addEventListener('click', leaveRoom);
    if (els.copyRoomBtn) els.copyRoomBtn.addEventListener('click', copyRoomCode);

    var companionCopy = document.getElementById('companionCopy');
    if (companionCopy) {
      companionCopy.addEventListener('click', function () {
        var box = document.getElementById('companionLink');
        var input = box && box.querySelector('input');
        if (!input) return;
        input.select();
        var ok = false;
        try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
        if (!ok && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(input.value).then(function () {
            showToast('Link copiado.', 'success');
          }).catch(function () {
            showToast('Copie o link manualmente.', 'error');
          });
          return;
        }
        showToast(ok ? 'Link copiado.' : 'Copie o link manualmente.', ok ? 'success' : 'error');
      });
    }

    window.addEventListener('beforeunload', function () {
      Object.keys(publishersByType).forEach(function (type) { stopPublishing(type); });
      sendMeta({ t: 'bye', user: state.user });
    });

    document.addEventListener('fullscreenchange', function () {
      var full = !!document.fullscreenElement;
      document.querySelectorAll('.tile__fullscreen').forEach(function (btn) {
        btn.setAttribute('aria-checked', String(full));
        btn.textContent = full ? '✕' : '⛶';
      });
    });
  }

  function boot() {
    initSplash();
    bindControls();
    updateControls();
    updateRoster();
    updateGrid();

    startCompanionWatchdog();

    Promise.race([
      initDiscord(),
      new Promise(function (_, reject) {
        window.setTimeout(function () {
          reject(new Error('Timeout ao inicializar a Activity (initDiscord).'));
        }, 10000);
      })
    ])
      .then(function (sdk) {
        if (!sdk) {

          state.roomId = (params.get('room') || '').trim();
          if (!state.roomId) {
            setNetChip('err', 'Erro');
            showToast(
              'Não foi possível iniciar a Activity: não foi possível identificar a sala. Abra a Activity a partir de um canal de voz do Discord (a sala é o canal).',
              'error', 12000
            );
            return null;
          }
          setRoomChip('Sala ' + state.roomId);
          state.user = {
            id: (params.get('user') || '').trim() || ('web-' + randomId(8)),
            username: (params.get('name') || '').trim() || 'Visitante',
            avatar: null
          };
          return null;
        }
        return resolveRoom(sdk).then(function () { return sdk; });
      })
      .then(function (sdk) {
        if (!sdk) return null;
        return resolveUser(sdk).then(function () { return sdk; });
      })
      .then(function (sdk) {
        if (sdk) subscribeParticipants(sdk);
        updateRoster();

        if (!state.roomId) {
          setNetChip('err', 'Sem sala');
          showToast(
            'Não foi possível identificar a sala. Abra a Activity a partir de um canal de voz do Discord (a sala é o canal).',
            'error', 12000
          );
          return null;
        }

        setNetChip('warn', 'Conectando…');
        if (els.roomCode) els.roomCode.textContent = state.roomId;

        var warnedOutage = false;

        return preflightTransport(transportKind()).then(function () {
          state.transport = createTransport(state.roomId, {
            status: function (status, detail) {
              if (status === 'connected') {
                state.connected = true;
                warnedOutage = false;
                lastTransportError = null;
                els.netChip.title = '';
                setNetChip('ok', 'Conectado');
                startPresence();
              } else if (status === 'reconnecting') {
                state.connected = false;
                lastTransportError = detail;
                els.netChip.title = detail;
                setNetChip('warn', 'Reconectando…');
                if (!warnedOutage) {
                  warnedOutage = true;
                  showToast(transportErrorHint(detail), 'error', 12000);
                }
              } else if (status === 'error') {
                state.connected = false;
                lastTransportError = detail;
                els.netChip.title = detail;
                setNetChip('err', 'Sem conexão');
                console.error('[YKS] transporte:', detail);
                if (!warnedOutage) {
                  warnedOutage = true;
                  showToast(transportErrorHint(detail), 'error', 12000);
                }
              }
            },
            meta: onTransportMeta,
            media: handleRemoteMedia
          });
        });
      })
      .catch(function (err) {
        console.error('[YKS] falha na inicialização:', err);

        console.info('[YKS] diagnóstico:', JSON.stringify({
          clientId: CONFIG.clientId,
          origem: window.location.origin,
          host: window.location.host,
          proxy: IN_DISCORD_PROXY,
          dentroDeFrame: insideDiscordFrame(),
          sala: state.roomId,
          mock: CONFIG.mock
        }));
        setNetChip('err', 'Erro');

        var detail = (err && err.status) ? describeInitError(err) : ((err && err.message) || err);
        lastTransportError = detail;
        els.netChip.title = detail;
        showToast(
          'Não foi possível iniciar a Activity: ' + detail,
          'error', 12000
        );
      });
  }

  window.__yks.companionUrl = companionUrl;
  window.__yks.canCaptureHere = window.YKS_ERRORS.canCaptureHere;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
