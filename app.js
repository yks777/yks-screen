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

  /* ----------------------------------------------------------------------
   * Prefixos dos URL Mappings (Portal do Desenvolvedor > Activities).
   * O prefixo é a parte que o proxy do Discord usa para decidir para onde
   * encaminhar a requisição. O TARGET é sempre um HOST (sem protocolo) e
   * pode ter porta (ex.: broker.emqx.io:8084) — quem fala com o destino é o
   * proxy, não o navegador.
   * -------------------------------------------------------------------- */
  var SDK_PREFIX = '/sdk';
  var BROKER_PREFIX = (params.get('brokerPrefix') || '/broker').trim();
  var RELAY_PREFIX = (params.get('relayPrefix') || '/relay').trim();

  /* Host público do relay (sem protocolo e sem porta: o proxy do Discord só
     fala com destinos na 443). */
  var RELAY_TARGET = (params.get('relay') || 'relay.exemplo.com').trim();
  var HAS_RELAY = !!RELAY_TARGET && RELAY_TARGET !== 'relay.exemplo.com' &&
    RELAY_TARGET !== 'SEU_RELAY';

  var CONFIG = {
    /* Application ID do Discord (OAuth2 Client ID) — Portal do Desenvolvedor
       > General Information > Application ID. */
    clientId: params.get('clientId') || '1562645997308481539',

    /* URL REAL do site publicado (ex.: https://seu-user.github.io/yks-screen/).
       É usada para abrir a aba companheira de compartilhamento de tela: ela
       precisa rodar FORA do iframe do Discord, onde a captura de tela é
       permitida. Vazio = usa a origem atual (a do proxy do Discord). */
    activityUrl: params.get('activityUrl') || 'https://yks777.github.io/yks-screen',

    /* ------------------------------------------------------------------
     * URL Mappings (Portal do Desenvolvedor > Activities > URL Mappings)
     *   PREFIX     | TARGET
     *   /          | seu-app.exemplo.com   <- a própria Activity
     *   /sdk       | cdn.jsdelivr.net       <- SDK do Discord
     *   /broker    | broker.emqx.io:8084   <- broker MQTT (WSS)   [opcional]
     *   /relay     | relay.exemplo.com      <- relay próprio       [opcional]
     *
     * O TARGET é sempre um HOST (sem protocolo) e precisa apontar para um
     * diretório. O patchUrlMappings() do SDK reescreve
     *   wss://broker.emqx.io:8084/mqtt
     *     -> wss://<client_id>.discordsays.com:8084/broker/mqtt
     * e o proxy do Discord encaminha para o broker real.
     *
     * ATENÇÃO (porta): a CSP do proxy do Discord só autoriza WebSocket em
     *   wss://<client_id>.discordsays.com/  (porta 443)
     * Logo, a URL que o BROWSER abre precisa ser SEM porta — é o que o
     * transporte faz agora (monta a URL do proxy na 443). O TARGET pode
     * manter a porta (broker.emqx.io:8084) porque quem fala com o broker
     * é o proxy, não o browser.
     * ------------------------------------------------------------------ */
    urlMappings: [
      { prefix: SDK_PREFIX, target: 'cdn.jsdelivr.net' },
      { prefix: BROKER_PREFIX, target: 'broker.emqx.io:8084' }
    ].concat(HAS_RELAY ? [{ prefix: RELAY_PREFIX, target: RELAY_TARGET }] : []),

    /* ------------------------------------------------------------------
     * Transporte: '' = automático | 'mqtt' | 'socketio'
     *
     * Automático: 'mqtt' (broker público) fora do Discord; dentro do
     * proxy do Discord o broker público só funciona se o Portal tiver o
     * URL Mapping /broker — o transporte monta a URL do PROXY (porta 443),
     * que é a única que a CSP do proxy aceita.
     * ------------------------------------------------------------------ */
    transport: (params.get('transport') || '').trim(),

    /* Brokers MQTT públicos (WSS). Nenhum cadastro, nenhuma chave.
       O primeiro que responder é usado; os outros são fallback.
       (?broker=... permite apontar para outro broker.) */
    brokerUrls: (params.get('broker') ? [params.get('broker')] : []).concat([
      'wss://broker.emqx.io:8084/mqtt',
      'wss://broker.hivemq.com:8884/mqtt'
    ]),
    /* Prefixo dos tópicos MQTT. */
    mqttPrefix: 'yks',

    /* Relay Socket.IO (usado com transport=socketio).
       relayTarget = HOST público do relay, SEM porta (tem que estar em 443
       para o proxy do Discord conseguir falar com ele). */
    relayTarget: RELAY_TARGET,
    socketIoPath: params.get('socketPath') || '/ws',

    /* Fontes do SDK: 1ª = via URL Mapping (funciona no Discord),
       2ª = CDN direto (funciona em desenvolvimento local).
       Dentro do Discord a 2ª é SEMPRE bloqueada pela CSP do proxy
       (script-src não inclui cdn.jsdelivr.net) — ela existe só para o
       desenvolvimento local. */
    sdkSources: [
      SDK_PREFIX + '/npm/@discord/embedded-app-sdk@2.5.0/output/index.mjs',
      'https://cdn.jsdelivr.net/npm/@discord/embedded-app-sdk@2.5.0/output/index.mjs'
    ],
    /* Cliente do Socket.IO: cópia local (vendor/) — assim o transporte
       'socketio' não depende de CDN nem de URL Mapping extra. O CDN fica
       como último recurso. */
    socketIoSources: [
      'vendor/socket.io.min.js',
      '/socketio/4.8.4/socket.io.min.js',
      'https://cdn.socket.io/4.8.4/socket.io.min.js'
    ],

    /* Modo simulado: usa o DiscordSDKMock do SDK oficial, permitindo rodar
       e testar a Activity fora do Discord (?mock=1&channel=ID&user=ID). */
    mock: params.get('mock') === '1',
    mockChannelId: params.get('channel') || '999888777666555444',
    mockUserId: params.get('user') || '111222333444555666',
    mockUserName: params.get('name') || 'Visitante',

    /* --- mídia (config.js — compartilhado com a aba companheira) --- */
    video: window.YKS_MEDIA.video,
    audio: window.YKS_MEDIA.audio,

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
    left: false,

    /* Identidade DESTA aba. O eco das próprias mensagens é descartado pelo
       `sid`, e não pelo userId: a aba companheira publica com o MESMO
       userId do usuário e precisa chegar até a Activity. */
    sid: (window.YKS_FRAMES ? window.YKS_FRAMES.randomId(12) : String(Date.now())),

    /* Publicações feitas pelo MESMO usuário em outra aba (aba companheira):
       { 'screen': { lastSeen } } — aparece no roster como "você" e vira um
       tile remoto. */
    selfCompanion: {},

    /* Tipos publicados pelo próprio usuário em outra aba (para o roster). */
    selfStreams: {}
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

  /* Id aleatório curto (compartilhado com frames.js). */
  function randomId(len) {
    return window.YKS_FRAMES.randomId(len);
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

  /* Carrega o SDK (ESM) via import() dinâmico, tentando as fontes em ordem.

     Cada falha é guardada: sem isso, o erro mostrado é sempre o da ÚLTIMA
     fonte (o CDN direto), que dentro do Discord é bloqueado pela CSP do
     proxy — ou seja, a mensagem aponta para o lado errado do problema.
     A fonte que realmente falhou (o URL Mapping /sdk) fica escondida. */
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

  /* Confere ANTES do import se o URL Mapping do SDK existe.

     Um import que dá 404 e um import bloqueado pela CSP dão a MESMA
     mensagem ("Failed to fetch dynamically imported module"). Esta sondagem
     distingue os dois casos: o proxy responde 404 quando o prefixo não
     está cadastrado no Portal do Desenvolvedor. */
  function preflightSdk() {
    if (!IN_DISCORD_PROXY) return Promise.resolve(null);

    var url = CONFIG.sdkSources[0];
    return fetch(url, { method: 'GET', cache: 'no-store' }).then(function (res) {
      if (res.status === 404) {
        var error = new Error('URL Mapping do SDK ausente');
        error.status = 404;
        error.kind = 'sdk';
        error.url = url;
        throw error;
      }
      return null;
    }).catch(function (err) {
      /* Só o 404 é conclusivo: rede instável não deve impedir o import. */
      if (err && err.status === 404) throw err;
      return null;
    });
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

  /* Estamos dentro de um frame? A Activity do Discord sempre roda dentro de
     um iframe (no proxy ou no cliente web). Fora dele, o app funciona como
     site comum (sala pela URL). */
  function insideDiscordFrame() {
    return /\.discordsays\.com$/.test(window.location.hostname) || window.parent !== window;
  }

  function initDiscord() {
    /* Fora do Discord (site aberto direto no navegador) e com ?room= na URL,
       a Activity funciona como site comum: não há handshake a fazer e nada a
       sincronizar com o cliente do Discord. */
    if (!CONFIG.mock && !insideDiscordFrame() && (params.get('room') || '').trim()) {
      return Promise.resolve(null);
    }

    return preflightSdk()
      .then(function () { return loadSdk(CONFIG.sdkSources); })
      .then(function (sdk) {
        /* --------------------------------------------------------------
         * patchUrlMappings(): DEVE ser chamado ANTES de qualquer requisição
         * para um domínio externo. Ele reescreve window.fetch,
         * window.WebSocket e XMLHttpRequest.open para que as URLs mapeadas
         * passem pelo proxy do Discord em vez de serem bloqueadas por CSP
         * ("blocked:csp").
         *
         * Aqui o WebSocket NÃO é patcheado de propósito: o remapeamento do
         * SDK mantém a porta da URL original (wss://broker.emqx.io:8084 ->
         * wss://<client_id>.discordsays.com:8084/...) e a CSP do proxy só
         * autoriza a porta 443 do próprio proxy. O transporte monta a URL
         * do proxy na 443 por conta própria (ver transport.js).
         * -------------------------------------------------------------- */
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
      }).catch(function (err) {
        throw new Error(describeInitError(err));
      });
  }

  /* Transforma o erro bruto de inicialização em uma mensagem acionável. */
  function describeInitError(err) {
    var msg = (err && err.message) || String(err);

    /* A causa mais comum não é o Application ID — é a versão antiga do
       app.js servida (cache do navegador ou publicação atrasada). Por isso a
       mensagem mostra o valor EFETIVO: se aparecer o placeholder, é a
       versão velha; se aparecer o ID, o problema é outro. */
    if (!CONFIG.clientId || CONFIG.clientId === 'SEU_CLIENT_ID') {
      return 'Application ID do Discord não configurado (valor atual: "' +
        (CONFIG.clientId || 'vazio') + '"). Atualize o app.js publicado e recarregue ' +
        'sem cache (Ctrl+Shift+R).';
    }

    /* O proxy do Discord respondeu 404 para o caminho do SDK: o URL Mapping
       /sdk não está cadastrado (ou foi salvo sem "salvar"). */
    if (err && err.status === 404 && err.kind === 'sdk') {
      return 'O URL Mapping do SDK não está configurado: o proxy do Discord devolveu 404 para ' +
        (err.url || CONFIG.sdkSources[0]) + '. No Portal do Desenvolvedor > Activities > ' +
        'URL Mappings, cadastre PREFIX ' + SDK_PREFIX + ' | TARGET cdn.jsdelivr.net e salve.';
    }

    /* Idem para o transporte: o prefixo /broker (ou /relay) não existe. */
    if (err && err.status === 404) {
      var prefix = err.kind === 'mqtt' ? BROKER_PREFIX : RELAY_PREFIX;
      var target = err.kind === 'mqtt' ? 'broker.emqx.io:8084' : CONFIG.relayTarget;
      return 'O URL Mapping do transporte não está configurado: o proxy do Discord devolveu 404 para ' +
        (err.url || prefix) + '. No Portal do Desenvolvedor > Activities > URL Mappings, cadastre ' +
        'PREFIX ' + prefix + ' | TARGET ' + target + ' e salve.';
    }

    /* Falha de import: mostra o que foi tentado e por quê. */
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

  /* Detalha as falhas de carregamento do SDK, fonte por fonte. */
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

  /* Aplica as URL Mappings (helper isolado para tratamento de erro).
     O WebSocket não é patcheado: o remapeamento do SDK preserva a porta da
     URL original e a CSP do proxy só aceita a porta 443 do proxy. */
  function patchUrlMappings(sdk, mappings) {
    sdk.patchUrlMappings(mappings, { patchWebSocket: false });
  }

  /* Descobre o canal de voz atual e o transforma no ID da sala. */
  function resolveRoom(sdk) {
    state.sdk = sdk;

    /* channelId = o canal (de voz) onde a Activity foi aberta.
       É ele que define a sala: quem abrir a Activity no mesmo canal
       entra na mesma sala. */
    var channelId = sdk.channelId || (CONFIG.mock ? CONFIG.mockChannelId : null);
    /* Fora do Discord (uso como site comum) a sala vem da URL. */
    var manualRoom = (params.get('room') || '').trim();

    if (!channelId && !manualRoom) {
      throw new Error('Não foi possível identificar o canal de voz. Abra a Activity a partir de um canal de voz (a sala é o canal).');
    }

    state.roomId = String(channelId || manualRoom);
    state.guildId = sdk.guildId;
    setRoomChip('Sala ' + state.roomId);

    /* Sem canal não há o que consultar no Discord. */
    if (!channelId) return Promise.resolve(state.roomId);

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

  /* --- Transporte (implementação em transport.js) ----------------------- */

  /* Qual transporte usar.
     - 'mqtt'     : broker MQTT público (funciona fora do Discord e dentro
                    do Discord SE o Portal tiver o URL Mapping /broker).
     - 'socketio' : relay próprio (funciona dentro do Discord desde que o
                    relay esteja numa URL https/wss na porta 443 e o Portal
                    tenha o URL Mapping /relay).
     Automático: 'mqtt' por padrão; 'socketio' quando o relay está
     configurado (parâmetro ?relay=host ou CONFIG.relayTarget). */
  function transportKind() {
    if (CONFIG.transport) return CONFIG.transport;
    if (hasRelay()) return 'socketio';
    return 'mqtt';
  }

  /* O relay está configurado? (host público diferente do placeholder) */
  function hasRelay() {
    return HAS_RELAY;
  }

  /* Endpoint do relay.
     Dentro do Discord o WebSocket tem que apontar para o PRÓPRIO proxy do
     Discord, na porta 443 (é o que a CSP permite) e com o prefixo do URL
     Mapping na frente (/relay/ws -> o proxy encaminha para <host>/ws).
     Fora do Discord, o relay público é acessado direto. */
  function relayEndpoint() {
    if (IN_DISCORD_PROXY) {
      return {
        url: 'wss://' + window.location.host,
        path: RELAY_PREFIX + CONFIG.socketIoPath
      };
    }
    /* Desenvolvimento local: relay na máquina, sem TLS.
       (?devRelay=ws://localhost:8080/ws) */
    var devRelay = (params.get('devRelay') || '').trim();
    if (/^(wss?|https?):\/\//i.test(devRelay)) {
      return {
        url: devRelay.replace(/\/+$/, '').replace(/\/ws$/, ''),
        path: CONFIG.socketIoPath
      };
    }
    return { url: 'wss://' + CONFIG.relayTarget, path: CONFIG.socketIoPath };
  }

  /* Confere ANTES de abrir o WebSocket se o URL Mapping do transporte
     existe no Portal do Desenvolvedor.

     Sem isso o app fica em "Reconectando…" para sempre: o proxy do Discord
     responde 404 em qualquer prefixo que não esteja cadastrado, e o
     WebSocket só reporta "handshake falhou". Uma requisição HTTP comum no
     mesmo caminho revela o 404 na hora. */
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
      /* Só o 404 é conclusivo (rede instável não deve travar o app). */
      if (err && err.status === 404) throw err;
      return null;
    });
  }

  /* Cria o transporte da sala. */
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
      /* Dentro do proxy do Discord o WebSocket vai para a porta 443 do
         proxy (única autorizada pela CSP). Fora, vai direto ao destino. */
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
    /* Ignora as próprias mensagens (o broker retransmite o que publicamos).
       O filtro é pelo `sid` (esta aba), e não pelo userId: a aba companheira
       publica com o MESMO userId do usuário e precisa chegar aqui. */
    if (meta.sid) {
      if (meta.sid === state.sid) return;
    } else if (meta.user.id === state.user.id) {
      /* Cliente antigo (sem sid): o filtro por usuário evita o eco. */
      return;
    }
    stats.metaIn++;
    stats.lastMeta.push(meta.t + ':' + meta.user.username);
    if (stats.lastMeta.length > 12) stats.lastMeta.shift();

    /* Publicação do MESMO usuário em outra aba (aba companheira). */
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
      /* Responde para que o novo participante também nos conheça.
         (O par se apresenta no máximo 2x — sem loop.) */
      if (!peer.greeted) {
        peer.greeted = true;
        sendMeta({ t: 'hello', user: state.user });

        /* Reanuncia o que já está no ar: quem acabou de chegar não pode
           ficar sem tile até o transmissor parar e voltar a transmitir. */
        Object.keys(publishersByType).forEach(function (type) {
          announceStream(publishersByType[type]);
        });
        /* Mesmo para quem publica em outra aba (a companheira). */
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
      /* Um participante que acabou de chegar precisa de um quadro completo
         para decodificar — pedimos um keyframe imediato. */
      if (publishersByType[meta.type]) {
        window.YKS_BROADCAST.requestKeyFrame(meta.type);
      }
      return;
    }
  }

  /* Mensagens do MESMO usuário vindas de outra aba (a aba companheira).
     Não viram participantes no roster — o usuário já aparece como "você" —
     mas viram tiles e marcam a presença na lista de streams. */
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
      /* Só remove o tile se ele NÃO for local: a mesma pessoa não publica
         a tela nos dois lugares ao mesmo tempo. */
      var key = state.user.id + ':' + type;
      var tile = state.tiles[key];
      if (tile && !tile.isLocal) destroyTile(key);
      updateRoster();
      updateGrid();
    }
  }

  /* Se o tile não recebeu nenhum quadro em 1,5 s, pede um keyframe: sem
     isso quem chega no meio da transmissão ficaria com a tela preta até o
     próximo keyframe (que só vem a cada 4 s). */
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

  /* A aba companheira manda "ping" enquanto está viva. Se parar de mandar
     (o usuário fechou a aba do navegador), o tile dela some sozinho. */
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

  /* Publica uma MediaStream capturada (implementação em broadcast.js). */
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
      isMuted: function () { return state.muted; },
      onState: function (kind, msg) {
        if (kind === 'error') showToast(msg, 'error', 7000);
      },
      onStopped: function (stoppedType) {
        /* Encerra a publicação local: avisa a sala e limpa a UI. */
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

  /* Mensagem do próximo stopPublishing (evita toast duplicado). */
  var pendingStopMessage = null;

  function stopPublishing(type, message) {
    if (!publishersByType[type]) return;
    pendingStopMessage = message || 'O compartilhamento foi encerrado.';
    window.YKS_BROADCAST.stop(type);
  }

  /* ======================================================================
   * 10. RECEPÇÃO DE MÍDIA (WebSocket -> WebCodecs -> canvas)
   * ====================================================================== */

  function handleRemoteMedia(meta, bytes) {
    if (!meta || !meta.userId) return;
    /* Ignora o próprio eco (o broker retransmite o que publicamos).
       O filtro é pelo `sid`: a aba companheira publica com o mesmo userId
       e precisa ser exibida aqui. */
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
      hasFrame: false,
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
    tile.hasFrame = true;
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
      /* Streams publicados pelo próprio usuário: os locais (nesta aba) e os
         feitos em outra aba (a aba companheira de compartilhamento). */
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

    /* O Discord carrega a Activity num iframe SEM "allow=display-capture".
       Nesses casos o Chromium rejeita a captura com NotAllowedError antes de
       qualquer prompt — e nenhuma permissão do navegador resolve. Detectamos
       isso antes de tentar e abrimos a aba companheira, que roda fora do
       iframe (onde a captura funciona). */
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
    var info = window.YKS_ERRORS.describeCaptureError(err);
    console.error('[YKS] captura:', err && err.name, err && err.message,
      '| podeCapturarAqui:', window.YKS_ERRORS.canCaptureHere());

    if (info.blocked) {
      /* Bloqueio por política de frame: a saída é a aba companheira. */
      showToast(info.msg, 'error', 8000);
      openCompanionTab();
      return;
    }

    showToast(info.msg + (info.hint ? ' ' + info.hint : ''), 'error', 8000);
  }

  /* ======================================================================
   * 14. ABA COMPANHEIRA DE COMPARTILHAMENTO
   * --------------------------------------------------------------------------
   * Dentro do Discord não é possível capturar a tela: o iframe das Activities
   * não recebe "allow=display-capture" e o Chromium bloqueia a Screen Capture
   * API (NotAllowedError / "disallowed by permissions policy").
   *
   * A saída é capturar FORA do iframe, numa aba normal do navegador, e
   * publicar os frames pelo mesmo transporte da sala. Quem assiste continua
   * no Discord; só quem mostra sai.
   * ====================================================================== */

  /* URL base da aba companheira: o site real (CONFIG.activityUrl) quando
     configurado — fora do proxy do Discord, a CSP não atrapalha — ou a
     origem atual. Aponta sempre para capture.html, a página de captura. */
  function companionBaseUrl() {
    var configured = (CONFIG.activityUrl || '').trim();
    if (configured && configured !== 'SEU_URL_PUBLICADA') {
      return configured.replace(/\/+$/, '') + '/capture.html';
    }
    /* mesmo diretório do app atual, mas a página de captura */
    var dir = window.location.pathname.replace(/[^/]*$/, '');
    return window.location.origin + dir + 'capture.html';
  }

  /* URL efetiva do broker/relay que a Activity está usando AGORA.

     A aba companheira roda FORA do proxy do Discord (numa aba normal do
     navegador), então ela fala DIRETO com o broker público ou com o relay
     público — nunca com o proxy (que é um host do Discord, e o caminho
     /broker/mqtt do proxy exigiria passar pelo mesmo CSP). O importante é
     que ambos os lados cheguem ao MESMO destino lógico (o mesmo broker ou o
     mesmo relay), para que a sala seja a mesma. */
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

  /* Monta a URL da aba companheira com a identidade da sala. */
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
    /* URL do site real: a aba companheira PRECISA ser aberta nele (a CSP do
       proxy do Discord bloqueia o WebSocket do broker). */
    var site = (CONFIG.activityUrl || '').trim();
    if (site && site !== 'SEU_URL_PUBLICIDA') q.set('site', site.replace(/\/+$/, ''));
    return companionBaseUrl() + '?' + q.toString();
  }

  /* Abre a aba companheira no navegador do usuário. */
  function openCompanionTab() {
    var url = companionUrl();
    showToast('O Discord bloqueia a captura de tela dentro da Activity — abrindo uma aba no seu navegador.', 'info', 7000);

    /* 1) API do Discord: abre no navegador padrão (fora do sandbox). */
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

  /* 2) Sem o SDK do Discord: abre uma janela nova. 3) Último recurso: mostra
     o link para o usuário abrir e copiar. */
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

  /* Mostra o link da aba companheira para copiar (e abrir à mão). */
  function showCompanionLink(url) {
    var box = document.getElementById('companionLink');
    if (!box) return;
    var input = box.querySelector('input');
    if (input) input.value = url;
    box.hidden = false;
    if (input) input.select();
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

  /* Explica a falha de transporte do jeito mais provável de cada cenário.

     Dentro do proxy do Discord a causa quase sempre é a CSP do proxy:
     ele só autoriza WebSocket em wss://<client_id>.discordsays.com/ (443).
     O remapeamento do SDK mantém a porta do destino (wss://broker:8084 ->
     wss://<client_id>.discordsays.com:8084/...), e essa URL é bloqueada.
     Por isso o transporte monta a URL do proxy na 443. */
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

  function bindControls() {
    els.btnScreen.addEventListener('click', toggleScreen);
    els.btnCam.addEventListener('click', toggleCamera);
    els.btnMic.addEventListener('click', toggleMic);
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
  }

  function boot() {
    initSplash();
    bindControls();
    updateControls();
    updateRoster();
    updateGrid();   /* estado inicial: nenhum tile -> mostra o estado vazio */

    startCompanionWatchdog();

    initDiscord()
      .then(function (sdk) {
        if (!sdk) {
          /* Fora do Discord (site aberto direto): sala e usuário vêm da URL. */
          state.roomId = (params.get('room') || '').trim();
          if (!state.roomId) {
            throw new Error('Informe a sala com ?room=CODIGO (ou abra a Activity dentro do Discord).');
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
        updateRoster();          /* agora já sabemos quem é o próprio usuário */
        setNetChip('warn', 'Conectando…');
        if (els.roomCode) els.roomCode.textContent = state.roomId;

        /* Conecta ao transporte (broker MQTT público ou relay próprio). */
        var warnedOutage = false;

        return preflightTransport(transportKind()).then(function () {
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
                  showToast(transportErrorHint(detail), 'error', 12000);
                }
              } else if (status === 'error') {
                state.connected = false;
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
        /* Diagnóstico: mostra qual versão do app está rodando de fato. */
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
        /* Erros de configuração (404 de URL Mapping) têm mensagem própria;
           os demais usam a mensagem original. */
        var detail = (err && err.status) ? describeInitError(err) : ((err && err.message) || err);
        showToast(
          'Não foi possível iniciar a Activity: ' + detail,
          'error', 12000
        );
      });
  }

  /* Ganchos de depuração (console do navegador). */
  window.__yks.companionUrl = companionUrl;
  window.__yks.canCaptureHere = window.YKS_ERRORS.canCaptureHere;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
