/* ==========================================================================
 * YKS-Screen — diagnóstico de captura de mídia
 * --------------------------------------------------------------------------
 * Shared by app.js (Activity) and capture.js (aba companheira).
 *
 * Two distinct failures used to be reported with the same generic toast
 * ("Permissão negada"), which sent the user chasing browser settings that
 * could not fix anything:
 *
 *   1) the user dismissed the source picker (NotAllowedError);
 *   2) the page is inside a frame that is NOT allowed to use the Screen
 *      Capture API — Chromium rejects with NotAllowedError/SecurityError
 *      saying "Access to the feature "display-capture" is disallowed by
 *      permissions policy". This is what happens inside a Discord Activity,
 *      because Discord does not put allow="display-capture" on the iframe.
 *      No browser setting and no Developer Portal setting can fix it.
 *
 * YKS_ERRORS.canCaptureHere() answers "can I capture here?" BEFORE trying,
 * so we never call getDisplayMedia() in a doomed context.
 * ========================================================================== */

(function () {
  'use strict';

  /* --------------------------------------------------------------------------
   * O documento atual tem permissão de usar a Screen Capture API?
   *
   * A Permissions-Policy "display-capture" tem como allowlist padrão "self":
   * um iframe de outra origem (o do Discord) NÃO é permitido, a menos que o
   * embedder use allow="display-capture". O Discord não usa.
   * ------------------------------------------------------------------------ */
  function canCaptureHere() {
    var policy = document.permissionsPolicy || document.featurePolicy;
    if (policy && typeof policy.allowsFeature === 'function') {
      try {
        return !!policy.allowsFeature('display-capture');
      } catch (e) {
        /* Feature desconhecida nesta versão: segue o fluxo normal e deixa o
           erro real aparecer. */
      }
    }
    /* Sem API de Permissions-Policy: não há como saber — tenta e trata. */
    return true;
  }

  /* A mensagem do erro denuncia bloqueio por política? */
  function isPolicyMessage(msg) {
    return /permissions?\s+policy/i.test(msg || '');
  }

  /* --------------------------------------------------------------------------
   * Traduz o DOMException da captura em algo acionável.
   *   blocked = true  -> o contexto proíbe a captura (use a aba companheira)
   *   blocked = false -> problema do usuário/ambiente (repita ou ajuste)
   * ------------------------------------------------------------------------ */
  function describeCaptureError(err) {
    var name = (err && err.name) || '';
    var msg = (err && err.message) || '';

    /* Bloqueio por política de-frame: nem o seletor aparece. A mensagem do
       navegador é decisiva aqui — quando ela cita a policy, o bloqueio é da
       policy, mesmo que allowsFeature() responda diferente. */
    if (name === 'SecurityError' || isPolicyMessage(msg)) {
      return {
        blocked: true,
        title: 'Captura bloqueada neste contexto',
        msg: 'Este navegador bloqueia a captura de tela dentro de um iframe sem permissão "display-capture" — é o caso do Discord Activity.',
        hint: 'Use a aba companheira: ela abre o app no seu navegador, onde a captura funciona.'
      };
    }

    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      /* Em um iframe do Discord o erro também chega como NotAllowedError, mas
         com a mensagem de política — nesse caso cai no bloco acima. Aqui é
         o cancelamento do seletor (o caso mais comum). */
      return {
        blocked: false,
        title: 'Captura cancelada',
        msg: 'Você cancelou (ou o sistema bloqueou) a seleção da tela.',
        hint: 'Clique em "Compartilhar tela" de novo e escolha a janela na lista.'
      };
    }

    if (name === 'InvalidStateError') {
      return {
        blocked: false,
        title: 'Sem permissão de interação',
        msg: 'O navegador exige um clique direto do usuário para abrir a seleção de tela.',
        hint: 'Clique no botão "Compartilhar tela" — não via atalho ou automação.'
      };
    }

    if (name === 'NotFoundError') {
      return {
        blocked: false,
        title: 'Nenhuma fonte encontrada',
        msg: 'Nenhuma tela ou janela disponível para captura.',
        hint: 'Verifique se há um monitor conectado e tente de novo.'
      };
    }

    if (name === 'NotReadableError') {
      return {
        blocked: false,
        title: 'Fonte ocupada',
        msg: 'O sistema impediu a leitura da tela selecionada (trava de segurança do SO).',
        hint: 'Tente outra janela ou desative a proteção de gravação da tela.'
      };
    }

    if (name === 'NotSupportedError') {
      return {
        blocked: false,
        title: 'Sem suporte',
        msg: 'Este navegador não suporta esse tipo de captura.',
        hint: 'Use Chrome, Edge ou Firefox atualizados.'
      };
    }

    if (name === 'AbortError') {
      return {
        blocked: false,
        title: 'Captura interrompida',
        msg: 'A captura foi cancelada antes de começar.',
        hint: 'Tente de novo.'
      };
    }

    return {
      blocked: false,
      title: 'Falha na captura',
      msg: 'Falha ao capturar a mídia: ' + (msg || String(err)),
      hint: ''
    };
  }

  window.YKS_ERRORS = {
    canCaptureHere: canCaptureHere,
    describeCaptureError: describeCaptureError
  };
})();
