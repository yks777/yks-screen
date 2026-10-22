# YKS-Screen — Activity de reunião no Discord

## Sobre o projeto

**YKS-Screen** é uma [Activity do Discord](https://discord.com/developers/docs/activities/overview)
que transforma um **canal de voz** em uma sala de reunião privada (no estilo Google Meet):
quem abre a Activity no mesmo canal entra na mesma sala e passa a ver as telas e
câmeras dos demais participantes — **a sala é o próprio canal de voz** (`roomId = channelId`),
então outro canal significa outra sala, com zero vazamento de mídia.

O site é **100% estático** (`index.html`, `styles.css`, `app.js`, `mqtt.js` + os módulos
de `transport.js`/`broadcast.js`/`frames.js`): basta subir no **GitHub Pages** (ou qualquer
CDN) e abrir. **Não há back-end, não há `npm install`,
não há build** — nem o cliente MQTT vem de CDN. A mídia é roteada por um **broker MQTT
público** (`broker.emqx.io`, gratuito, sem cadastro), que funciona como um "bus" de
publish/subscribe: cada participante publica os frames da sua mídia e recebe os dos outros.
O broker **não armazena e não decodifica nada**:

```
captura → WebCodecs (VP8) → frames binários → MQTT (broker público)
        → MQTT → WebCodecs (decode) → <canvas> do participante
```

No WebSocket há dois tópicos por sala (`yks/<sala>/…`): **controle** em JSON
(`hello`/`ping`/`bye`/`stream`/`stop`/`needkey`) com **QoS 1**, e **mídia** em binário
(frame + meta) com **QoS 0**, para minimizar a latência.

### Publicar no Discord (resumo)

1. <https://discord.com/developers/applications> → **New Application** → copie o
   **Application ID** para `app.js` → `CONFIG.clientId`.
2. Ative a Activity e aponte a **Activity URL** para o site publicado.
3. Configure os **URL Mappings** (obrigatórios dentro do Discord, senão dá `blocked:csp`):

| PREFIX | TARGET | Para quê | Obrigatório? |
|---|---|---|---|
| `/` | `<seu-usuario>.github.io` | a própria Activity (HTML/CSS/JS) | sim |
| `/sdk` | `cdn.jsdelivr.net` | o SDK do Discord | sim |
| `/broker` | `broker.emqx.io:8084` | o broker MQTT (WSS) | só no transporte MQTT |
| `/relay` | `relay.seudominio.com` | relay próprio (Socket.IO) | só no transporte Socket.IO |

> **TARGET é sempre um host, sem protocolo.** O prefixo é o que o proxy usa
> para decidir o destino; tudo que vem depois dele é repassado. O TARGET
> **pode** ter porta (`broker.emqx.io:8084`) — quem fala com o broker é o
> proxy, não o navegador.

4. No Discord: **Developer Mode ligado** → canal de voz → botão 🚀 (Activity Shelf).

> **Application ID pendente?** A Activity abre e mostra
> *"Application ID do Discord não configurado: troque CONFIG.clientId no app.js…"*
> — a mensagem é exata e o que falta é só o passo 1.

### O que o proxy do Discord permite (verificado)

A Activity não fala com a internet: **tudo passa pelo proxy**
(`https://<client_id>.discordsays.com`), que aplica uma CSP rígida. Três
consequências práticas:

1. **O CDN direto não funciona dentro do Discord.** A CSP do proxy é
   `script-src 'self' 'unsafe-eval' 'nonce-…' blob:` — `cdn.jsdelivr.net` não
   está em `script-src`, então `import('https://cdn.jsdelivr.net/…')` falha
   com *"Failed to fetch dynamically imported module"*. **O SDK tem que vir do
   URL Mapping `/sdk`** (o app usa o CDN direto só no desenvolvimento local).
2. **WebSocket só na porta 443 do próprio proxy.** A CSP autoriza
   `connect-src … wss://<client_id>.discordsays.com/` — a porta padrão. O
   remapeamento automático do SDK (`patchUrlMappings`) **mantém a porta** do
   destino (`wss://broker.emqx.io:8084/mqtt` →
   `wss://<client_id>.discordsays.com:8084/broker/mqtt`) e essa URL é
   bloqueada. Por isso o transporte **monta a URL do proxy na 443**:
   `wss://<client_id>.discordsays.com/broker/mqtt`.
3. **Prefixo sem URL Mapping = 404.** O proxy responde 404 em qualquer
   caminho não cadastrado. O app faz um *preflight* (um `GET` no mesmo
   caminho) e, se vier 404, mostra exatamente qual mapping falta em vez de
   ficar em "Reconectando…" para sempre.

Teste rápido do mapping (não precisa abrir o Discord):

```bash
curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
     -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
     -H "Sec-WebSocket-Protocol: mqtt" \
     https://<client_id>.discordsays.com/broker/mqtt
# 101 = o proxy repassou o upgrade (funciona) | 404 = mapping ausente
```

### Compartilhar tela dentro do Discord (aba companheira)

**O Discord não permite capturar a tela de dentro da Activity.** A Activity roda num
iframe de outra origem (`<client_id>.discordsays.com`) e o Discord **não coloca
`allow="display-capture"`** nele. O Chromium rejeita a captura antes de abrir o seletor:

```
NotAllowedError: Access to the feature "display-capture" is disallowed by permissions policy.
```

Isso **não é uma permissão do navegador** — nenhuma configuração do navegador ou do
Portal do Desenvolvedor resolve. (A captura de **câmera** funciona: o Discord libera
`allow="camera; microphone"`.)

A saída é a **aba companheira**: ao clicar em *Compartilhar tela*, o app abre o YKS-Screen
no navegador do sistema (`openExternalLink` do SDK do Discord), fora do iframe, onde a
captura funciona. Nessa aba você clica em *Compartilhar minha tela*, escolhe a janela e
volta para o Discord — **quem assiste continua dentro do Discord**, só quem mostra sai.

```
QUEM MOSTRA                        TRANSPORTE                 QUEM ASSISTE
aba companheira (navegador)   ──►   broker MQTT / relay  ──►   Activity (iframe do Discord)
  getDisplayMedia  ✅                                        VideoDecoder → <canvas>
  WebCodecs (VP8)
  └──── frames binários ────────────────────────────────────►
```

Detalhes:

- A aba companheira recebe `room`, `user`, `name` e o destino do transporte pela URL
  (ela **não** faz handshake com o Discord — não é uma Activity).
- Ela **roda fora do proxy** (é uma aba normal do navegador), então fala
  **direto** com o broker público ou com o relay público — nunca com o proxy.
  Os dois lados continuam chegando ao mesmo destino lógico, então a sala é a mesma.
- Ela publica com o **mesmo `userId`** do usuário, então o roster mostra
  *"Alice (você) — TELA"* em vez de duplicar o participante. Isso exige um identificador
  de sessão (`sid`) por aba, usado para descartar o eco das próprias mensagens.
- **Mantenha a aba aberta** enquanto compartilha. Se fechar, o tile some em ~20 s
  (o watchdog de presença).
- Fora do Discord (site aberto direto no navegador) a captura acontece **na própria aba**,
  sem aba companheira.
- Para o app abrir a aba companheira no **site real** (e não no proxy do Discord),
  configure `CONFIG.activityUrl` em `app.js` com a URL publicada.

> **Por que a aba companheira NÃO pode ser aberta pelo proxy:** o proxy entrega
> a mesma CSP rígida para todas as páginas que serve (`connect-src` só libera o
> próprio host do Discord), então o WebSocket do broker é bloqueado e a aba fica
> em *"Reconectando…"* para sempre — mesmo com a captura funcionando. Por isso
> `CONFIG.activityUrl` aponta para o site publicado, e a aba mostra um aviso
> com o link correto caso acabe abrindo pelo proxy.

### Publicar o site (GitHub Pages)

```bash
git add index.html styles.css app.js mqtt.js config.js frames.js media-errors.js \
        transport.js broadcast.js capture.html capture.css capture.js vendor README.md LICENSE
git commit -m "YKS-Screen"
git push -u origin main
# Settings → Pages → Source: Deploy from a branch → main / (root)
```

> **A cada publicação, troque a versão nos `<script src="...?v=…">` e no
> `<link href="styles.css?v=…">`** do `index.html` e do `capture.html`.
> Sem isso, o cache do navegador e o cache do proxy do Discord
> (`discordsays.com`) podem continuar servindo a versão anterior — foi assim
> que apareceu *"Application ID do Discord não configurado"* logo depois de
> trocar o `clientId` no código.

### Testar localmente (sem Discord)

```bash
python3 -m http.server 8000
```

Abra em duas abas (modo simulado, via `DiscordSDKMock` do próprio SDK oficial):

```
http://localhost:8000/index.html?mock=1&channel=111&user=aaa&name=Alice
http://localhost:8000/index.html?mock=1&channel=111&user=bbb&name=Bob
```

Fora do Discord, com a sala pela URL (sem o mock):

```
http://localhost:8000/index.html?room=minha-sala&user=aaa&name=Alice
```

E a aba companheira (é ela que captura a tela de verdade):

```
http://localhost:8000/capture.html?capture=1&room=minha-sala&user=aaa&name=Alice
```

| Parâmetro | Efeito |
|---|---|
| `?mock=1` | usa o `DiscordSDKMock` (sem o Discord) |
| `?channel=ID` | id do canal de voz simulado (vira o `roomId`) |
| `?user=ID&name=Nome` | identidade do participante simulado |
| `?room=CODIGO` | sala manual (fora do Discord; há botão "Copiar") |
| `?transport=socketio` | usa o relay próprio em vez do broker público |
| `?relay=host` | host público do relay (ex.: `relay.seudominio.com`) |
| `?broker=wss://host/mqtt` | outro broker MQTT |
| `?capture=1` | abre a **aba companheira** (junte com `room`, `user`, `name`) |

### Relay próprio (opcional) — como publicar

O relay (pasta `relay/`) é a alternativa ao broker público: um servidor seu que
repassa as mensagens da sala (e, com `DISCORD_BOT_TOKEN`, valida se o usuário
está no canal de voz). Dentro do Discord ele **precisa estar numa URL
HTTPS/WSS na porta 443** — é a única porta que a CSP do proxy autoriza — e o
Portal do Desenvolvedor precisa do mapping `/relay` → host (sem porta).

```bash
cd relay && npm install && npm start        # Node 18+, porta 8080
# em produção, atrás de um proxy TLS (Caddy/nginx/Cloudflare) na 443
```

- O cliente do Socket.IO está **vendorizado** em `vendor/socket.io.min.js`
  (MIT): o transporte `socketio` não depende de CDN nem de mapping extra.
- Dentro do Discord, a Activity conecta em
  `wss://<client_id>.discordsays.com/relay/ws` (porta 443, prefixo do
  mapping) e o proxy repassa para `<host>/ws` no relay. A aba companheira
  (fora do proxy) conecta direto em `wss://<host>/ws`.
- Se o relay não estiver configurado (`?relay=` ausente), o app usa o broker
  público por padrão.

### Limitações principais

- **A captura de tela dentro da Activity do Discord é impossível** — use a aba
  companheira (explicado acima).
- **Dentro do Discord, a Activity só conversa com o proxy** — por isso o SDK
  precisa do mapping `/sdk` e o WebSocket precisa estar na 443 do proxy
  (detalhes em *"O que o proxy do Discord permite"*).
- **WebCodecs é obrigatório** para o vídeo (Chrome/Edge 94+, Firefox 130+).
- **Sem TURN e sem criptografia de mídia** (os frames viajam em claro dentro do WSS).
- **Sem bitrate adaptativo** (1,2 Mbps / 15 fps); a latência depende do broker.
- **O `roomId` é o `channelId`**: ele viaja na URL da aba companheira. Quem tiver o link
  pode tentar injetar frames na sala — é o mesmo modelo do app atual (o broker público
  não autentica). Para produção, use o **relay próprio** com `DISCORD_BOT_TOKEN`
  (o relay valida se o usuário está no canal de voz e injeta o `userId` do servidor).
- Para produção com controle de acesso, use o **relay próprio** opcional (abaixo).

### Diagnóstico rápido

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| *"Failed to fetch dynamically imported module: …jsdelivr.net…"* | o CDN direto foi bloqueado pela CSP do proxy (esperado) — o SDK tem que vir do mapping `/sdk` | cadastre `/sdk` → `cdn.jsdelivr.net`; o app agora mostra qual fonte falhou de verdade |
| *"o proxy do Discord devolveu 404 para /sdk/…"* | mapping `/sdk` ausente | cadastre e **salve** o mapping no Portal |
| *"o proxy do Discord devolveu 404 para /broker/mqtt"* | mapping `/broker` (ou `/relay`) ausente | cadastre o mapping do transporte |
| *"Reconectando…" para sempre | a CSP bloqueou o WebSocket | o app monta a URL na 443; se ainda assim falhar, use o relay (`?transport=socketio`) |
| *"Não foi possível iniciar a Activity: …"* | mensagem completa com a causa | o app já diz qual fonte/mapping falhou; confira o console (F12) |

## Estrutura do projeto

```
/
├── index.html        # splash (Sharing Spinner) + interface da sala
├── styles.css        # Sharing Spinner + tema escuro com acento vermelho (#ff2b1b)
├── app.js            # SDK do Discord + UI da sala + protocolo de presença
├── capture.html      # aba companheira: captura a tela fora do iframe do Discord
├── capture.css       # estilos da aba companheira
├── capture.js        # lógica da aba companheira (captura, publica, keyframe)
├── config.js         # parâmetros de mídia compartilhados (Activity ↔ aba companheira)
├── frames.js         # codec do frame binário (meta JSON + payload) e randomId
├── media-errors.js   # diagnóstico da captura (policy do iframe x cancelamento)
├── transport.js      # transportes: MQTT (padrão) e Socket.IO (relay próprio)
├── broadcast.js      # publicação: MediaStream → WebCodecs → frames → transporte
├── mqtt.js           # cliente MQTT 3.1.1 mínimo (SEM dependências, ~350 linhas)
├── vendor/           # cliente do Socket.IO (MIT) — evita CDN e mapping extra
│   └── socket.io.min.js
├── README.md
├── LICENSE           # MIT
└── relay/            # OPCIONAL e fora do versionamento: relay Socket.IO próprio
    ├── server.js
    └── package.json
```

- **Nada usa npm, bundler, React/Vue/Svelte ou etapa de build.** O `relay/` é opcional,
  requer Node 18+ (`npm install && npm start`) e serve para quem preferir rotear a mídia
  pelo próprio servidor (com validação opcional de canal via bot token) em vez do broker
  público — nesse caso, use `?transport=socketio` e o URL Mapping `/relay` → host do relay
  (porta 443).
- `mqtt.js` é uma implementação própria do subconjunto MQTT 3.1.1 necessário
  (CONNECT/SUBSCRIBE/PUBLISH/PING) — por isso nem o cliente MQTT vem de CDN.
- `transport.js`, `broadcast.js` e `frames.js` são compartilhados entre a Activity e a aba
  companheira: os dois lados falam exatamente o mesmo protocolo.

## License

Distribuído sob a licença [MIT](LICENSE) — sinta-se livre para usar, modificar e
redistribuir, mantendo o aviso de copyright.

[![License: MIT](https://img.shields.io/badge/License-MIT-red.svg)](LICENSE)
