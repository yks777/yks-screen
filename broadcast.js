(function () {
  'use strict';

  var F = window.YKS_FRAMES;

  var publishers = {};

  function publish(opts) {
    var pub = {
      type: opts.type,
      stream: opts.stream,
      transport: opts.transport,
      user: opts.user,
      sid: opts.sid,
      active: true,
      video: null,
      audio: null,
      videoEl: null,
      watchdog: null,
      width: 0,
      height: 0,
      seq: 0,
      wantKeyFrame: false,
      onEnded: null,
      opts: opts
    };
    publishers[opts.type] = pub;

    var videoTrack = opts.stream.getVideoTracks()[0];
    var audioTrack = opts.stream.getAudioTracks()[0];

    if (videoTrack) {
      startVideoPublisher(pub, videoTrack, opts).catch(function (e) {
        console.error('[YKS] falha no encoder de vídeo:', e);
        if (opts.onState) opts.onState('error', 'Não foi possível codificar o vídeo: ' + e.message);
      });
    }
    if (audioTrack) {
      startAudioPublisher(pub, audioTrack, opts);
    }

    pub.onEnded = function () {
      if (pub.active) stop(opts.type);
    };
    opts.stream.getTracks().forEach(function (track) {
      track.addEventListener('ended', pub.onEnded);
    });

    return pub;
  }

  function startVideoPublisher(pub, track, opts) {
    if (typeof window.VideoEncoder === 'undefined') {
      throw new Error('WebCodecs (VideoEncoder) não está disponível neste navegador.');
    }

    var cfg = opts.video;
    var stats = opts.stats;

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
        codec: cfg.codec,
        width: cfg.width,
        height: cfg.height,
        bitrate: cfg.bitrate,
        framerate: cfg.framerate,
        latencyMode: 'realtime'
      };

      return window.VideoEncoder.isConfigSupported(settings).then(function (res) {
        if (!res.supported) throw new Error('Codeco ' + settings.codec + ' não suportado.');
        encoder.configure(settings);

        var keyFrameEvery = Math.max(1, Math.round(cfg.framerate * 4));
        var count = 0;
        var lastEncode = 0;

        function encodeNow() {
          if (!pub.active || !encoder || encoder.state !== 'configured') return;

          if (encoder.encodeQueueSize >= 3) return;

          var w = video.videoWidth, h = video.videoHeight;
          if (w && h && (w !== pub.width || h !== pub.height)) {

            pub.width = w; pub.height = h;
            try {
              encoder.configure({
                codec: cfg.codec, width: w, height: h,
                bitrate: cfg.bitrate,
                framerate: cfg.framerate, latencyMode: 'realtime'
              });
            } catch (e) {  }
          }

          var forceKey = pub.wantKeyFrame;
          pub.wantKeyFrame = false;

          try {
            var frame = new window.VideoFrame(video, {
              timestamp: Math.round(performance.now() * 1000)
            });
            encoder.encode(frame, { keyFrame: forceKey || (count % keyFrameEvery) === 0 });
            frame.close();
            count++;
            if (stats) stats.framesEncoded++;
            lastEncode = Date.now();
          } catch (e) {
            console.warn('[YKS] frame descartado:', e.message);
          }
        }

        function pumpByFrameCallback() {
          if (!pub.active) return;
          encodeNow();
          video.requestVideoFrameCallback(pumpByFrameCallback);
        }

        if (video.requestVideoFrameCallback) {
          video.requestVideoFrameCallback(pumpByFrameCallback);
        }

        pub.watchdog = window.setInterval(function () {
          if (pub.active && Date.now() - lastEncode > 400) encodeNow();
        }, 200);
      });
    });
  }

  function sendVideoChunk(pub, chunk) {
    if (!pub.transport) return;
    var data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    pub.transport.sendMedia({
      t: 'v',
      userId: pub.user.id,
      sid: pub.sid,
      type: pub.type,
      seq: pub.seq++,
      ts: chunk.timestamp,
      key: chunk.type === 'key',
      w: pub.width,
      h: pub.height,
      codec: pub.opts.video.codec
    }, data);
  }

  function startAudioPublisher(pub, track, opts) {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;

    var ctx = new Ctx();
    var source = ctx.createMediaStreamSource(new MediaStream([track]));
    var processor = ctx.createScriptProcessor(4096, 1, 1);
    var sink = ctx.createGain();
    sink.gain.value = 0;

    processor.onaudioprocess = function (event) {
      if (!pub.active) return;
      if (opts.isMuted && opts.isMuted()) return;
      if (!pub.transport) return;
      var input = event.inputBuffer.getChannelData(0);
      var pcm = downsampleToPcm16(input, ctx.sampleRate, opts.audio.sampleRate);
      if (!pcm.length) return;
      var bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      pub.transport.sendMedia({
        t: 'a',
        userId: pub.user.id,
        sid: pub.sid,
        type: pub.type,
        seq: pub.seq++,
        rate: opts.audio.sampleRate
      }, bytes);
    };

    source.connect(processor);
    processor.connect(sink);
    sink.connect(ctx.destination);

    pub.audio = { ctx: ctx, processor: processor, source: source, sink: sink };
  }

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

  function stop(type) {
    var pub = publishers[type];
    if (!pub) return null;
    pub.active = false;

    if (pub.video) { try { pub.video.close(); } catch (e) {  } }
    if (pub.watchdog) { clearInterval(pub.watchdog); pub.watchdog = null; }
    if (pub.audio) {
      try { pub.audio.processor.disconnect(); } catch (e) {  }
      try { pub.audio.source.disconnect(); } catch (e) {  }
      try { pub.audio.ctx.close(); } catch (e) {  }
    }
    if (pub.videoEl) {
      pub.videoEl.srcObject = null;
      pub.videoEl.remove();
    }
    if (pub.stream) {
      pub.stream.getTracks().forEach(function (t) {
        if (pub.onEnded) t.removeEventListener('ended', pub.onEnded);
        try { t.stop(); } catch (e) {  }
      });
    }

    delete publishers[type];
    if (pub.opts && pub.opts.onStopped) pub.opts.onStopped(type);
    return pub;
  }

  function requestKeyFrame(type) {
    var pub = publishers[type];
    if (!pub) return false;
    pub.wantKeyFrame = true;
    return true;
  }

  function isPublishing(type) {
    return !!publishers[type];
  }

  window.YKS_BROADCAST = {
    publish: publish,
    stop: stop,
    requestKeyFrame: requestKeyFrame,
    isPublishing: isPublishing,
    publishers: publishers
  };
})();
