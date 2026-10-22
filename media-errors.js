(function () {
  'use strict';

  function canCaptureHere() {
    var policy = document.permissionsPolicy || document.featurePolicy;
    if (policy && typeof policy.allowsFeature === 'function') {
      try {
        return !!policy.allowsFeature('display-capture');
      } catch (e) {

      }
    }

    return true;
  }

  function isPolicyMessage(msg) {
    return /permissions?\s+policy/i.test(msg || '');
  }

  function describeCaptureError(err) {
    var name = (err && err.name) || '';
    var msg = (err && err.message) || '';

    if (name === 'SecurityError' || isPolicyMessage(msg)) {
      return {
        blocked: true,
        title: 'Captura bloqueada neste contexto',
        msg: 'Este navegador bloqueia a captura de tela dentro de um iframe sem permissão "display-capture" — é o caso do Discord Activity.',
        hint: 'Use a aba companheira: ela abre o app no seu navegador, onde a captura funciona.'
      };
    }

    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {

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
