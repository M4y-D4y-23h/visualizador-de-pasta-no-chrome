// Visualizador de Pastas — interface principal.
import { api } from './api.js';
import { icon } from './icons.js';
import * as P from './paths.js';
import {
  $, $$, esc, clamp, fmtSize, fmtDate, fmtDuration, fmtNumber, plural, fold, debounce,
  store, toast, errorMessage, copyText,
} from './util.js';
import { createThumbObserver, requestThumb, peekThumb, trimThumbs } from './thumbs.js';
import { createViewer, typeLabel } from './viewer.js';

const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });

const TILE_MIN = 110;
const TILE_MAX = 320;
const TILE_STEP = 20;

const PLACE_ICONS = {
  desktop: 'monitor', downloads: 'download', documents: 'file', pictures: 'image', videos: 'video', home: 'user',
};
const DRIVE_NAMES = {
  Fixed: 'Disco Local', Removable: 'Unidade removível', Network: 'Unidade de rede', CDRom: 'Unidade de CD/DVD',
};
const DRIVE_ICONS = { Removable: 'usb', Network: 'network', CDRom: 'disc' };
const DEFAULT_DIR = { name: 1, date: -1, size: -1, type: 1 };

const el = {
  app: $('#app'),
  sidebar: $('#sidebar'),
  scrim: $('#scrim'),
  nav: $('#nav'),
  content: $('#content'),
  crumbs: $('#crumbs'),
  pathbar: $('#pathbar'),
  pathInput: $('#pathInput'),
  pathEditBtn: $('#pathEditBtn'),
  search: $('#search'),
  searchBox: $('#searchBox'),
  progress: $('#progress'),
  menuBtn: $('#menuBtn'),
  backBtn: $('#backBtn'),
  fwdBtn: $('#fwdBtn'),
  upBtn: $('#upBtn'),
  refreshBtn: $('#refreshBtn'),
  pickBtn: $('#pickBtn'),
  themeBtn: $('#themeBtn'),
  helpBtn: $('#helpBtn'),
  helpModal: $('#helpModal'),
  pickModal: $('#pickModal'),
};

const sortSaved = store.get('ordem', null);

const S = {
  info: null,
  home: null,
  page: null,            // 'home' | 'dir' | 'error'
  dir: null,             // listagem da pasta atual
  errorPath: null,
  loadedAt: 0,
  sig: '',
  filter: 'all',
  query: '',
  sort: sortSaved && DEFAULT_DIR[sortSaved.key] ? sortSaved : { key: 'name', dir: 1 },
  tile: clamp(Number(store.get('tamanho', 180)) || 180, TILE_MIN, TILE_MAX),
  viewMode: 'grid',      // toda pasta abre em grade
  folders: [],           // pastas visíveis (filtradas e ordenadas)
  files: [],             // arquivos visíveis
  items: [],             // cartões na ordem da tela
  sel: -1,
  favorites: store.get('favoritos', []),
  recents: store.get('recentes', []),
  navToken: 0,
  abort: null,
  thumbObs: null,
  peekObs: null,
  awaitingPop: false,
  afterPop: null,
  picking: false,
  refreshing: false,
};

let viewer = null;
const isWin = () => P.isWin();

/* =================================================================== início */

init();

async function init() {
  setupChrome();
  bindEvents();
  applyTile();
  el.app.classList.toggle('sidebar-collapsed', !!store.get('painelRecolhido', false));
  renderNav();

  try {
    S.info = await api.info();
  } catch (err) {
    el.content.innerHTML = `<div class="page page-state">${stateHtml('alert', 'Servidor não encontrado',
      'O Visualizador de Pastas não está respondendo. Abra o arquivo <b>Iniciar Visualizador.bat</b> e tente novamente.',
      '<button class="btn btn-primary" type="button" data-act="reload">Tentar novamente</button>')}</div>`;
    return;
  }
  P.setPlatform(S.info.platform);

  viewer = createViewer({
    onChange: onViewerChange,
    onRequestClose: closeViewerFromUI,
    onOpenExternal: (f) => openExternal(f.path),
    onReveal: (f) => reveal(f.path),
    onCopy: (p) => copyText(p),
    revealLabel: isWin() ? 'Mostrar no Explorer' : 'Mostrar na pasta',
  });

  history.scrollRestoration = 'manual';
  if (window.navigation) window.navigation.addEventListener('currententrychange', updateNavButtons);

  loadHome(false);
  await route();
  el.content.focus({ preventScroll: true });
}

function setBtn(b, ic, label) {
  b.innerHTML = icon(ic);
  b.title = label;
  b.setAttribute('aria-label', label);
}

function setupChrome() {
  el.pickBtn.innerHTML = `${icon('folderPlus')}<span>Escolher pasta…</span>`;
  el.pickBtn.title = 'Escolher uma pasta do computador';
  setBtn(el.menuBtn, 'sidebar', 'Mostrar/ocultar painel lateral');
  setBtn(el.backBtn, 'arrowLeft', 'Voltar (Alt+←)');
  setBtn(el.fwdBtn, 'arrowRight', 'Avançar (Alt+→)');
  setBtn(el.upBtn, 'levelUp', 'Subir um nível (Backspace)');
  setBtn(el.refreshBtn, 'refresh', 'Atualizar');
  setBtn(el.pathEditBtn, 'pencil', 'Digitar um caminho');
  setBtn(el.helpBtn, 'keyboard', 'Atalhos do teclado (?)');
  $('#searchIcon').innerHTML = icon('search');
  $$('[data-close]').forEach((b) => { b.innerHTML = icon('x'); });
  updateThemeBtn();
  renderHelp();
}

async function loadHome(refresh) {
  try {
    S.home = await api.home(refresh);
  } catch {
    if (!S.home) S.home = { places: [], drives: [] };
  }
  renderNav();
  if (S.page === 'home') renderHome();
  if (S.page === 'dir') {
    updateCrumbs();
    if (S.dir && !P.parent(S.dir.path)) renderFolderHead();
  }
}

/* =================================================================== rotas */

function pushOrReplace(url, replace, extra = {}) {
  if (replace) history.replaceState({ ...extra }, '', url);
  else history.pushState({ ...extra }, '', url);
  updateNavButtons();
}

function canonicalize(url) {
  if (url !== location.pathname) history.replaceState(history.state, '', url);
}

// Salva rolagem e seleção da entrada atual do histórico (para o "Voltar").
function rememberViewState() {
  if (S.page !== 'dir' || (viewer && viewer.isOpen())) return;
  const st = history.state || {};
  history.replaceState({ ...st, scroll: el.content.scrollTop, sel: selectedName() }, '', location.href);
}

window.addEventListener('pagehide', rememberViewState);
window.addEventListener('popstate', () => route());

async function fetchListing(p, token) {
  if (S.abort) S.abort.abort();
  const ctrl = new AbortController();
  S.abort = ctrl;
  const t = setTimeout(() => el.progress.classList.add('on'), 120);
  try {
    const data = await api.list(p, ctrl.signal);
    return token === S.navToken ? { data } : null;
  } catch (err) {
    if (err.name === 'AbortError' || token !== S.navToken) return null;
    return { err };
  } finally {
    clearTimeout(t);
    if (token === S.navToken) el.progress.classList.remove('on');
  }
}

// Interpreta a URL atual (abertura da página, Voltar/Avançar do navegador).
async function route() {
  const token = ++S.navToken;
  const after = S.afterPop;
  S.awaitingPop = false;
  S.afterPop = null;
  updateNavButtons();
  try {
    await routeInner(token);
  } finally {
    if (after) after();
  }
}

