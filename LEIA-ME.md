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
| **Pacotes npm** (`package.json`) | Instalados sempre que a lista muda (ou se a pasta `node_modules` sumir) e atualizados uma vez por dia. Hoje não há nenhum. |

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
- **Visualizar:** clique em um arquivo. Use **← →** para passar pelos arquivos da pasta.
- **Voltar:** **Backspace** volta um nível (do arquivo para a pasta, da pasta para a de cima).
  O botão Voltar do Chrome e apagar o último trecho da URL também funcionam.

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
| Backspace | Voltar um nível |
| / | Buscar nesta pasta |
| + / − | Aumentar / diminuir os ícones |
| ? | Ver todos os atalhos |

| No visualizador | |
|---|---|
| ← → | Arquivo anterior / próximo |
| Esc ou Backspace | Fechar e voltar à pasta |
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
