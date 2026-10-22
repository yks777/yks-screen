/* ==========================================================================
 * YKS-Screen — transportes de mídia
 * --------------------------------------------------------------------------
 * Duas implementações, mesma interface:
 *
 *   'mqtt'      (padrão) broker MQTT público — 100% estático, sem servidor;
 *   'socketio'  (opcional) relay próprio (relay/server.js).
 *
 *   YKS_TRANSPORT.create({
 *     kind, room, user, guildId,
 *     mqttPrefix, brokerUrls,
 *     relayUrl, socketPath, socketIoSources,
 *     subscribeMedia,      // false = não recebe o fluxo de vídeo de volta
 *     stats,
 *     onStatus(status, detail), onMeta(meta), onMedia(meta, bytes)
 *   })
 *
 * O transporte é um "bus" burro: não entende nada do conteúdo, só repassa.
 * ========================================================================== */

(function () {
  'use strict';

  var F = window.YKS_FRAMES;

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

  /* Normaliza o payload binário do Socket.IO. Em alguns ambientes ele chega
     como Blob, e "new Uint8Array(blob)" resultaria num array VAZIO (sem erro
     visível — só a mídia que nunca apareceria). */
  function toBytes(buffer, done) {
    if (!buffer) return done(new Uint8Array(0));
    if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(buffer)) return done(buffer);
    if (typeof Blob !== 'undefined' && buffer instanceof Blob) {
      return buffer.arrayBuffer().then(function (buf) { done(new Uint8Array(buf)); },
        function () { done(new Uint8Array(0)); });
    }
    if (typeof buffer.byteLength === 'number') return done(new Uint8Array(buffer));
    return done(new Uint8Array(0));
  }

  /* --- Transporte MQTT (padrão): broker público, sem servidor próprio ---- */
  function createMqttTransport(opts) {
    var topicBase = opts.mqttPrefix + '/' + opts.room;
    var urls = opts.brokerUrls.slice();
    var client = null;
    var subscribeMedia = opts.subscribeMedia !== false;

    /* Dentro do proxy do Discord o browser NÃO pode falar direto com o
       broker: a CSP do proxy só autoriza WebSocket em
       wss://<client_id>.discordsays.com/ (porta 443). Por isso, quando o
       proxyBase vem preenchido, a URL do WebSocket é a do PRÓPRIO proxy,
       com o prefixo do URL Mapping na frente:

         wss://<client_id>.discordsays.com/broker/mqtt
           -> o proxy encaminha para broker.emqx.io:8084/mqtt

     (o remapeamento automático do SDK não serve aqui: ele preserva a porta
     do destino e a CSP bloqueia tudo que não seja a porta 443 do proxy). */
    if (opts.proxyBase && opts.proxyPath) {
      urls = [opts.proxyBase.replace(/\/+$/, '') + opts.proxyPath + '/mqtt'];
    }

    function connectNext() {
      var url = urls.shift();
      if (!url) {
        opts.onStatus('error', 'Nenhum broker MQTT disponível');
        return;
      }

      /* Quantas falhas seguidas este broker acumulou. O cliente MQTT só
         reporta "reconnecting" quando o handshake falha (nunca "error"),
         então sem contar as falhas o app ficava preso no PRIMEIRO broker da
         lista — que, dentro do Discord, é a URL do proxy. */
      var failures = 0;

      client = new window.MqttClient({
        url: url,
        clientId: 'yks-' + F.randomId(10),
        keepalive: 30,
        onStatus: function (status, detail) {
          if (status === 'connected') {
            failures = 0;
            if (subscribeMedia) client.subscribe(topicBase + '/media');
            client.subscribe(topicBase + '/ctrl');
            opts.onStatus('connected', url);
          } else if (status === 'reconnecting') {
            failures++;
            opts.onStatus('reconnecting', detail);
            /* Duas falhas seguidas e ainda há broker na lista: tenta o
               próximo. */
            if (failures >= 2 && urls.length) {
              try { client.disconnect(); } catch (e) { /* ignora */ }
              connectNext();
            }
          } else if (status === 'error') {
            opts.onStatus('error', detail);
            /* tenta o próximo broker */
            if (url) connectNext();
          }
        },
        onMessage: function (topic, bytes) {
          if (topic === topicBase + '/ctrl') {
            var meta;
            try { meta = JSON.parse(F.textDecoder.decode(bytes)); } catch (e) { return; }
            opts.onMeta(meta);
          } else if (topic === topicBase + '/media') {
            var frame = F.decodeFrame(bytes);
            opts.onMedia(frame.meta, frame.payload);
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
        if (opts.stats) opts.stats.metaOut++;
        client.publish(topicBase + '/ctrl', F.textEncoder.encode(JSON.stringify(meta)));
      },
      /* Versão confiável (QoS 1): espera o PUBACK do broker. Usada na
         mensagem de saída, que não pode se perder. */
      sendMetaAck: function (meta) {
        if (!client) return Promise.resolve(false);
        if (opts.stats) opts.stats.metaOut++;
        return client.publishAck(topicBase + '/ctrl', F.textEncoder.encode(JSON.stringify(meta)), 5000)
          .catch(function () { return false; });
      },
      sendMedia: function (meta, payload) {
        if (!client) return;
        if (opts.stats) opts.stats.bytesOut += payload.length;
        client.publish(topicBase + '/media', F.encodeFrame(meta, payload));
      },
      close: function () { if (client) client.disconnect(); }
    };
  }

  /* --- Transporte Socket.IO (opcional): relay próprio ------------------- */
  function createSocketIoTransport(opts) {
    var socket = null;

    loadScript(opts.socketIoSources, 'io').then(function () {
      if (typeof window.io !== 'function') throw new Error('Socket.IO indisponível.');

      /* relayUrl = origem (ex.: wss://<client_id>.discordsays.com) e
         socketPath = caminho completo do Socket.IO (ex.: /relay/ws).
         Dentro do proxy, o prefixo /relay faz o proxy encaminhar para
         <host>/ws — é o mesmo relay, visto do outro lado. */
      socket = window.io(opts.relayUrl, {
        path: opts.socketPath,
        transports: ['websocket'],
        reconnection: true,
        reconnectionDelay: 1500,
        auth: { roomId: opts.room, guildId: opts.guildId, user: opts.user }
      });

      socket.on('connect', function () { opts.onStatus('connected'); });
      socket.on('disconnect', function (r) { opts.onStatus('reconnecting', r); });
      socket.on('connect_error', function (e) { opts.onStatus('error', e && e.message); });
      socket.on('meta', function (meta) { opts.onMeta(meta); });
      socket.on('media', function (meta, buffer) {
        toBytes(buffer, function (bytes) { opts.onMedia(meta, bytes); });
      });
    }).catch(function (e) {
      opts.onStatus('error', e && e.message);
    });

    return {
      kind: 'socketio',
      sendMeta: function (meta) {
        if (!socket) return;
        if (opts.stats) opts.stats.metaOut++;
        socket.emit('meta', meta);
      },
      /* O relay não implementa confirmação de entrega. */
      sendMetaAck: function () { return Promise.resolve(false); },
      sendMedia: function (meta, payload) {
        if (!socket) return;
        if (opts.stats) opts.stats.bytesOut += payload.length;
        socket.emit('media', meta, payload.buffer);
      },
      close: function () { if (socket) socket.disconnect(); }
    };
  }

  function create(opts) {
    if (opts.kind === 'socketio') return createSocketIoTransport(opts);
    return createMqttTransport(opts);
  }

  window.YKS_TRANSPORT = {
    create: create,
    loadScript: loadScript
  };
})();
