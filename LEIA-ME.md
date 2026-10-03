# Visualizador de Pastas

Um visualizador de imagens e vídeos que roda no Google Chrome, direto do seu computador.
Nada é enviado para a internet: um pequeno servidor local lê as pastas e o Chrome mostra tudo.

## Como abrir

1. Dê dois cliques em **`Iniciar Visualizador.bat`**.
2. Ele confere, instala e atualiza o que for preciso (veja abaixo) e abre o Chrome em
   **http://localhost:4321**.
3. Deixe a janela preta aberta enquanto usa. Para encerrar, é só fechá-la.

Se abrir de novo com o visualizador já rodando, ele apenas abre uma nova aba.

## Dependências: instaladas e atualizadas automaticamente

A cada inicialização o `.bat` verifica tudo de que o visualizador precisa:

| O quê | O que acontece |
|---|---|
| **Node.js** (obrigatório) | Se faltar ou estiver abaixo da versão mínima, baixa o instalador oficial de nodejs.org, confere a assinatura (SHA-256 e assinatura digital da OpenJS Foundation) e instala. Uma vez por dia, atualiza para a versão LTS mais recente. |
| **Google Chrome** | Se faltar, instala pelo `winget`. Ele se atualiza sozinho. Sem ele, o visualizador abre no navegador padrão. |
| **Pacotes npm** (`package.json`) | Instalados sempre que a lista muda (ou se a pasta `node_modules` sumir) e atualizados uma vez por dia. Hoje há um, opcional: o **sharp**, que gera as miniaturas (veja [Velocidade das miniaturas](#velocidade-das-miniaturas)). Se ele não puder ser instalado, o visualizador abre do mesmo jeito, só que mais lento. |

- Instalações podem pedir permissão do Windows: clique em **Sim**.
- Sem internet, ele segue com o que já está instalado e tenta atualizar na próxima vez.
- Node.js gerenciado por nvm, Volta, fnm ou Scoop não é alterado.
- Para não atualizar o Node.js automaticamente, troque `"atualizar": true` por `false` em
  `dependencias.json`.

**Dependências futuras:**

- Pacote JavaScript: rode `npm install nome-do-pacote` (ou edite o `package.json`). Na próxima
  abertura, em qualquer computador, ele é instalado sozinho.
- Programa do Windows: adicione um item em `dependencias.json` com `"fonte": "winget"` e o `"id"`
  do pacote (descubra com `winget search nome`). Exemplo:

```json
{ "nome": "FFmpeg", "fonte": "winget", "id": "Gyan.FFmpeg", "comando": "ffmpeg",
  "argumentoVersao": "-version", "obrigatorio": true, "atualizar": true, "site": "https://ffmpeg.org" }
```

## Como usar

- **Escolher uma pasta:** botão **Escolher pasta…** (abre o seletor do Windows), os atalhos da
  barra lateral (Imagens, Vídeos, Downloads, unidades…) ou cole um caminho no campo da página
  inicial ou na barra de endereço do visualizador (clique nela para digitar).
- **Navegar:** as subpastas aparecem primeiro, com uma prévia das imagens de dentro; depois vêm
  as imagens e os vídeos, sempre em **grade** ao abrir uma pasta (o modo lista é opcional).
- **Ordenar:** por nome, data, tamanho ou tipo. Por **tamanho**, as subpastas também entram na
  ordem, pelo tamanho total de tudo o que há dentro delas. Em pastas grandes o cálculo leva alguns
  segundos: os tamanhos vão aparecendo nos cartões e a ordem é refeita quando todos ficam prontos.
  Um "≥" antes do tamanho indica que alguma subpasta não pôde ser lida (sem permissão).
- **Visualizar:** clique em um arquivo. Use **← →** para passar pelos arquivos da pasta.
- **Voltar:** **Backspace** ou o **botão direito do mouse** voltam um nível (do arquivo para a
  pasta, da pasta para a de cima). O botão Voltar do Chrome e apagar o último trecho da URL também
  funcionam. Para ver o menu normal do Chrome, use **Shift + botão direito**.

O endereço sempre mostra onde você está, por exemplo:

```
http://localhost:4321/C:/Users/Kevin/Pictures/Viagem/            ← pasta
http://localhost:4321/C:/Users/Kevin/Pictures/Viagem/foto.jpg    ← arquivo aberto
```

Dá para salvar nos favoritos do Chrome ou abrir em outra aba (Ctrl+clique).

## Atalhos do teclado

| Nas pastas | |
|---|---|
| ← ↑ → ↓ | Mover a seleção |
| Enter | Abrir pasta / visualizar arquivo |
| Backspace ou botão direito | Voltar um nível |
| / | Buscar nesta pasta |
| + / − | Aumentar / diminuir os ícones |
| ? | Ver todos os atalhos |

| No visualizador | |
|---|---|
| ← → | Arquivo anterior / próximo |
| Esc, Backspace ou botão direito | Fechar e voltar à pasta |
| + − 0 (ou roda do mouse) | Zoom; 0 ajusta à tela; duplo clique = tamanho real |
| R | Girar a imagem |
| F | Tela cheia |
| I | Informações do arquivo |
| Espaço | Reproduzir / pausar vídeo |
| Shift + ← → | Voltar / avançar 5 segundos no vídeo |

## Arquivos exibidos

Somente pastas, **imagens** e **vídeos** aparecem; os demais arquivos são ignorados
(a quantidade ignorada aparece discretamente no topo da pasta).

- Imagens: JPG, PNG, GIF, WebP, AVIF, BMP, SVG, ICO
- Vídeos: MP4, WebM, MOV, MKV, M4V, OGV

HEIC, TIFF, AVI, WMV, FLV, MPEG, 3GP e MTS também aparecem na lista, mas o Chrome não consegue
exibi-los; para esses, o visualizador oferece **Abrir no aplicativo padrão** do Windows.
(TIFF ganha miniatura na grade quando o sharp está instalado.)

## Velocidade das miniaturas

As miniaturas das imagens são feitas pelo próprio servidor, com o pacote **sharp** (instalado
automaticamente), e guardadas em disco. Assim o navegador recebe cerca de 20 KB por foto, em vez
do arquivo original inteiro (3 a 10 MB numa foto de celular). O original só é baixado quando você
abre o arquivo.

- **Pré-carregamento:** ao abrir uma pasta, o servidor já prepara, em segundo plano, as capas das
  subpastas, as miniaturas da pasta e as primeiras imagens de cada subpasta. Entrar numa subpasta
  passa a ser imediato. Abrir outra pasta interrompe o preparo da anterior.
- **Cache:** fica em `%LOCALAPPDATA%\VisualizadorDePastas\miniaturas` e vale para qualquer
  navegador ou computador que acesse o visualizador. As mais antigas são apagadas sozinhas acima
  de 2 GB. Pode apagar a pasta à vontade: as miniaturas são refeitas quando forem necessárias.
- A janela preta informa se as miniaturas rápidas estão ativas. Sem o sharp (por exemplo, sem
  internet na primeira abertura), o navegador faz as miniaturas a partir dos originais, como
  antes. Funciona, mas é bem mais lento, principalmente pelo Tailscale.
- Vídeos, BMP, ICO e HEIC continuam com a miniatura feita pelo navegador.

Medição com 600 fotos de 12 MP (2,9 MB cada), num computador de teste com 4 núcleos, contando o
tempo até a primeira tela ficar completa:

| | Antes | Agora, 1ª vez | Agora, já em cache |
|---|---|---|---|
| Pasta com 30 subpastas (capas) | 5,1 s | 1,6 s | 0,7 s |
| Pasta com 150 fotos | 2,0 s | 0,8 s | 0,9 s |
| Entrar numa subpasta | 7,3 s | 0,6 s | 0,2 s |
| Os mesmos três, numa conexão de 25 Mbit/s (como pelo Tailscale) | 52 s / 17 s / 94 s | 1,9 s / 1,1 s / 0,7 s | 1,1 s / 0,6 s / 0,3 s |

**Ainda está lento? Descubra se é o computador ou a rede.** No Chrome, aperte **F12**, vá em
**Rede** (Network), clique num pedido `thumb` ou `list` e abra **Timing**. Em **Server Timing**
aparece quanto tempo o computador com os arquivos levou (ler o disco, gerar a miniatura). O
restante é a rede:

- Servidor demorando (centenas de ms) → é o computador: disco lento (HD externo, unidade de rede)
  ou processador ocupado. Na primeira vez é normal; depois a miniatura vem do cache em 1 a 2 ms.
- Servidor rápido, mas "Content Download" ou "Waiting" altos → é a conexão. Pelo Tailscale,
  rode `tailscale ping` no outro computador: se aparecer "via DERP", a conexão está passando por
  um retransmissor do Tailscale, que é bem mais lento que a conexão direta.

## Acesso de outro computador (Tailscale)

Dá para ver as pastas de um computador a partir de outro, com os dois no
[Tailscale](https://tailscale.com) na mesma conta.

1. No computador que tem os arquivos, abra **`Iniciar Visualizador (Tailscale).bat`** (em vez do
   normal). Se o visualizador já estiver aberto, feche a janela preta dele antes.
2. Na primeira vez, o Windows pode perguntar sobre o Firewall: clique em **Permitir acesso**.
3. A janela preta mostra o endereço para usar no outro computador, por exemplo:

   ```
      Nos outros aparelhos da sua rede Tailscale, abra:
                 http://100.93.17.99:4321/
                 http://meupc:4321/
   ```

4. No outro computador, abra esse endereço no Chrome. O endereço com o nome (`http://meupc:4321/`)
   funciona quando o MagicDNS do Tailscale está ativo, o que já é o padrão.

Só aparelhos da sua rede Tailscale conseguem se conectar: a rede local (Wi-Fi/cabo) e a internet
continuam sem acesso, e o Tailscale criptografa a conexão. Quem acessar vê as imagens, os vídeos e
os nomes das pastas desse computador, então não compartilhe essa máquina no Tailscale com quem não
deve vê-los.

No outro computador, **Escolher pasta…**, **Abrir no aplicativo padrão** e **Mostrar no Explorer**
não aparecem, porque abririam janelas no computador remoto. Navegue pela barra lateral ou cole um
caminho; para formatos que o Chrome não exibe (HEIC, AVI…), use **Baixar**.

**Não abre no outro computador?**

- Confira se a janela preta mostra o endereço do Tailscale, e não "aguardando a conexão".
- Se alguém clicou em **Cancelar** na pergunta do Firewall, o Windows bloqueia o Node.js (a janela
  preta avisa). Para liberar: no menu Iniciar, pesquise "Permitir um aplicativo" › **Alterar
  configurações** › marque **Node.js JavaScript Runtime** na coluna **Privada** › OK.
- Teste a conexão entre as máquinas: no outro computador, rode `tailscale ping 100.93.17.99`
  (com o IP mostrado na janela preta).
- Se você configurou regras de acesso (ACLs) no painel do Tailscale, elas precisam liberar a
  porta 4321.

## Opções avançadas

Podem ser passadas ao `.bat` (por exemplo, num atalho: `"Iniciar Visualizador.bat" --atualizar`):

| Opção | Efeito |
|---|---|
| `--atualizar` | Procura atualizações agora, sem esperar 24 h |
| `--sem-atualizar` | Não procura atualizações nesta vez |
| `--simular` | Mostra o que seria instalado/atualizado, sem alterar nada |
| `--somente-preparar` | Instala/atualiza as dependências e não abre o visualizador |
| `--port=5000` | Usa outra porta |
| `--no-open` | Não abre o navegador automaticamente |
| `--tailscale` | Também aceita acesso dos outros aparelhos da sua rede Tailscale (é o que o `Iniciar Visualizador (Tailscale).bat` usa) |