async function routeInner(token) {
  let target;
  try { target = P.urlToPath(location.pathname); } catch { target = undefined; }

  if (target === null) {
    closeViewerSilently();
    showHome();
    return;
  }
  if (target === undefined) {
    closeViewerSilently();
    showError({ code: 'invalid', message: 'Este endereço não corresponde a um caminho de pasta válido.' }, null);
    return;
  }

  // Atalhos sem buscar no servidor: mesma pasta, ou um arquivo dela.
  if (S.page === 'dir' && S.dir) {
    if (P.same(target, S.dir.path)) {
      closeViewerSilently();
      canonicalize(P.dirUrl(S.dir.path));
      return;
    }
    const parent = P.parent(target);
    if (parent && P.same(parent, S.dir.path)) {
      const f = findFile(P.base(target));
      if (f) {
        openViewer(f);
        return;
      }
    }
  }

  const r = await fetchListing(target, token);
  if (!r) return;
  closeViewerSilently();
  if (r.err) {
    showError(r.err, target);
    return;
  }
  const data = r.data;
  canonicalize(data.open ? P.fileUrl(data.path, data.open) : P.dirUrl(data.path));
  const st = history.state || {};
  showListing(data, { focusName: st.sel || null, scrollTop: st.scroll || 0 });
  if (data.open) openViewer(findFile(data.open));
  if (data.notice) toast(data.notice);
}

// Navegação iniciada pelo usuário (clique, teclado, caminho digitado).
async function navigateTo(p, { focusName = null } = {}) {
  if (!p) return false;
  if (S.awaitingPop) {
    S.afterPop = () => navigateTo(p, { focusName });
    return false;
  }
  if (S.page === 'dir' && S.dir && P.same(p, S.dir.path)) {
    softRefresh({ silent: true });
    return true;
  }
  const token = ++S.navToken;
  const r = await fetchListing(p, token);
  if (!r) return false;
  if (r.err) {
    toast(errorMessage(r.err), 'error', 5000);
    return false;
  }
  const data = r.data;
  rememberViewState();
  closeViewerSilently();
  if (data.open) {
    pushOrReplace(P.fileUrl(data.path, data.open), false);
  } else {
    pushOrReplace(P.dirUrl(data.path), false);
  }
  showListing(data, { focusName, scrollTop: 0 });
  if (data.open) openViewer(findFile(data.open));
  if (data.notice) toast(data.notice);
  return true;
}

function goHome() {
  if (S.awaitingPop) { S.afterPop = goHome; return; }
  if (S.page === 'home') return;
  ++S.navToken;
  if (S.abort) S.abort.abort();
  el.progress.classList.remove('on');
  rememberViewState();
  closeViewerSilently();
  pushOrReplace('/', false);
  showHome();
}

function goUp() {
  if (S.awaitingPop) { S.afterPop = goUp; return; }
  if (S.page === 'dir' && S.dir) {
    const parent = S.dir.parent || P.parent(S.dir.path);
    if (parent) navigateTo(parent, { focusName: P.base(S.dir.path) });
    else goHome();
  } else if (S.page === 'error') {
    const parent = S.errorPath && P.parent(S.errorPath);
    if (parent) navigateTo(parent);
    else goHome();
  }
}

function updateNavButtons() {
  // A Navigation API do Chrome sabe exatamente se há para onde voltar/avançar.
  const nav = window.navigation;
  el.backBtn.disabled = nav ? !nav.canGoBack : history.length < 2;
  el.fwdBtn.disabled = nav ? !nav.canGoForward : false;
  el.upBtn.disabled = S.page === 'home';
}

/* ========================================================= exibir uma pasta */

function prepare(data) {
  for (const f of data.folders) f._k = fold(f.name);
  for (const f of data.files) f._k = fold(f.name);
  return data;
}

function signature(data) {
  return data.folders.map((f) => `${f.name}\u0001${f.mtime}`).join('\u0002')
    + '\u0003' + data.files.map((f) => `${f.name}\u0001${f.size}\u0001${f.mtime}`).join('\u0002')
    + '\u0003' + data.others;
}

function showListing(data, { focusName = null, scrollTop = 0 } = {}) {
  const sameDir = S.page === 'dir' && S.dir && P.same(S.dir.path, data.path);
  if (!sameDir) {
    S.query = '';
    el.search.value = '';
    S.filter = 'all';
    S.viewMode = 'grid';
  }
  endPathEdit();
  S.page = 'dir';
  S.dir = prepare(data);
  S.errorPath = null;
  S.loadedAt = Date.now();
  S.sig = signature(data);
  recordRecent(data);

  renderFolderPage();
  updateCrumbs();
  markNavActive();
  updateTitle();
  updateNavButtons();
  setSearchEnabled(true);

  el.content.scrollTop = scrollTop;
  if (focusName) selectByName(focusName, { focus: true, scroll: !scrollTop, center: true });
  else el.content.focus({ preventScroll: true });
}

function renderFolderPage() {
  el.content.innerHTML = `
    <div class="page page-folder">
      <header class="folder-head" id="folderHead"></header>
      <div class="toolbar" id="toolbar"></div>
      <div class="sections" id="sections"></div>
    </div>`;
  renderFolderHead();
  renderToolbar();
  renderSections();
}

function driveFor(p) {
  const drives = (S.home && S.home.drives) || [];
  return drives.find((d) => P.same(d.path, p)) || null;
}

function driveLabel(d) {
  const letter = isWin() ? d.path.slice(0, 2) : d.path;
  const name = d.label || DRIVE_NAMES[d.type] || 'Unidade';
  return isWin() ? `${name} (${letter})` : name;
}

function titleFor(p, name) {
  if (!P.parent(p)) {
    const d = driveFor(p);
    if (d) return driveLabel(d);
  }
  return name || P.base(p);
}

function renderFolderHead() {
  const box = $('#folderHead');
  if (!box || !S.dir) return;
  const d = S.dir;
  const images = d.files.filter((f) => f.kind === 'image').length;
  const videos = d.files.length - images;
  const total = d.files.reduce((sum, f) => sum + f.size, 0);
  const meta = [];
  if (d.folders.length) meta.push(plural(d.folders.length, 'pasta', 'pastas'));
  if (images) meta.push(plural(images, 'imagem', 'imagens'));
  if (videos) meta.push(plural(videos, 'vídeo', 'vídeos'));
  if (!meta.length) meta.push('Pasta vazia');
  if (total) meta.push(fmtSize(total));
  const others = d.others
    ? `<span class="dot">·</span><span class="folder-others" title="O visualizador mostra somente pastas, imagens e vídeos">${esc(plural(d.others, 'outro arquivo não exibido', 'outros arquivos não exibidos'))}</span>`
    : '';
  const fav = isFavorite(d.path);
  const isRoot = !P.parent(d.path);
  box.innerHTML = `
    <div class="folder-head-icon${isRoot ? ' is-drive' : ''}">${icon(isRoot ? 'drive' : 'folderOpen')}</div>
    <div class="folder-head-text">
      <h1 class="folder-title">${esc(titleFor(d.path, d.name))}</h1>
      <div class="folder-meta">${meta.map(esc).join('<span class="dot">·</span>')}${others}</div>
    </div>
    <div class="folder-actions">
      <button class="btn btn-ghost${fav ? ' is-on' : ''}" type="button" data-act="fav"
              title="${fav ? 'Remover dos favoritos' : 'Fixar esta pasta na barra lateral'}">
        ${icon(fav ? 'starFill' : 'star')}<span>${fav ? 'Favorita' : 'Favoritar'}</span>
      </button>
      <button class="btn btn-ghost" type="button" data-act="explorer" title="Abrir esta pasta ${isWin() ? 'no Explorer' : 'no gerenciador de arquivos'}">
        ${icon('external')}<span>${isWin() ? 'Abrir no Explorer' : 'Abrir pasta'}</span>
      </button>
    </div>`;
}

