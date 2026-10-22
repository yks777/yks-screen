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

| PREFIX | TARGET | Para quê |
|---|---|---|
| `/` | `<seu-usuario>.github.io` | a própria Activity (HTML/CSS/JS) |
| `/broker` | `broker.emqx.io:8084` | o broker MQTT (WSS) |
| `/sdk` | `cdn.jsdelivr.net` | o SDK do Discord |

4. No Discord: **Developer Mode ligado** → canal de voz → botão 🚀 (Activity Shelf).

> **Application ID pendente?** A Activity abre e mostra
> *"Application ID do Discord não configurado: troque CONFIG.clientId no app.js…"*
> — a mensagem é exata e o que falta é só o passo 1.

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
- Ela publica com o **mesmo `userId`** do usuário, então o roster mostra
  *"Alice (você) — TELA"* em vez de duplicar o participante. Isso exige um identificador
  de sessão (`sid`) por aba, usado para descartar o eco das próprias mensagens.
- **Mantenha a aba aberta** enquanto compartilha. Se fechar, o tile some em ~20 s
  (o watchdog de presença).
- Fora do Discord (site aberto direto no navegador) a captura acontece **na própria aba**,
  sem aba companheira.
- Para o app abrir a aba companheira no **site real** (e não no proxy do Discord),
  configure `CONFIG.activityUrl` em `app.js` com a URL publicada.

### Publicar o site (GitHub Pages)

```bash
git add index.html styles.css app.js mqtt.js config.js frames.js media-errors.js \
        transport.js broadcast.js capture.html capture.css capture.js README.md LICENSE
git commit -m "YKS-Screen"
git push -u origin main
# Settings → Pages → Source: Deploy from a branch → main / (root)
```

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
| `?broker=wss://host/mqtt` | outro broker MQTT |
| `?capture=1` | abre a **aba companheira** (junte com `room`, `user`, `name`) |

### Limitações principais

- **A captura de tela dentro da Activity do Discord é impossível** — use a aba
  companheira (explicado acima).
- **WebCodecs é obrigatório** para o vídeo (Chrome/Edge 94+, Firefox 130+).
- **Sem TURN e sem criptografia de mídia** (os frames viajam em claro dentro do WSS).
- **Sem bitrate adaptativo** (1,2 Mbps / 15 fps); a latência depende do broker.
- **O `roomId` é o `channelId`**: ele viaja na URL da aba companheira. Quem tiver o link
  pode tentar injetar frames na sala — é o mesmo modelo do app atual (o broker público
  não autentica). Para produção, use o **relay próprio** com `DISCORD_BOT_TOKEN`
  (o relay valida se o usuário está no canal de voz e injeta o `userId` do servidor).
- Para produção com controle de acesso, use o **relay próprio** opcional (abaixo).

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
├── README.md
├── LICENSE           # MIT
└── relay/            # OPCIONAL e fora do versionamento: relay Socket.IO próprio
    ├── server.js
    └── package.json
```

- **Nada usa npm, bundler, React/Vue/Svelte ou etapa de build.** O `relay/` é opcional,
  requer Node 18+ (`npm install && npm start`) e serve para quem preferir rotear a mídia
  pelo próprio servidor (com validação opcional de canal via bot token) em vez do broker
  público — nesse caso, use `?transport=socketio` e o URL Mapping `/socket` → host do relay.
- `mqtt.js` é uma implementação própria do subconjunto MQTT 3.1.1 necessário
  (CONNECT/SUBSCRIBE/PUBLISH/PING) — por isso nem o cliente MQTT vem de CDN.
- `transport.js`, `broadcast.js` e `frames.js` são compartilhados entre a Activity e a aba
  companheira: os dois lados falam exatamente o mesmo protocolo.

## License

Distribuído sob a licença [MIT](LICENSE) — sinta-se livre para usar, modificar e
redistribuir, mantendo o aviso de copyright.

[![License: MIT](https://img.shields.io/badge/License-MIT-red.svg)](LICENSE)
