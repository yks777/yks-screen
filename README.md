# YKS-Screen — Activity de reunião no Discord

Sala de reunião privada (estilo Google Meet) que roda **dentro do Discord**, iniciada
a partir de um **canal de voz**. Quem abre a Activity no mesmo canal entra na mesma
sala e passa a ver as telas e câmeras dos outros participantes.

> ## ✅ 100% estático — **nenhum servidor, nenhum computador rodando nada**
>
> O site é **um conjunto de arquivos estáticos** (`index.html`, `styles.css`,
> `app.js`, `mqtt.js`). Basta subir no **GitHub Pages** (ou qualquer CDN) e
> abrir. **Não há back-end, não há `npm install`, não há build.**
>
> A mídia é roteada por um **broker MQTT público** (`broker.emqx.io`, gratuito,
> sem cadastro e sem chave). O broker funciona como um "bus" de
> publish/subscribe: cada participante publica os frames da sua mídia num
> tópico da sala e recebe os frames dos demais. Ele **não armazena** nada e
> **não decodifica** nada.
>
> ```
> captura → WebCodecs (VP8) → frames binários → MQTT (broker público)
>        → MQTT → WebCodecs (decode) → <canvas> do participante
> ```

---

## 📁 Estrutura

```
/
├── index.html        # splash (Sharing Spinner) + interface da sala
├── styles.css        # Sharing Spinner + tema escuro (#ff2b1b)
├── app.js            # SDK do Discord + mídia + protocolo de presença
├── mqtt.js           # cliente MQTT 3.1.1 mínimo (SEM dependências, ~350 linhas)
├── README.md
└── relay/            # OPCIONAL: relay Socket.IO próprio (só para quem quiser)
    ├── server.js
    └── package.json
```

Nada aqui usa npm, bundler, React/Vue/Svelte ou etapa de build.
`mqtt.js` é uma implementação própria do subconjunto MQTT 3.1.1 necessário
(CONNECT/SUBSCRIBE/PUBLISH/PING) — por isso **nem o cliente MQTT vem de CDN**.

---

## 🧠 Arquitetura

```
┌────────────── Activity (iframe do Discord) ──────────────┐
│                                                            │
│  getDisplayMedia / getUserMedia                            │
│        │                                                   │
│        ▼                                                   │
│  WebCodecs VideoEncoder (VP8)  ──► frames binários ──┐    │
│  ScriptProcessor → PCM 16 kHz  ──► chunks binários ──┤    │
│                                                    │    │
│  WebSocket (WSS) ◄───────────────────────────────┘    │
└────────────────────────┼───────────────────────────────────┘
                         │  wss://broker.emqx.io:8084/mqtt
                         │  (dentro do Discord, via URL Mapping /broker)
                         ▼
                 ┌───────────────┐
                 │ broker MQTT   │  apenas repassa (pub/sub)
                 │   público     │  tópicos: yks/<sala>/media e yks/<sala>/ctrl
                 └───────┬───────┘
                         ▼
                 ┌──────────────────────────────┐
                 │  Activity (outro participante)│
                 │  VideoDecoder (VP8) → canvas  │
                 │  AudioContext → reprodução    │
                 └──────────────────────────────┘
```

**A sala é o canal de voz:** `roomId = discordSdk.channelId`. Quem abre a Activity
no mesmo canal de voz cai na mesma sala; outro canal = outra sala = zero
vazamento de mídia (verificado nos TESTES 2 e 3.c).

### Protocolo (100% cliente, sem servidor de aplicação)

**Controle** — tópico `yks/<sala>/ctrl` (JSON):

| Mensagem | Significado |
|---|---|
| `{t:'hello', user}` | "entrei na sala" (também responde aos outros) |
| `{t:'ping', user}` | heartbeat (a cada 5s) |
| `{t:'bye', user}` | "saí" (enviado com QoS 1: aguarda o PUBACK do broker) |
| `{t:'stream', user, type, w, h, hasAudio}` | comecei a transmitir `screen`/`camera` |
| `{t:'stop', user, type}` | parei de transmitir |

**Mídia** — tópico `yks/<sala>/media` (binário):
`[4 bytes: tamanho do meta (uint32)][meta JSON][payload da mídia]`
com `meta = {t:'v'|'a', userId, type, seq, ts, key, w, h, codec, rate}`.

A mídia usa **QoS 0** (fire & forget) para minimize latência; as mensagens de
controle usam **QoS 1** para não se perderem.

---

## 🚀 Publicar (só isso!)

### GitHub Pages

```bash
git init
git add index.html styles.css app.js mqtt.js README.md
git commit -m "YKS-Screen: Activity de reunião 100% estática"
git branch -M main
git remote add origin https://github.com/<seu-usuario>/yks-screen.git
git push -u origin main
```