function renderToolbar() {
  const tb = $('#toolbar');
  if (!tb) return;
  const hasFiles = S.dir.files.length > 0;
  tb.innerHTML = `
    <div class="seg" role="radiogroup" aria-label="Filtrar por tipo"${hasFiles ? '' : ' hidden'}>
      <button type="button" role="radio" data-filter="all">Tudo <span class="seg-count" data-count="all"></span></button>
      <button type="button" role="radio" data-filter="image">${icon('image')}Imagens <span class="seg-count" data-count="image"></span></button>
      <button type="button" role="radio" data-filter="video">${icon('video')}Vídeos <span class="seg-count" data-count="video"></span></button>
    </div>
    <div class="toolbar-right">
      <label class="select" title="Ordenar por">
        <span class="select-label">Ordenar:</span>
        <select id="sortKey" aria-label="Ordenar por">
          <option value="name">Nome</option>
          <option value="date">Data</option>
          <option value="size">Tamanho</option>
          <option value="type">Tipo</option>
        </select>
        ${icon('chevronDown', 'select-caret')}
      </label>
      <button class="icon-btn" type="button" id="sortDir"></button>
      <div class="size-ctl" title="Tamanho dos ícones (+ e −)">
        ${icon('imageSmall')}
        <input type="range" id="tileSize" min="${TILE_MIN}" max="${TILE_MAX}" step="10" aria-label="Tamanho dos ícones">
        ${icon('image')}
      </div>
      <div class="seg seg-icons" role="radiogroup" aria-label="Modo de exibição">
        <button type="button" role="radio" data-view="grid" title="Grade" aria-label="Grade">${icon('grid')}</button>
        <button type="button" role="radio" data-view="list" title="Lista" aria-label="Lista">${icon('list')}</button>
      </div>
    </div>`;
  syncToolbar();
}

function syncToolbar(counts) {
  const tb = $('#toolbar');
  if (!tb) return;
  for (const b of $$('[data-filter]', tb)) {
    const on = b.dataset.filter === S.filter;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  }
  if (counts) {
    for (const s of $$('[data-count]', tb)) {
      s.textContent = fmtNumber(counts[s.dataset.count]);
      s.parentElement.classList.toggle('is-zero', !counts[s.dataset.count]);
    }
  }
  $('#sortKey', tb).value = S.sort.key;
  const asc = S.sort.dir > 0;
  setBtn($('#sortDir', tb), asc ? 'sortAsc' : 'sortDesc', asc ? 'Ordem crescente — clique para inverter' : 'Ordem decrescente — clique para inverter');
  $('#tileSize', tb).value = String(S.tile);
  $('.size-ctl', tb).classList.toggle('is-disabled', S.viewMode === 'list');
  for (const b of $$('[data-view]', tb)) {
    const on = b.dataset.view === S.viewMode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  }
}

function computeVisible() {
  const d = S.dir;
  const qy = fold(S.query.trim());
  const match = (x) => !qy || x._k.includes(qy);
  const folders = d.folders.filter(match);
  const matched = d.files.filter(match);
  const counts = { all: matched.length, image: 0, video: 0 };
  for (const f of matched) counts[f.kind]++;
  const files = S.filter === 'all' ? matched : matched.filter((f) => f.kind === S.filter);

  const { key, dir } = S.sort;
  const byName = (a, b) => collator.compare(a.name, b.name);
  const cmp = {
    name: byName,
    date: (a, b) => a.mtime - b.mtime || byName(a, b),
    size: (a, b) => a.size - b.size || byName(a, b),
    type: (a, b) => collator.compare(a.ext, b.ext) || byName(a, b),
  }[key] || byName;
  if (key === 'name' || key === 'date') folders.sort((a, b) => cmp(a, b) * dir);
  else folders.sort(byName);
  files.sort((a, b) => cmp(a, b) * dir);

  S.folders = folders;
  S.files = files;
  return counts;
}

function listHead(kind) {
  const cols = [
    ['name', 'Nome'],
    ['type', 'Tipo'],
    ['size', kind === 'folders' ? 'Itens' : 'Tamanho'],
    ['date', 'Modificado em'],
  ];
  const cells = cols.map(([k, label]) => {
    const sortable = kind === 'files' || k === 'name' || k === 'date';
    const on = sortable && S.sort.key === k;
    return sortable
      ? `<button type="button" class="lh lh-${k}${on ? ' on' : ''}" data-sort="${k}">${label}${on ? icon(S.sort.dir > 0 ? 'chevronUp' : 'chevronDown') : ''}</button>`
      : `<span class="lh lh-${k}">${label}</span>`;
  }).join('');
  return `<div class="list-head"><span class="lh lh-icon"></span>${cells}</div>`;
}

function folderCard(f, i) {
  return `<a class="card card-folder" href="${esc(P.dirUrl(f.path))}" data-idx="${i}" tabindex="${i ? -1 : 0}" title="${esc(f.name)}" draggable="false">
      <div class="fcover"><div class="fmosaic"></div><span class="fcover-icon">${icon('folder')}</span></div>
      <div class="card-text">
        <span class="card-name">${esc(f.name)}</span>
        <span class="card-sub">&nbsp;</span>
      </div>
      <span class="col col-type">Pasta</span>
      <span class="col col-size" data-items></span>
      <span class="col col-date">${esc(fmtDate(f.mtime))}</span>
    </a>`;
}

function fileCard(f, i) {
  let badge = '';
  if (f.kind === 'video') badge = `<span class="badge badge-video">${icon('play')}<span class="dur"></span></span>`;
  else if (f.ext === 'gif') badge = '<span class="badge">GIF</span>';
  return `<a class="card card-file" href="${esc(P.fileUrl(S.dir.path, f.name))}" data-idx="${i}" tabindex="${i ? -1 : 0}" title="${esc(f.name)}" draggable="false">
      <div class="thumb is-${f.kind}">
        <img alt="" decoding="async" draggable="false">
        <span class="thumb-fallback">${icon(f.kind === 'video' ? 'video' : 'image')}<span class="thumb-ext">${esc(f.ext.toUpperCase())}</span></span>
        ${badge}
      </div>
      <div class="card-text"><span class="card-name">${esc(f.name)}</span></div>
      <span class="col col-type">${esc(typeLabel(f))}</span>
      <span class="col col-size">${esc(fmtSize(f.size))}</span>
      <span class="col col-date">${esc(fmtDate(f.mtime))}</span>
    </a>`;
}

function stateHtml(ic, title, textHtml, actionsHtml = '') {
  return `<div class="state">
      <div class="state-icon">${icon(ic)}</div>
      <h2>${title}</h2>
      <p>${textHtml}</p>
      ${actionsHtml ? `<div class="state-actions">${actionsHtml}</div>` : ''}
    </div>`;
}

function disconnectObservers() {
  if (S.thumbObs) S.thumbObs.disconnect();
  if (S.peekObs) S.peekObs.disconnect();
  S.thumbObs = null;
  S.peekObs = null;
}

function renderSections() {
  const box = $('#sections');
  if (!box) return;
  const prevSel = selectedName();
  disconnectObservers();
  const counts = computeVisible();
  syncToolbar(counts);

  const nF = S.folders.length;
  const query = S.query.trim();
  let html = '';
  if (nF) {
    html += `<section class="section" aria-label="Pastas">
        <h2 class="section-title">${icon('folder')}Pastas<span class="pill">${fmtNumber(nF)}</span></h2>
        ${listHead('folders')}
        <div class="grid grid-folders">${S.folders.map((f, i) => folderCard(f, i)).join('')}</div>
      </section>`;
  }
  if (S.files.length) {
    const hasImages = S.files.some((f) => f.kind === 'image');
    const hasVideos = S.files.some((f) => f.kind === 'video');
    const title = hasImages && hasVideos ? 'Imagens e vídeos' : hasVideos ? 'Vídeos' : 'Imagens';
    html += `<section class="section" aria-label="${title}">
        <h2 class="section-title">${icon(hasImages ? 'image' : 'video')}${title}<span class="pill">${fmtNumber(S.files.length)}</span></h2>
        ${listHead('files')}
        <div class="grid grid-files">${S.files.map((f, i) => fileCard(f, nF + i)).join('')}</div>
      </section>`;
  } else if (nF && (query || (S.filter !== 'all' && counts.all))) {
    const what = S.filter === 'image' ? 'Nenhuma imagem' : S.filter === 'video' ? 'Nenhum vídeo' : 'Nenhum arquivo';
    html += `<p class="note">${icon('filter')}${what} ${query ? `corresponde a “${esc(query)}”` : 'nesta pasta'}.</p>`;
  }

  if (!html) {
    const d = S.dir;
    if (query) {
      html = stateHtml('search', 'Nenhum resultado', `Nada nesta pasta corresponde a “${esc(query)}”.`,
        '<button class="btn btn-ghost" type="button" data-act="clear-search">Limpar busca</button>');
    } else if (S.filter !== 'all' && d.files.length) {
      const img = S.filter === 'image';
      html = stateHtml(img ? 'image' : 'video', img ? 'Nenhuma imagem aqui' : 'Nenhum vídeo aqui',
        `Esta pasta não tem ${img ? 'imagens' : 'vídeos'}.`,
        '<button class="btn btn-ghost" type="button" data-act="filter-all">Mostrar tudo</button>');
    } else {
      const extra = d.others
        ? ` ${esc(plural(d.others, 'outro arquivo foi ignorado', 'outros arquivos foram ignorados'))} por não ${d.others === 1 ? 'ser imagem ou vídeo' : 'serem imagens ou vídeos'}.`
        : '';
      html = stateHtml('folder', 'Nada para mostrar aqui', `Esta pasta não tem subpastas, imagens ou vídeos.${extra}`,
        `<button class="btn btn-ghost" type="button" data-act="up">${icon('levelUp')}Subir um nível</button>`);
    }
  }

  box.innerHTML = html;
  box.classList.toggle('is-list', S.viewMode === 'list');
  S.items = $$('[data-idx]', box);
  S.sel = -1;

  S.thumbObs = createThumbObserver({ root: el.content, margin: '900px 0px' });
  for (let i = nF; i < S.items.length; i++) {
    const card = S.items[i];
    const f = S.files[i - nF];
    S.thumbObs.observe(card, f, (res) => applyThumb(card, f, res));
  }
  S.peekObs = createPeekObserver();
  for (let i = 0; i < nF; i++) S.peekObs.observe(S.items[i], S.folders[i]);
  trimThumbs(S.dir.files);

  if (prevSel) selectByName(prevSel, { focus: false, scroll: false });
}

