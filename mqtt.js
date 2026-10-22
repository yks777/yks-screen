(function (global) {
  'use strict';

  var PKT = {
    CONNECT: 1, CONNACK: 2, PUBLISH: 3, PUBACK: 4,
    SUBSCRIBE: 8, SUBACK: 9, UNSUBSCRIBE: 10, UNSUBACK: 11,
    PINGREQ: 12, PINGRESP: 13, DISCONNECT: 14
  };

  var encoder = new TextEncoder();
  var decoder = new TextDecoder();

  function encodeLength(len) {
    var bytes = [];
    do {
      var digit = len % 128;
      len = Math.floor(len / 128);
      if (len > 0) digit = digit | 0x80;
      bytes.push(digit);
    } while (len > 0);
    return new Uint8Array(bytes);
  }

  function encodeString(str) {
    var raw = encoder.encode(str);
    var out = new Uint8Array(2 + raw.length);
    new DataView(out.buffer).setUint16(0, raw.length);
    out.set(raw, 2);
    return out;
  }

  function concat(chunks) {
    var total = 0;
    for (var i = 0; i < chunks.length; i++) total += chunks[i].length;
    var out = new Uint8Array(total);
    var offset = 0;
    for (var j = 0; j < chunks.length; j++) { out.set(chunks[j], offset); offset += chunks[j].length; }
    return out;
  }

  function MqttClient(options) {
    options = options || {};
    this.url = options.url;
    this.clientId = options.clientId || ('yks-' + Math.random().toString(36).slice(2, 10));
    this.keepalive = options.keepalive || 30;

    this.protocols = options.protocols === null ? [] : ['mqtt'];

    this.onStatus = options.onStatus || function () {};
    this.onMessage = options.onMessage || function () {};
    this.onError = options.onError || function () {};

    this.ws = null;
    this.connected = false;
    this.closed = false;
    this.packetId = 0;
    this.pending = [];
    this.pendingAcks = {};
    this.buffer = new Uint8Array(0);
    this.keepaliveTimer = null;
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 15000;
    this.lastError = null;
  }

  MqttClient.prototype._setStatus = function (status, detail) {
    this.onStatus(status, detail);
  };

  MqttClient.prototype._nextPacketId = function () {
    this.packetId = (this.packetId + 1) & 0xffff;
    return this.packetId;
  };

  MqttClient.prototype.connect = function () {
    var self = this;
    this.closed = false;
    this._setStatus('connecting');

    var ws;
    try {
      ws = this.protocols.length ? new WebSocket(this.url, this.protocols) : new WebSocket(this.url);
    } catch (e) {
      this._setStatus('error', e);
      this._scheduleReconnect();
      return;
    }

    this.ws = ws;

    try { ws.binaryType = 'arraybuffer'; } catch (e) {  }

    ws.onopen = function () {
      self._sendConnect();
    };

    ws.onmessage = function (event) {
      var data = event.data;
      if (typeof data === 'string') data = encoder.encode(data);
      else if (data instanceof ArrayBuffer) data = new Uint8Array(data);
      else if (data && data.buffer instanceof ArrayBuffer) data = new Uint8Array(data.buffer);
      else if (data && typeof data.arrayBuffer === 'function') {

        data.arrayBuffer().then(function (buf) { self._feed(new Uint8Array(buf)); });
        return;
      }
      self._feed(data);
    };

    ws.onerror = function () {

      self.lastError = 'falha no WebSocket';
    };

    ws.onclose = function (event) {
      self.connected = false;
      self._clearKeepalive();
      if (self.closed) {
        self._setStatus('closed');
      } else {
        var detail = (event && event.reason) || self.lastError ||
          ('código ' + (event && event.code));
        self._setStatus('reconnecting', detail);
        self._scheduleReconnect();
      }
    };
  };

  MqttClient.prototype._scheduleReconnect = function () {
    var self = this;
    if (this.closed) return;
    this.reconnectDelay = Math.min(this.reconnectDelay * 1.6, this.maxReconnectDelay);
    window.setTimeout(function () {
      if (!self.closed) self.connect();
    }, this.reconnectDelay);
  };

  MqttClient.prototype._sendConnect = function () {
    var body = concat([
      encodeString('MQTT'),
      new Uint8Array([0x04]),
      new Uint8Array([0x02]),
      new Uint8Array([0x00, this.keepalive]),
      encodeString(this.clientId)
    ]);
    this._write(0x10, body);
  };

  MqttClient.prototype.subscribe = function (topic) {
    if (!this.connected) { this.pending.push(topic); return; }
    var id = this._nextPacketId();
    var body = concat([
      new Uint8Array([(id >> 8) & 0xff, id & 0xff]),
      encodeString(topic),
      new Uint8Array([0x00])
    ]);
    this._write(0x82, body);
  };

  MqttClient.prototype.publish = function (topic, payload, opts) {
    if (!this.connected || !this.ws || this.ws.readyState !== 1) return false;
    var qos = (opts && opts.qos) || 0;
    var chunks = [encodeString(topic)];
    var packetId = 0;

    if (qos > 0) {
      packetId = this._nextPacketId();
      chunks.push(new Uint8Array([(packetId >> 8) & 0xff, packetId & 0xff]));
      this.pendingAcks[packetId] = (opts && opts.ack) || null;
    }
    chunks.push(payload || new Uint8Array(0));

    this._write(qos > 0 ? 0x32 : 0x30, concat(chunks));
    return true;
  };

  MqttClient.prototype.publishAck = function (topic, payload, timeoutMs) {
    var self = this;
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = window.setTimeout(function () {
        if (done) return;
        done = true;
        reject(new Error('Timeout aguardando PUBACK'));
      }, timeoutMs || 3000);

      var ok = self.publish(topic, payload, {
        qos: 1,
        ack: function () {
          if (done) return;
          done = true;
          window.clearTimeout(timer);
          resolve(true);
        }
      });
      if (!ok) {
        window.clearTimeout(timer);
        done = true;
        reject(new Error('Não foi possível publicar'));
      }
    });
  };

  MqttClient.prototype._sendPing = function () {
    if (this.connected) this._write(0xC0, new Uint8Array(0));
  };

  MqttClient.prototype.disconnect = function () {
    this.closed = true;
    this._clearKeepalive();
    if (this.ws && this.ws.readyState === 1) {
      try { this._write(0xE0, new Uint8Array(0)); } catch (e) {  }
      try { this.ws.close(); } catch (e) {  }
    }
    this.connected = false;
  };

  MqttClient.prototype._clearKeepalive = function () {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  };

  MqttClient.prototype._write = function (type, body) {
    if (!this.ws || this.ws.readyState !== 1) return;
    var header = new Uint8Array(1 + 4);
    header[0] = type;
    var lenBytes = encodeLength(body.length);
    header.set(lenBytes, 1);
    var packet = concat([header.slice(0, 1 + lenBytes.length), body]);
    try { this.ws.send(packet); } catch (e) {  }
  };

  MqttClient.prototype._feed = function (chunk) {
    var merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;

    while (this.buffer.length >= 2) {
      var type = this.buffer[0] >> 4;
      var multiplier = 1;
      var value = 0;
      var index = 1;
      var digit;

      do {
        if (index >= this.buffer.length) return;
        digit = this.buffer[index++];
        value += (digit & 127) * multiplier;
        multiplier *= 128;
        if (multiplier > 128 * 128 * 128) return;
      } while ((digit & 128) !== 0);

      if (this.buffer.length < index + value) return;

      var body = this.buffer.slice(index, index + value);
      var header = this.buffer[0];
      this.buffer = this.buffer.slice(index + value);

      this._handlePacket(header, body);
    }
  };

  MqttClient.prototype._handlePacket = function (header, body) {
    var type = header >> 4;

    if (type === PKT.CONNACK) {
      var code = body[1];
      if (code === 0) {
        this.connected = true;
        this.reconnectDelay = 1000;
        this._setStatus('connected');

        var pending = this.pending.slice();
        this.pending.length = 0;
        for (var i = 0; i < pending.length; i++) this.subscribe(pending[i]);
        this._startKeepalive();
      } else {
        this._setStatus('error', 'CONNACK ' + code);
        this.disconnect();
      }
      return;
    }

    if (type === PKT.PUBLISH) {

      var qos = (header & 0x06) >> 1;
      var topicLen = (body[0] << 8) | body[1];
      var topic = decoder.decode(body.slice(2, 2 + topicLen));
      var offset = 2 + topicLen;
      if (qos > 0) offset += 2;
      var payload = body.slice(offset);
      this.onMessage(topic, payload);
      return;
    }

    if (type === PKT.PUBACK) {
      var packetId = (body[0] << 8) | body[1];
      var ack = this.pendingAcks[packetId];
      if (ack) { delete this.pendingAcks[packetId]; ack(); }
      return;
    }

    if (type === PKT.PINGRESP || type === PKT.SUBACK) return;

    if (type === PKT.DISCONNECT) { this.connected = false; }
  };

  MqttClient.prototype._startKeepalive = function () {
    var self = this;
    this._clearKeepalive();
    this.keepaliveTimer = setInterval(function () {
      self._sendPing();
    }, Math.max(5000, (this.keepalive * 1000) / 2));
  };

  global.MqttClient = MqttClient;
})(window);
