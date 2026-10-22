/* ==========================================================================
 * YKS-Screen — helpers binários compartilhados
 * --------------------------------------------------------------------------
 * Codec do frame de mídia (metadados JSON + payload binário) e utilidades
 * usadas tanto pela Activity (app.js) quanto pela aba companheira
 * (capture.js), pelo transporte (transport.js) e pelo publicador
 * (broadcast.js).
 *
 *   [4B len(meta)][meta JSON][payload]
 * ========================================================================== */

(function () {
  'use strict';

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

  /* Id aleatório curto (sem crypto — só precisa ser único por aba). */
  function randomId(len) {
    var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    var out = '';
    for (var i = 0; i < (len || 8); i++) {
      out += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return out;
  }

  window.YKS_FRAMES = {
    encodeFrame: encodeFrame,
    decodeFrame: decodeFrame,
    randomId: randomId,
    textEncoder: textEncoder,
    textDecoder: textDecoder
  };
})();