function applyThumb(card, f, res) {
  const th = card.querySelector('.thumb');
  if (!th) return;
  if (!res) {
    th.classList.add('failed');
    return;
  }
  const img = th.querySelector('img');
  img.onload = () => th.classList.add('ready');
  img.onerror = () => th.classList.add('failed');
  img.src = res.url;
  if (f.kind === 'video' && res.dur) {
    const d = th.querySelector('.dur');
    if (d) d.textContent = fmtDuration(res.dur);
  }
}

/* ------------------------------------------- resumo das subpastas (capa) */

const peekCache = new Map();

function loadPeek(f) {
  const key = `${f.path}|${f.mtime}`;
  if (peekCache.has(key)) return Promise.resolve(peekCache.get(key));
  return api.peek(f.path)
    .then((p) => { peekCache.set(key, p); return p; })
    .catch((err) => {
      const p = { error: (err && err.code) || 'error' };
      if (err && err.status) peekCache.set(key, p);
      return p;
    });
}

function createPeekObserver() {
  const queue = [];
  const recs = new Map();
  let active = 0;
  let dead = false;
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      queue.push(e.target);
    }
    pump();
  }, { root: el.content, rootMargin: '500px 0px' });

  function pump() {
    while (!dead && active < 2 && queue.length) {
      const card = queue.shift();
      const f = recs.get(card);
      if (!f || !card.isConnected) continue;
      active++;
      loadPeek(f)
        .then((p) => { if (!dead && card.isConnected) applyPeek(card, p); })
        .finally(() => { active--; pump(); });
    }
  }

  return {
    observe(card, f) {
      const cached = peekCache.get(`${f.path}|${f.mtime}`);
      if (cached) { applyPeek(card, cached); return; }
      recs.set(card, f);
      io.observe(card);
    },
    disconnect() {
      dead = true;
      io.disconnect();
      queue.length = 0;
      recs.clear();
    },
  };
}

function applyPeek(card, p) {
  const sub = card.querySelector('.card-sub');
  const items = card.querySelector('[data-items]');
  const cover = card.querySelector('.fcover');
  if (p.error) {
    const t = p.error === 'forbidden' ? 'Sem acesso' : 'Indisponível';
    sub.textContent = t;
    items.textContent = t;
    cover.classList.add('is-locked');
    cover.querySelector('.fcover-icon').innerHTML = icon('lock');
    return;
  }
  const parts = [];
  if (p.images) parts.push(plural(p.images, 'imagem', 'imagens'));
  if (p.videos) parts.push(plural(p.videos, 'vídeo', 'vídeos'));
  if (p.folders) parts.push(plural(p.folders, 'pasta', 'pastas'));
  const total = p.images + p.videos + p.folders;
  sub.textContent = parts.length ? parts.join(' · ') : 'Vazia';
  sub.title = sub.textContent;
  items.textContent = total ? plural(total, 'item', 'itens') : 'Vazia';
  cover.classList.toggle('is-empty', !total);

  if (p.preview && p.preview.length) {
    const mosaic = cover.querySelector('.fmosaic');
    mosaic.dataset.n = String(p.preview.length);
    mosaic.innerHTML = p.preview.map((pf) => `<span class="ftile is-${pf.kind}"><img alt="" decoding="async" draggable="false">${pf.kind === 'video' ? `<span class="ftile-play">${icon('play')}</span>` : ''}</span>`).join('');
    cover.classList.add('has-preview');
    p.preview.forEach((pf, i) => {
      const tile = mosaic.children[i];
      const done = (res) => {
        if (!res) { tile.classList.add('failed'); return; }
        const img = tile.querySelector('img');
        img.onload = () => tile.classList.add('ready');
        img.onerror = () => tile.classList.add('failed');
        img.src = res.url;
      };
      const hit = peekThumb(pf);
      if (hit) done(hit);
      else requestThumb(pf, done);
    });
  }
}

/* ============================================================ seleção */

function itemName(i) {
  const nF = S.folders.length;
  if (S.page !== 'dir') return '';
  return i < nF ? S.folders[i].name : (S.files[i - nF] || {}).name || '';
}

function selectedName() {
  return S.page === 'dir' && S.sel >= 0 && S.sel < S.items.length ? itemName(S.sel) : null;
}

function findFile(name) {
  if (!S.dir || !name) return null;
  return S.dir.files.find((f) => f.name === name) || S.dir.files.find((f) => P.sameName(f.name, name)) || null;
}

function findIndexByName(name) {
  let i = S.folders.findIndex((f) => f.name === name);
  if (i < 0) i = S.folders.findIndex((f) => P.sameName(f.name, name));
  if (i >= 0) return i;
  i = S.files.findIndex((f) => f.name === name);
  if (i < 0) i = S.files.findIndex((f) => P.sameName(f.name, name));
  return i >= 0 ? S.folders.length + i : -1;
}

function selectByName(name, opts) {
  const i = findIndexByName(name);
  if (i >= 0) setSel(i, opts);
  return i;
}

function setSel(i, { focus = true, scroll = true, center = false } = {}) {
  const items = S.items;
  if (!items.length) { S.sel = -1; return; }
  const n = clamp(i, 0, items.length - 1);
  const prev = items[S.sel];
  if (prev && prev !== items[n]) {
    prev.classList.remove('is-sel');
    prev.tabIndex = -1;
  }
  const cur = items[n];
  cur.classList.add('is-sel');
  cur.tabIndex = 0;
  if (n !== 0 && items[0] !== cur && S.page === 'dir') items[0].tabIndex = -1;
  S.sel = n;
  if (focus) cur.focus({ preventScroll: true });
  if (scroll) cur.scrollIntoView({ block: center ? 'center' : 'nearest', inline: 'nearest' });
}

function colsOf(gridSel) {
  if (S.viewMode === 'list') return 1;
  const grid = $(gridSel, el.content);
  if (!grid) return 1;
  return Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length);
}