Depois: **Settings → Pages → Source: Deploy from a branch → `main` / (root)**.
Em ~1 minuto o site fica em `https://<seu-usuario>.github.io/yks-screen/`.

**Não há mais nada a fazer.** Não precisa de servidor, domínio, banco,
certificado ou `npm install`.

### Testar localmente (sem nada instalado)

```bash
python3 -m http.server 8000
```

Abra em duas abas (modo simulado, sem Discord):

```
http://localhost:8000/index.html?mock=1&channel=111&user=aaa&name=Alice
http://localhost:8000/index.html?mock=1&channel=111&user=bbb&name=Bob
```

O `?mock=1` usa o **`DiscordSDKMock` do próprio SDK oficial** (mesma interface:
`ready()`, `channelId`, `commands.getChannel()`, `subscribe()`), sem precisar
do Discord. Fora do Discord, use `?room=CODIGO` para escolher a sala à mão
(há um botão "Copiar" no painel de participantes).

| Parâmetro | Efeito |
|---|---|
| `?mock=1` | usa o `DiscordSDKMock` (sem Discord) |
| `?channel=ID` | id do canal de voz simulado (vira o `roomId`) |
| `?user=ID&name=Nome` | identidade do participante simulado |
| `?room=CODIGO` | sala manual (fora do Discord) |
| `?clientId=ID` | Application ID do Discord |
| `?broker=wss://host/mqtt` | outro broker MQTT |
| `?transport=socketio` | usa o relay próprio em vez do broker público |
| `?proxy=1` | força a aplicação do `patchUrlMappings` (simula produção) |

---

## 🛠️ Publicar no Discord — passo a passo

### 1. Criar a aplicação

1. <https://discord.com/developers/applications> → **New Application**.
2. Copie o **Application ID** (OAuth2 Client ID) e cole em `app.js` → `CONFIG.clientId`.

### 2. Habilitar Activities

1. Menu lateral → **Activities** → marque **Enabled**.
2. **Activity URL**: a URL pública da sua Activity
   (ex.: `https://<seu-usuario>.github.io/yks-screen/`).
   Para desenvolvimento local, use um túnel HTTPS
   (`cloudflared tunnel --url http://localhost:8000`).
3. Marque as plataformas suportadas (**Desktop** / **Mobile**).
4. Preencha Name, Description, Icon e Splash Image.

### 3. URL Mappings (obrigatórios no Discord)

Na tela **Activities → URL Mappings**:

| PREFIX | TARGET | Para quê |
|---|---|---|
| `/` | `<seu-usuario>.github.io` | a própria Activity (HTML/CSS/JS) |
| `/broker` | `broker.emqx.io:8084` | o broker MQTT (WSS) |
| `/sdk` | `cdn.jsdelivr.net` | o SDK do Discord |

Regras do Discord:

- O **TARGET é um host, sem protocolo** (`broker.emqx.io:8084`, não `wss://…`).
- O TARGET precisa apontar para um **diretório**, nunca para um arquivo.
- Prefixos com o mesmo início vão do **mais específico para o mais genérico**.
- Sem esses mapeamentos o navegador bloqueia o CDN e o proxy bloqueia o broker
  (erro `blocked:csp`).

### 4. `patchUrlMappings` — o que ele faz no nosso código

O SDK exporta `patchUrlMappings`, que reescreve `window.fetch`, `window.WebSocket`
e `XMLHttpRequest.open` para que URLs externas passem pelo proxy do Discord em
vez de serem bloqueadas pela CSP.

```js
// app.js (initDiscord)
if (IN_DISCORD_PROXY && typeof sdk.patchUrlMappings === 'function') {
  patchUrlMappings(sdk, [
    { prefix: '/broker', target: 'broker.emqx.io:8084' },
    { prefix: '/sdk',    target: 'cdn.jsdelivr.net' }
  ]);
}
```

Efeito (só dentro do Discord):

```
wss://broker.emqx.io:8084/mqtt
   -> wss://<client_id>.discordsays.com/broker/mqtt
   -> (proxy do Discord) -> wss://broker.emqx.io:8084/mqtt
```

Fora do Discord **não** aplicamos o patch: não há proxy, e reescrever a URL do
broker para o host local quebraria a conexão. Por isso a guarda
`IN_DISCORD_PROXY` (`*.discordsays.com`).

> **Nota sobre o CDN do SDK:** o caminho `/dist/index.js` citado em alguns
> exemplos **não existe** no pacote `@discord/embedded-app-sdk@2.5.0` — os
> arquivos estão em `/output/*.mjs` (ESM puro). Por isso o app usa
> `import()` dinâmico, com duas fontes (URL Mapping primeiro, CDN depois):
>
> ```js
> sdkSources: [
>   '/sdk/npm/@discord/embedded-app-sdk@2.5.0/output/index.mjs',  // produção
>   'https://cdn.jsdelivr.net/npm/@discord/embedded-app-sdk@2.5.0/output/index.mjs' // dev
> ]
> ```

