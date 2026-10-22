/* ==========================================================================
 * YKS-Screen — configuração de mídia compartilhada
 * --------------------------------------------------------------------------
 * A Activity (app.js) e a aba companheira (capture.js) precisam codificar
 * com os mesmos parâmetros: o lado que decodifica usa meta.codec, mas
 * resolução, taxa e taxa de quadros precisam bater.
 *
 * Alterar aqui altera os dois lados de uma vez.
 * ========================================================================== */

window.YKS_MEDIA = {
  video: {
    width: 1280,
    height: 720,
    framerate: 15,
    bitrate: 1200000,
    codec: 'vp8'
  },
  audio: {
    sampleRate: 16000   /* PCM mono 16 kHz ≈ 32 KB/s por participante */
  }
};