function moveSel(key) {
  const n = S.items.length;
  if (!n) return;
  if (S.page !== 'dir') {
    // Página inicial: navegação linear entre os cartões.
    const cur = S.items.indexOf(document.activeElement);
    const step = key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1;
    const next = cur < 0 ? 0 : clamp(cur + step, 0, n - 1);
    S.items[next].focus();
    return;
  }
  if (S.sel < 0 || S.sel >= n) { setSel(0); return; }
  const nF = S.folders.length;
  const nM = S.files.length;
  const inFolders = S.sel < nF;
  const offset = inFolders ? 0 : nF;
  const count = inFolders ? nF : nM;
  const local = S.sel - offset;
  const cols = colsOf(inFolders ? '.grid-folders' : '.grid-files');
  let i = S.sel;

  if (key === 'ArrowLeft') i = S.sel - 1;
  else if (key === 'ArrowRight') i = S.sel + 1;
  else if (key === 'ArrowDown') {
    const lastRowStart = Math.floor((count - 1) / cols) * cols;
    if (local + cols < count) i = S.sel + cols;
    else if (local < lastRowStart) i = offset + count - 1; // próxima linha é mais curta
    else if (inFolders && nM) i = nF + Math.min(local % cols, nM - 1);
  } else if (key === 'ArrowUp') {
    if (local - cols >= 0) i = S.sel - cols;
    else if (!inFolders && nF) {
      const fcols = colsOf('.grid-folders');
      const lastRowStart = Math.floor((nF - 1) / fcols) * fcols;
      i = Math.min(lastRowStart + (local % cols), nF - 1);
    }
  }
  setSel(clamp(i, 0, n - 1));
}

function activate(i) {
  if (S.page !== 'dir') return;
  const card = S.items[i];
  if (!card) return;
  setSel(i, { focus: true, scroll: false });
  const nF = S.folders.length;
  if (i < nF) navigateTo(S.folders[i].path);
  else openFromGrid(S.files[i - nF]);
}

let taBuf = '';
let taTime = 0;
function typeahead(ch) {
  if (S.page !== 'dir' || !S.items.length) return;
  const now = Date.now();
  taBuf = now - taTime > 900 ? ch : taBuf + ch;
  taTime = now;
  const q = fold(taBuf);
  const n = S.items.length;
  const start = taBuf.length === 1 ? S.sel + 1 : Math.max(S.sel, 0);
  for (let k = 0; k < n; k++) {
    const i = (((start + k) % n) + n) % n;
    if (fold(itemName(i)).startsWith(q)) {
      setSel(i);
      return;
    }
  }
}

/* ============================================================ visualizador */

function openFromGrid(f) {
  if (!f) return;
  rememberViewState();
  pushOrReplace(P.fileUrl(S.dir.path, f.name), false, { fromGrid: true });
  openViewer(f);
}

function openViewer(f) {
  if (!f || !viewer) return;
  const list = S.files.includes(f) ? S.files : allFilesSorted();
  viewer.open(list, list.indexOf(f));
  updateTitle(f);
}

// Usado quando o arquivo aberto está escondido pelo filtro/busca atual.
function allFilesSorted() {
  return [...S.dir.files].sort((a, b) => collator.compare(a.name, b.name));
}

function onViewerChange(f) {
  history.replaceState(history.state, '', P.fileUrl(S.dir.path, f.name));
  updateTitle(f);
  const i = findIndexByName(f.name);
  if (i >= 0) setSel(i, { focus: false, scroll: true });
}

function closeViewerFromUI() {
  if (!viewer || !viewer.isOpen()) return;
  const st = history.state || {};
  const f = viewer.current();
  viewer.close();
  afterViewerClosed(f);
  if (st.fromGrid) {
    // Volta para a entrada da pasta no histórico (o "Avançar" reabre o arquivo).
    S.awaitingPop = true;
    history.back();
    setTimeout(() => {
      if (S.awaitingPop) {
        S.awaitingPop = false;
        const cb = S.afterPop;
        S.afterPop = null;
        if (cb) cb();
      }
    }, 700);
  } else if (S.dir) {
    pushOrReplace(P.dirUrl(S.dir.path), true);
  }
}

function closeViewerSilently() {
  if (!viewer || !viewer.isOpen()) return;
  const f = viewer.current();
  viewer.close();
  afterViewerClosed(f);
}

function afterViewerClosed(f) {
  updateTitle();
  if (f && S.page === 'dir') {
    const i = findIndexByName(f.name);
    if (i >= 0) { setSel(i, { focus: true, scroll: true }); return; }
  }
  el.content.focus({ preventScroll: true });
}

function updateTitle(f) {
  const app = 'Visualizador de Pastas';
  if (f && S.dir) document.title = `${f.name} — ${titleFor(S.dir.path, S.dir.name)}`;
  else if (S.page === 'dir' && S.dir) document.title = `${titleFor(S.dir.path, S.dir.name)} — ${app}`;
  else if (S.page === 'error') document.title = `Não foi possível abrir — ${app}`;
  else document.title = app;
}

/* =================================================================== início */

function showHome() {
  disconnectObservers();
  endPathEdit();
  S.page = 'home';
  S.dir = null;
  S.errorPath = null;
  S.sel = -1;
  S.query = '';
  el.search.value = '';
  renderHome();
  updateCrumbs();
  markNavActive();
  updateTitle();
  updateNavButtons();
  setSearchEnabled(false);
  el.content.scrollTop = 0;
  canonicalize('/');
}

function placeCard(path, name, ic, variant, subtitle) {
  return `<a class="place place-${variant}" href="${esc(P.dirUrl(path))}" data-path="${esc(path)}" title="${esc(path)}">
      <span class="place-icon">${icon(ic)}</span>
      <span class="place-text">
        <span class="place-name">${esc(name)}</span>
        <span class="place-path">${esc(subtitle != null ? subtitle : path)}</span>
      </span>
    </a>`;
}

function driveCard(d) {
  const used = d.total ? clamp(((d.total - d.free) / d.total) * 100, 0, 100) : 0;
  const warn = used >= 90 ? ' is-full' : '';
  return `<a class="place place-drive" href="${esc(P.dirUrl(d.path))}" data-path="${esc(d.path)}" title="${esc(d.path)}">
      <span class="place-icon">${icon(DRIVE_ICONS[d.type] || 'drive')}</span>
      <span class="place-text">
        <span class="place-name">${esc(driveLabel(d))}</span>
        ${d.total ? `<span class="usage${warn}"><span class="usage-bar" style="width:${used.toFixed(1)}%"></span></span>
        <span class="place-path">${esc(fmtSize(d.free))} livres de ${esc(fmtSize(d.total))}</span>` : ''}
      </span>
    </a>`;
}

function homeSection(title, ic, inner, action = '', cls = '') {
  return `<section class="home-section ${cls}">
      <div class="home-section-head"><h2 class="section-title">${icon(ic)}${title}</h2>${action}</div>
      <div class="place-grid">${inner}</div>
    </section>`;
}

function renderHome() {
  const h = S.home;
  const user = (S.info && S.info.home && P.base(S.info.home)) || 'Você';
  const example = isWin() ? `C:\\Users\\${user}\\Pictures` : `${(S.info && S.info.home) || '/home'}/Imagens`;
  let html = `
    <div class="page page-home">
      <section class="hero">
        <div class="hero-text">
          <span class="hero-eyebrow">${icon('sparkles')}Imagens e vídeos do seu computador</span>
          <h1>Escolha uma pasta para começar</h1>
          <p>Navegue pelas subpastas, veja tudo em uma grade organizada e clique em um arquivo para visualizá-lo.
             Para voltar, use <kbd>Backspace</kbd> ou o botão Voltar do navegador.</p>
          <div class="hero-actions">
            <button class="btn btn-primary btn-lg" type="button" data-act="pick">${icon('folderPlus')}Escolher pasta…</button>
            <form class="hero-path" data-form="path" autocomplete="off">
              ${icon('folder')}
              <input name="p" type="text" spellcheck="false" placeholder="ou cole um caminho, ex.: ${esc(example)}" aria-label="Caminho de uma pasta">
              <button class="btn btn-soft" type="submit">Abrir</button>
            </form>
          </div>
        </div>
        <div class="hero-art" aria-hidden="true">
          <div class="art art-1">${icon('image')}</div>
          <div class="art art-2">${icon('play')}</div>
          <div class="art art-3">${icon('folder')}</div>
        </div>
      </section>`;

  if (S.favorites.length) {
    html += homeSection('Favoritos', 'star', S.favorites.map((f) => placeCard(f.path, f.name, 'starFill', 'fav')).join(''));
  }
  if (S.recents.length) {
    html += homeSection('Recentes', 'clock', S.recents.slice(0, 8).map((r) => placeCard(r.path, r.name, 'folder', 'recent')).join(''),
      '<button class="link-btn" type="button" data-act="clear-recents">Limpar</button>');
  }
  if (h) {
    if (h.places.length) {
      html += homeSection('Acesso rápido', 'home', h.places.map((p) => placeCard(p.path, p.name, PLACE_ICONS[p.id] || 'folder', 'quick')).join(''));
    }
    if (h.drives.length) {
      html += homeSection('Este computador', 'monitor', h.drives.map(driveCard).join(''), '', 'drives');
    }
  } else {
    html += `<section class="home-section"><div class="place-grid">${'<div class="place place-skeleton"></div>'.repeat(4)}</div></section>`;
  }
  html += `
      <section class="tips">
        <div class="tip"><kbd>Enter</kbd> abre a pasta ou o arquivo selecionado</div>
        <div class="tip"><kbd>Backspace</kbd> volta para a pasta anterior</div>
        <div class="tip"><kbd>←</kbd> <kbd>→</kbd> trocam de arquivo no visualizador</div>
        <div class="tip"><kbd>?</kbd> mostra todos os atalhos</div>
      </section>
    </div>`;
  el.content.innerHTML = html;
  S.items = $$('.place[data-path]', el.content);
}