### 5. Testar

1. Discord: **User Settings → Advanced → Developer Mode** (ligue).
2. Entre em um canal de voz → painel de voz → botão 🚀 (Activity Shelf) → YKS-Screen.
3. Convide alguém para o mesmo canal de voz: os dois entram na mesma sala.

---

## 🔐 Segurança e privacidade

- O tópico MQTT é derivado do **ID do canal de voz** (`yks/<channelId>/media`).
  Quem conhecer o ID do canal poderia assinar o tópico e ver a mídia.
  Mitigações possíveis: usar o relay próprio (abaixo) ou derivar o tópico de um
  segredo compartilhado.
- **Nomes de usuário** são inseridos com `textContent` (nunca `innerHTML`).
- **O cliente não pode falsificar a origem**: o `userId` das mensagens de
  controle é o do próprio participante, e o relay (quando usado) injeta o
  `userId` autenticado.
- **Validação de canal no relay** (opcional): com `DISCORD_BOT_TOKEN` e
  `DISCORD_GUILD_ID`, o relay consulta `GET /guilds/{guild}/voice-states` e só
  aceita quem está **realmente conectado ao canal de voz** da sala.
- Em produção, autentique o handshake (token do Discord via `/.proxy/api/token` +
  `commands.authenticate`).

---

## 🖥️ Relay próprio (opcional)

Se você preferir **não** publicar a mídia em um broker público, o `relay/`
implementa o mesmo protocolo (WebSocket Socket.IO) com controle de acesso:

```bash
cd relay
npm install
npm start
```

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `8080` | porta HTTP/WS |
| `SOCKET_PATH` | `/ws` | caminho do Socket.IO (igual ao `app.js`) |
| `STATIC_DIR` | `..` | pasta de arquivos estáticos servidos |
| `DISCORD_BOT_TOKEN` | — | (opcional) habilita a validação de canal |
| `DISCORD_GUILD_ID` | — | (opcional) guild usado na validação |

Hospede em qualquer lugar com Node 18+ e **WSS** (Railway, Render, Fly.io, VPS).
Depois, na Activity, use `?transport=socketio` e aponte o URL Mapping
`/socket` → o host do relay.

> O relay é **opcional**: o caminho padrão (`?transport=mqtt`, sem parâmetro)
> não usa nenhum servidor.

---

## 🎨 Design

Linguagem visual **minimalista em preto e vermelho**, pensada para o iframe do Discord:

| Elemento | Tratamento |
|---|---|
| Paleta | fundo `#080808`, superfícies `#0f0f10`/`#151517`, bordas `#232326`, **vermelho `#ff2b1b` como único acento** |
| Tipografia | Inter/system-ui; títulos em caixa alta com tracking largo; rótulos em 10–11px uppercase |
| Header | 64px, sticky, com blur — marca + selo REC pulsante + chips de sala/conexão |
| Palco | **layout "palco"**: quando alguém compartilha a tela, ela vira o protagonista (largura total, sem tarja preta) e as câmeras ficam numa faixa centralizada abaixo |
| Tiles | 16:9, raio 12px, borda vermelha no tile de tela, badges legíveis sobre qualquer mídia (fundo escuro + blur) |
| Controles | barra-pílula flutuante no rodapé, ícones SVG inline, estado ativo = preenchimento vermelho |
| Microfone | alterna o ícone normal ↔ "mudo" conforme o estado |
| Splash | "Sharing Spinner": disco vermelho girando sobre `#0d0d0d` |
| Responsivo | desktop: palco + roster lateral (264px); mobile: coluna única, controles só com ícone, toasts acima da barra |

Sem emojis na interface, sem gradientes decorativos, sem cores fora da paleta —
o vermelho sempre significa "ação/ao vivo".

---

## 🧪 Relatório dos testes

Executados de verdade: Chromium headless + Puppeteer, **três clientes simulados**
com o `DiscordSDKMock` do SDK oficial, servidos por um **servidor puramente
estático** (`python3 -m http.server`, equivalente ao GitHub Pages), conversando
com o **broker MQTT público real**. A mídia foi conferida **pixel a pixel**
(ex.: o cliente 2 recebeu o pixel vermelho `rgb(255,34,17)` da tela do cliente 1).

