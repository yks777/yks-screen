(function () {
  'use strict';

  var F = window.YKS_FRAMES;

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

  function createMqttTransport(opts) {
    var topicBase = opts.mqttPrefix + '/' + opts.room;
    var urls = opts.brokerUrls.slice();
    var client = null;
    var subscribeMedia = opts.subscribeMedia !== false;

    if (opts.proxyBase && opts.proxyPath) {
      urls = [opts.proxyBase.replace(/\/+$/, '') + opts.proxyPath + '/mqtt'];
    }

    var totalFailures = 0;
    var maxFailures = 5;

    function connectNext() {
      var url = urls.shift();
      if (!url) {
        if (totalFailures >= maxFailures) {
          opts.onStatus('error', 'Nenhum broker MQTT disponível');
          return;
        }
        opts.onStatus('error', 'Nenhum broker MQTT disponível');
        return;
      }

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
            totalFailures++;
            opts.onStatus('reconnecting', detail);

            if (totalFailures >= maxFailures) {
              try { client.disconnect(); } catch (e) {  }
              opts.onStatus('error', 'Falha ao conectar ao transporte de mídia após várias tentativas.');
              return;
            }

            if (failures >= 2 && urls.length) {
              try { client.disconnect(); } catch (e) {  }
              connectNext();
            }
          } else if (status === 'error') {
            opts.onStatus('error', detail);

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

  function createSocketIoTransport(opts) {
    var socket = null;

    loadScript(opts.socketIoSources, 'io').then(function () {
      if (typeof window.io !== 'function') throw new Error('Socket.IO indisponível.');

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