/* ============================================================ página de erro */

function showError(err, target) {
  disconnectObservers();
  endPathEdit();
  S.page = 'error';
  S.dir = null;
  S.errorPath = target;
  S.items = [];
  S.sel = -1;
  const code = err.code || (err.data && err.data.error);
  const titles = {
    forbidden: 'Acesso negado', not_found: 'Pasta não encontrada', invalid: 'Endereço inválido',
    unavailable: 'Unidade indisponível', busy: 'Local ocupado',
  };
  const icons = { forbidden: 'lock', not_found: 'folder', invalid: 'alert' };
  const nearest = err.data && err.data.nearest;
  const actions = [];
  if (nearest) {
    actions.push(`<button class="btn btn-primary" type="button" data-act="go" data-path="${esc(nearest)}">${icon('folderOpen')}Ir para “${esc(titleFor(nearest))}”</button>`);
  }
  if (err.status !== 404 && code !== 'invalid') actions.push(`<button class="btn btn-ghost" type="button" data-act="retry">${icon('refresh')}Tentar novamente</button>`);
  actions.push(`<button class="btn btn-ghost" type="button" data-act="home">${icon('home')}Ir para o início</button>`);
  el.content.innerHTML = `<div class="page page-state">${stateHtml(icons[code] || 'alert', titles[code] || 'Não foi possível abrir',
    `${esc(errorMessage(err))}${target ? `<code class="state-path">${esc(target)}</code>` : ''}`, actions.join(''))}</div>`;
  updateCrumbs();
  markNavActive();
  updateTitle();
  updateNavButtons();
  setSearchEnabled(false);
  el.content.focus({ preventScroll: true });
}

/* ============================================================ barra de caminho */

function updateCrumbs() {
  const p = S.page === 'dir' && S.dir ? S.dir.path : S.page === 'error' ? S.errorPath : null;
  const home = `<a class="crumb crumb-home${p ? '' : ' is-last'}" href="/" data-home title="Início">${icon('home')}${p ? '' : '<span>Início</span>'}</a>`;
  if (!p) {
    el.crumbs.innerHTML = home;
    return;
  }
  const parts = P.crumbs(p);
  const sep = `<span class="crumb-sep">${icon('chevronRight')}</span>`;
  el.crumbs.innerHTML = home + parts.map((c, i) => {
    const last = i === parts.length - 1;
    let label = esc(c.name);
    if (c.root) {
      const d = driveFor(c.path);
      label = `${icon(d ? DRIVE_ICONS[d.type] || 'drive' : 'drive')}<span>${esc(d ? driveLabel(d) : c.name)}</span>`;
    }
    return `${sep}<a class="crumb${last ? ' is-last' : ''}${c.root ? ' crumb-root' : ''}" href="${esc(P.dirUrl(c.path))}" data-path="${esc(c.path)}" title="${esc(c.path)}">${label}</a>`;
  }).join('');
  el.crumbs.scrollLeft = el.crumbs.scrollWidth;
  updateCrumbsFade();
}

function updateCrumbsFade() {
  el.crumbs.classList.toggle('is-cut', el.crumbs.scrollLeft > 2);
}

function startPathEdit() {
  el.pathbar.classList.add('editing');
  el.pathInput.hidden = false;
  el.pathInput.value = S.page === 'dir' && S.dir ? S.dir.path : S.errorPath || '';
  el.pathInput.focus();
  el.pathInput.select();
}

function endPathEdit() {
  if (!el.pathbar.classList.contains('editing')) return;
  el.pathbar.classList.remove('editing');
  el.pathInput.hidden = true;
}

function setSearchEnabled(on) {
  el.search.disabled = !on;
  el.searchBox.classList.toggle('is-disabled', !on);
  el.search.placeholder = on ? 'Buscar nesta pasta' : 'Abra uma pasta para buscar';
}

/* ============================================================ barra lateral */

function navItem(path, name, ic) {
  return `<a class="nav-item" href="${esc(P.dirUrl(path))}" data-path="${esc(path)}" title="${esc(path)}">${icon(ic)}<span>${esc(name)}</span></a>`;
}

function renderNav() {
  const h = S.home;
  let html = `<div class="nav-group"><a class="nav-item" href="/" data-home>${icon('home')}<span>Início</span></a></div>`;
  html += '<div class="nav-group"><div class="nav-label">Favoritos</div>';
  html += S.favorites.length
    ? S.favorites.map((f) => `<div class="nav-row">${navItem(f.path, f.name, 'starFill')}<button class="nav-x" type="button" data-unfav="${esc(f.path)}" title="Remover dos favoritos" aria-label="Remover ${esc(f.name)} dos favoritos">${icon('x')}</button></div>`).join('')
    : `<div class="nav-empty">Clique em ${icon('star')} <b>Favoritar</b> numa pasta para fixá-la aqui.</div>`;
  html += '</div>';
  if (h) {
    if (h.places.length) {
      html += `<div class="nav-group"><div class="nav-label">Acesso rápido</div>${h.places.map((p) => navItem(p.path, p.name, PLACE_ICONS[p.id] || 'folder')).join('')}</div>`;
    }
    if (h.drives.length) {
      html += `<div class="nav-group"><div class="nav-label">Este computador</div>${h.drives.map((d) => {
        const used = d.total ? clamp(((d.total - d.free) / d.total) * 100, 0, 100) : 0;
        return `<a class="nav-item nav-drive" href="${esc(P.dirUrl(d.path))}" data-path="${esc(d.path)}" title="${esc(d.total ? `${fmtSize(d.free)} livres de ${fmtSize(d.total)}` : d.path)}">
            ${icon(DRIVE_ICONS[d.type] || 'drive')}
            <span class="nav-drive-text"><span>${esc(driveLabel(d))}</span>${d.total ? `<span class="usage${used >= 90 ? ' is-full' : ''}"><span class="usage-bar" style="width:${used.toFixed(1)}%"></span></span>` : ''}</span>
          </a>`;
      }).join('')}</div>`;
    }
  } else {
    html += `<div class="nav-group"><div class="nav-label">Carregando…</div>${'<div class="nav-skeleton"></div>'.repeat(4)}</div>`;
  }
  el.nav.innerHTML = html;
  markNavActive();
}

function markNavActive() {
  const cur = S.page === 'dir' && S.dir ? S.dir.path : null;
  let best = null;
  let bestLen = -1;
  for (const a of $$('.nav-item', el.nav)) {
    a.classList.remove('active');
    a.removeAttribute('aria-current');
    if (a.hasAttribute('data-home')) {
      if (S.page === 'home') best = a;
      continue;
    }
    const p = a.dataset.path;
    if (cur && p && P.within(cur, p) && p.length > bestLen) {
      best = a;
      bestLen = p.length;
    }
  }
  if (best) {
    best.classList.add('active');
    best.setAttribute('aria-current', 'page');
  }
}