| # | Teste | Resultado | Evidência |
|---|---|---|---|
| 1 | Inicialização no Discord | ✅ | SDK pronto, `patchUrlMappings` aplicado (em produção), broker conectado (`netChip = "Conectado"`), `roomChip = "Sala 111111111111111111"` = `channelId` |
| 2 | Sala isolada | ✅ | Sala A: 2 participantes · Sala B: 1 · `roomId` diferente por canal |
| 3 | Transmissão de tela | ✅ | Preview local com `srcObject`; **tela decodificada no cliente 2 em ~620 ms** (pixel `rgb(255,34,17)`); **cliente de outra sala não recebe nada** |
| 4 | Câmera | ✅ | Vídeo da câmera chega decodificado (pixel `rgb(142,148,158)`); roster mostra `TELA` e `CÂM`; **20 chunks de áudio** reproduzidos |
| 5 | Encerramento | ✅ | "Parar tela" remove só o tile da tela; "Sair da sala" remove a mídia e o roster volta a 1 participante (3 rodadas consecutivas sem falha) |
| 6a | Permissão negada | ✅ | Toast: *"Permissão negada. Libere o acesso à tela/câmera nas permissões do navegador e tente de novo."* |
| 6b | Broker inacessível | ✅ | `netChip = "Reconectando…"` + toast: *"Sem conexão com o transporte de mídia. Verifique o URL Mapping no Portal do Desenvolvedor (ou a internet)."* |
| 6c | Erro visível no console | ✅ | `WebSocket connection to 'wss://broker.invalido.example/mqtt' failed: Error in connection establishment: net::ERR_NAME_NOT_RESOLVED` |

Métricas do pipeline (2 clientes, 1 tela + 1 microfone): 27 frames codificados,
20 decodificados, 59–81 KB transferidos, latência observada **~630 ms**.

**Diagnóstico em tempo de execução:** `window.__yks.stats` expõe
`framesEncoded`, `framesDecoded`, `audioChunksPlayed`, `bytesOut`, `bytesIn`,
`metaIn`, `metaOut`.

### O que NÃO foi testado de verdade

- A **Activity dentro do Discord real** (exige app publicado): o proxy
  `discordsays.com` e a CSP foram validados contra a documentação oficial e
  contra o comportamento do `patchUrlMappings`, não contra o cliente real.
- **Captura real de tela/câmera**: o Chromium headless não tem display; foi
  usado `canvas.captureStream()`. O caminho completo (captura → encoder →
  WebSocket → broker → decoder → canvas) é real; só a origem dos pixels é
  simulada.
- **Broker com WSS em produção**: o teste usou `wss://` real ✓, mas via
  `patchUrlMappings` apenas simulado (`?proxy=1`).

---

## 🎬 Splash / loader

A tela de loading é o **"Sharing Spinner"**: um disco vermelho girando com três
nós pretos e núcleo central. É um port **1:1** do componente de referência
(mesmos `@keyframes rot`, mesmos tamanhos em `em`, mesmos nós, mesmo anel
interno) — apenas a paleta e o contexto (`position: fixed; inset: 0; z-index: 9999`)
foram adaptados ao app.

| Seletor | O que faz |
|---|---|
| `.loader` | palco que centraliza e escala a animação (`font-size: 16px`; 12px no mobile) |
| `.sharingon` | disco vermelho (`var(--c)`) de `6em` com borda preta de 6px, girando em 1s |
| `.ring` | anel interno translúcido (`var(--c-ring)`) |
| `.to` (×3) | nós pretos nas posições 12h / 7h / 5h |
| `.to::before` | a "cauda" curva (`border-left: 16px solid #000`) de cada nó |
| `.circle` | núcleo central preto com `box-shadow` de brilho |

- **Loop de 1s** (`rot: 0 → 360deg`), contínuo enquanto a splash está visível.
- A splash usa `position: fixed; inset: 0; z-index: 9999`, dura **~3s** e some
  com *fade* para a interface principal (também sai mais cedo na primeira interação).
- Com `prefers-reduced-motion: reduce` a rotação é desativada e a splash dura
  ~0,9s.
- O selo **REC** do header reusa o mesmo estilo de "ponto que pisca"
  (`rec-blink`, `step-end`) em vermelho.

## ⚠️ Limitações conhecidas

- **WebCodecs é obrigatório** para o vídeo (Chrome/Edge 94+, Firefox 130+).
- **Áudio em PCM** (16 kHz mono, ~32 KB/s). Opus via `AudioEncoder` reduziria
  isso em ~4×, mas exige um `AudioWorklet` para a reprodução.
- **Sem TURN, sem criptografia de mídia** (o broker transporta os frames em
  claro dentro do WSS). Para produção, considere um relay próprio com
  controle de acesso.
- **Sem controle de bitrate adaptativo**: qualidade fixa (1,2 Mbps / 15 fps).
- **Latência** depende do broker: um broker em outra região adiciona o RTT.
- O **broker público é compartilhado**: prefira um broker dedicado se a
  latência importar.