const narrow = window.matchMedia('(max-width: 900px)');

function toggleSidebar() {
  if (narrow.matches) {
    el.app.classList.toggle('sidebar-open');
  } else {
    const collapsed = !el.app.classList.contains('sidebar-collapsed');
    el.app.classList.toggle('sidebar-collapsed', collapsed);
    store.set('painelRecolhido', collapsed);
  }
}

function closeSidebarOverlay() {
  el.app.classList.remove('sidebar-open');
}

/* ============================================================ favoritos e recentes */

function isFavorite(p) {
  return S.favorites.some((f) => P.same(f.path, p));
}

function toggleFavorite() {
  const d = S.dir;
  if (!d) return;
  if (isFavorite(d.path)) {
    S.favorites = S.favorites.filter((f) => !P.same(f.path, d.path));
    toast('Pasta removida dos favoritos');
  } else {
    S.favorites = [...S.favorites, { path: d.path, name: titleFor(d.path, d.name) }];
    toast('Pasta adicionada aos favoritos', 'success');
  }
  store.set('favoritos', S.favorites);
  renderNav();
  renderFolderHead();
}

function removeFavorite(p) {
  S.favorites = S.favorites.filter((f) => !P.same(f.path, p));
  store.set('favoritos', S.favorites);
  renderNav();
  if (S.page === 'dir') renderFolderHead();
  if (S.page === 'home') renderHome();
}

function recordRecent(d) {
  const entry = { path: d.path, name: titleFor(d.path, d.name), t: Date.now() };
  S.recents = [entry, ...S.recents.filter((r) => !P.same(r.path, d.path))].slice(0, 12);
  store.set('recentes', S.recents);
}

/* ============================================================ ações */

async function pickFolder() {
  if (S.picking) return;
  if (!isWin()) {
    toast('Use a barra lateral para navegar pelas unidades ou cole um caminho no campo de endereço.');
    return;
  }
  S.picking = true;
  openModal(el.pickModal);
  try {
    const r = await api.pick(S.page === 'dir' && S.dir ? S.dir.path : '');
    closeModal(el.pickModal);
    if (r && r.path) await navigateTo(r.path);
  } catch (err) {
    closeModal(el.pickModal);
    toast(errorMessage(err), 'error', 5000);
  } finally {
    S.picking = false;
  }
}

async function openExternal(p) {
  try {
    await api.open(p);
    toast('Abrindo no aplicativo padrão…', 'info', 2200);
  } catch (err) {
    toast(errorMessage(err), 'error', 5000);
  }
}

async function reveal(p) {
  try {
    await api.reveal(p);
  } catch (err) {
    toast(errorMessage(err), 'error', 5000);
  }
}

async function softRefresh({ silent = false } = {}) {
  if (S.page !== 'dir' || !S.dir || S.refreshing || (viewer && viewer.isOpen())) return;
  S.refreshing = true;
  const path = S.dir.path;
  try {
    const data = await api.list(path);
    if (S.page !== 'dir' || !S.dir || !P.same(S.dir.path, path) || (viewer && viewer.isOpen())) return;
    S.loadedAt = Date.now();
    const sig = signature(data);
    if (sig !== S.sig) {
      const scroll = el.content.scrollTop;
      S.dir = prepare(data);
      S.sig = sig;
      renderFolderHead();
      renderToolbar();
      renderSections();
      el.content.scrollTop = scroll;
    }
    if (!silent) toast('Pasta atualizada', 'success', 1800);
  } catch (err) {
    if (!silent) toast(errorMessage(err), 'error');
  } finally {
    S.refreshing = false;
  }
}

function refresh() {
  if (S.page === 'dir') {
    peekCache.clear();
    softRefresh({ silent: false });
  } else if (S.page === 'home') {
    loadHome(true).then(() => toast('Unidades atualizadas', 'success', 1800));
  } else {
    route();
  }
}

function setFilter(f) {
  if (S.filter === f) return;
  S.filter = f;
  renderSections();
}

function setView(v) {
  if (S.viewMode === v) return;
  S.viewMode = v;
  const box = $('#sections');
  if (box) box.classList.toggle('is-list', v === 'list');
  syncToolbar();
  const cur = S.items[S.sel];
  if (cur) cur.scrollIntoView({ block: 'nearest' });
}

function setSort(key, dir) {
  if (!DEFAULT_DIR[key]) return;
  S.sort = { key, dir: dir || (S.sort.key === key ? S.sort.dir : DEFAULT_DIR[key]) };
  store.set('ordem', S.sort);
  if (S.page === 'dir') renderSections();
}

function setTile(v) {
  S.tile = clamp(Math.round(v / 10) * 10, TILE_MIN, TILE_MAX);
  store.set('tamanho', S.tile);
  applyTile();
  const r = $('#tileSize');
  if (r) r.value = String(S.tile);
}

function applyTile() {
  el.content.style.setProperty('--tile', `${S.tile}px`);
}

function setQuery(v, updateInput = true) {
  S.query = v;
  if (updateInput) el.search.value = v;
  if (S.page === 'dir') renderSections();
}

function clearRecents() {
  S.recents = [];
  store.set('recentes', []);
  if (S.page === 'home') renderHome();
}

function focusSearch() {
  if (el.search.disabled) return;
  el.search.focus();
  el.search.select();
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  store.set('tema', next);
  updateThemeBtn();
}

function updateThemeBtn() {
  const dark = document.documentElement.dataset.theme !== 'light';
  setBtn(el.themeBtn, dark ? 'sun' : 'moon', dark ? 'Usar tema claro' : 'Usar tema escuro');
}

/* ============================================================ janelas (modais) */

function openModal(m) {
  m.hidden = false;
  requestAnimationFrame(() => m.classList.add('shown'));
  const focusable = m.querySelector('[data-close]');
  if (focusable) focusable.focus();
}

function closeModal(m) {
  m.classList.remove('shown');
  m.hidden = true;
}

const openModalEl = () => $$('.modal').find((m) => !m.hidden) || null;

function renderHelp() {
  const k = (...keys) => keys.map((x) => `<kbd>${x}</kbd>`).join('<span class="plus">+</span>');
  const row = (keys, text) => `<div class="help-row"><div class="help-keys">${keys}</div><div class="help-text">${text}</div></div>`;
  const or = '<span class="or">ou</span>';
  $('#helpBody').innerHTML = `
    <section>
      <h3>${icon('folder')}Nas pastas</h3>
      ${row(`${k('←')}${k('↑')}${k('→')}${k('↓')}`, 'Mover a seleção')}
      ${row(k('Enter'), 'Abrir a pasta ou visualizar o arquivo')}
      ${row(k('Backspace'), 'Voltar um nível (pasta de cima)')}
      ${row(`${k('Alt', '←')}${or}${k('Alt', '→')}`, 'Voltar / avançar no histórico')}
      ${row(`${k('Home')}${or}${k('End')}`, 'Primeiro / último item')}
      ${row(k('/'), 'Buscar nesta pasta')}
      ${row(`${k('+')}${or}${k('−')}`, 'Aumentar / diminuir os ícones')}
      ${row(k('A–Z'), 'Ir ao item que começa com a letra')}
    </section>
    <section>
      <h3>${icon('image')}No visualizador</h3>
      ${row(`${k('←')}${or}${k('→')}`, 'Arquivo anterior / próximo')}
      ${row(`${k('Esc')}${or}${k('Backspace')}`, 'Fechar e voltar à pasta')}
      ${row(`${k('+')}${k('−')}${k('0')}`, 'Zoom (ou roda do mouse) · 0 ajusta à tela')}
      ${row('<span class="help-mouse">Duplo clique</span>', 'Alternar entre ajustado e tamanho real')}
      ${row(k('R'), 'Girar a imagem')}
      ${row(k('F'), 'Tela cheia')}
      ${row(k('I'), 'Painel de informações')}
      ${row(k('Espaço'), 'Reproduzir / pausar o vídeo')}
      ${row(`${k('Shift', '←')}${or}${k('Shift', '→')}`, 'Voltar / avançar 5 segundos')}
      ${row(`${k('↑')}${or}${k('↓')}`, 'Volume do vídeo')}
      ${row(k('M'), 'Ativar / desativar o som')}
    </section>`;
}

/* ============================================================ eventos */

function bindEvents() {
  window.addEventListener('keydown', onKeyDown, true);

  document.addEventListener('click', (e) => {
    if (e.target.closest('#viewer')) return;

    const unfav = e.target.closest('[data-unfav]');
    if (unfav) {
      e.preventDefault();
      removeFavorite(unfav.dataset.unfav);
      return;
    }

    const a = e.target.closest('a[href]');
    if (a && !e.defaultPrevented) {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return; // nova aba/janela
      if (a.dataset.idx != null && el.content.contains(a)) {
        e.preventDefault();
        activate(Number(a.dataset.idx));
        return;
      }
      if (a.hasAttribute('data-home')) {
        e.preventDefault();
        closeSidebarOverlay();
        goHome();
        return;
      }
      if (a.dataset.path) {
        e.preventDefault();
        closeSidebarOverlay();
        navigateTo(a.dataset.path);
        return;
      }
      return;
    }

    const b = e.target.closest('[data-act]');
    if (b) {
      switch (b.dataset.act) {
        case 'pick': pickFolder(); break;
        case 'fav': toggleFavorite(); break;
        case 'explorer': if (S.dir) openExternal(S.dir.path); break;
        case 'up': goUp(); break;
        case 'home': goHome(); break;
        case 'retry': route(); break;
        case 'reload': location.reload(); break;
        case 'go': navigateTo(b.dataset.path); break;
        case 'clear-search': setQuery(''); break;
        case 'filter-all': setFilter('all'); break;
        case 'clear-recents': clearRecents(); break;
        default: break;
      }
      return;
    }

    const f = e.target.closest('[data-filter]');
    if (f) { setFilter(f.dataset.filter); return; }
    const v = e.target.closest('[data-view]');
    if (v) { setView(v.dataset.view); return; }
    const s = e.target.closest('[data-sort]');
    if (s) {
      const key = s.dataset.sort;
      setSort(key, S.sort.key === key ? -S.sort.dir : DEFAULT_DIR[key]);
      return;
    }
    if (e.target.closest('#sortDir')) { setSort(S.sort.key, -S.sort.dir); return; }

    const modal = e.target.closest('.modal');
    if (modal && (e.target === modal || e.target.closest('[data-close]')) && modal !== el.pickModal) closeModal(modal);
  });

  el.content.addEventListener('change', (e) => {
    if (e.target.id === 'sortKey') setSort(e.target.value, DEFAULT_DIR[e.target.value]);
  });
  el.content.addEventListener('input', (e) => {
    if (e.target.id === 'tileSize') setTile(Number(e.target.value));
  });
  el.content.addEventListener('submit', (e) => {
    const form = e.target.closest('[data-form="path"]');
    if (!form) return;
    e.preventDefault();
    const value = form.elements.p.value.trim();
    if (value) navigateTo(value);
  });
  el.content.addEventListener('focusin', (e) => {
    const card = e.target.closest('[data-idx]');
    if (card && S.page === 'dir') {
      const i = Number(card.dataset.idx);
      if (i !== S.sel) setSel(i, { focus: false, scroll: false });
    }
  });

  el.search.addEventListener('input', debounce(() => setQuery(el.search.value, false), 90));

  el.pathbar.addEventListener('click', (e) => {
    if (e.target.closest('a, input')) return;
    startPathEdit();
  });
  el.pathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = el.pathInput.value.trim();
      endPathEdit();
      if (!v) goHome();
      else navigateTo(v);
    }
  });
  el.pathInput.addEventListener('blur', () => setTimeout(endPathEdit, 120));
  el.crumbs.addEventListener('scroll', updateCrumbsFade, { passive: true });
  window.addEventListener('resize', debounce(() => {
    el.crumbs.scrollLeft = el.crumbs.scrollWidth;
    updateCrumbsFade();
  }, 150));

  el.menuBtn.addEventListener('click', toggleSidebar);
  el.scrim.addEventListener('click', closeSidebarOverlay);
  el.backBtn.addEventListener('click', () => history.back());
  el.fwdBtn.addEventListener('click', () => history.forward());
  el.upBtn.addEventListener('click', goUp);
  el.refreshBtn.addEventListener('click', refresh);
  el.pickBtn.addEventListener('click', () => { closeSidebarOverlay(); pickFolder(); });
  el.themeBtn.addEventListener('click', toggleTheme);
  el.helpBtn.addEventListener('click', () => openModal(el.helpModal));

  // Ao voltar para a aba, atualiza a pasta se algo mudou no disco.
  const onReturn = () => {
    if (!document.hidden && Date.now() - S.loadedAt > 2500) softRefresh({ silent: true });
  };
  window.addEventListener('focus', onReturn);
  document.addEventListener('visibilitychange', onReturn);
}

function isTyping(t) {
  if (!t) return false;
  if (t.isContentEditable || t.tagName === 'TEXTAREA') return true;
  return t.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button', 'submit'].includes(t.type);
}

function onKeyDown(e) {
  const modal = openModalEl();
  if (modal) {
    if (e.key === 'Escape' && modal !== el.pickModal) {
      e.preventDefault();
      closeModal(modal);
    }
    return;
  }
  if (viewer && viewer.isOpen()) {
    viewer.handleKey(e);
    return;
  }

  const t = e.target;
  if (isTyping(t)) {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (t === el.search) {
        if (el.search.value) setQuery('');
        else { el.search.blur(); el.content.focus({ preventScroll: true }); }
      } else if (t === el.pathInput) {
        endPathEdit();
        el.content.focus({ preventScroll: true });
      } else {
        t.blur();
      }
    } else if (t === el.search && (e.key === 'ArrowDown' || e.key === 'Enter') && S.items.length) {
      e.preventDefault();
      setSel(Math.max(S.sel, 0));
    }
    return;
  }

  if (e.ctrlKey || e.metaKey) return;
  if (e.altKey) {
    if (e.key === 'ArrowUp') { e.preventDefault(); goUp(); }
    return; // Alt+←/→ ficam com o navegador (histórico)
  }

  const tag = t && t.tagName;
  const isRange = tag === 'INPUT' && t.type === 'range';
  const isSelect = tag === 'SELECT';

  switch (e.key) {
    case 'Backspace':
      e.preventDefault();
      goUp();
      return;
    case 'ArrowLeft':
    case 'ArrowRight':
    case 'ArrowUp':
    case 'ArrowDown':
      if (isRange || isSelect) return;
      e.preventDefault();
      moveSel(e.key);
      return;
    case 'Home':
    case 'End':
      if (isRange || isSelect || !S.items.length) return;
      e.preventDefault();
      if (S.page === 'dir') setSel(e.key === 'Home' ? 0 : S.items.length - 1);
      else S.items[e.key === 'Home' ? 0 : S.items.length - 1].focus();
      return;
    case 'Enter':
    case ' ':
      if (tag === 'BUTTON' || isSelect || isRange) return;
      if (tag === 'A') { e.preventDefault(); t.click(); return; }
      if (S.page === 'dir' && S.sel >= 0) { e.preventDefault(); activate(S.sel); }
      else if (e.key === ' ') e.preventDefault();
      return;
    case 'Escape':
      closeSidebarOverlay();
      if (S.query) setQuery('');
      return;
    case '/':
      e.preventDefault();
      focusSearch();
      return;
    case '?':
      e.preventDefault();
      openModal(el.helpModal);
      return;
    case '+':
    case '=':
      if (S.page === 'dir' && !isRange) { e.preventDefault(); setTile(S.tile + TILE_STEP); }
      return;
    case '-':
    case '_':
      if (S.page === 'dir' && !isRange) { e.preventDefault(); setTile(S.tile - TILE_STEP); }
      return;
    default:
      if (e.key.length === 1 && /\S/.test(e.key) && !isSelect) typeahead(e.key);
  }
}
