// Janela de visualização de imagens e vídeos.
import { icon } from './icons.js';
import { fileSrc } from './api.js';
import { createThumbObserver, peekThumb } from './thumbs.js';
import { esc, clamp, fmtSize, fmtDateLong, fmtDuration, fmtNumber, store } from './util.js';
import * as P from './paths.js';

const PAD = 20;           // margem entre a mídia e as bordas da área de exibição
const MAX_NATURAL = 8;    // zoom máximo: 800% do tamanho real

const TYPE_NAMES = {
  jpg: 'JPEG', jpeg: 'JPEG', jpe: 'JPEG', jfif: 'JPEG', pjpeg: 'JPEG', pjp: 'JPEG',
  png: 'PNG', apng: 'PNG animado', gif: 'GIF', webp: 'WebP', avif: 'AVIF', bmp: 'Bitmap (BMP)',
  ico: 'Ícone (ICO)', svg: 'Vetorial (SVG)', heic: 'HEIC', heif: 'HEIF', tif: 'TIFF', tiff: 'TIFF',
  mp4: 'MP4', m4v: 'MP4', webm: 'WebM', ogv: 'Ogg', mov: 'QuickTime (MOV)', mkv: 'Matroska (MKV)',
  avi: 'AVI', wmv: 'Windows Media (WMV)', flv: 'Flash (FLV)', mpg: 'MPEG', mpeg: 'MPEG', '3gp': '3GP',
  mts: 'AVCHD (MTS)', m2ts: 'AVCHD (M2TS)',
};

export const typeLabel = (f) => `${f.kind === 'video' ? 'Vídeo' : 'Imagem'} ${TYPE_NAMES[f.ext] || f.ext.toUpperCase()}`;

// remote: acesso de outro computador (Tailscale). "Abrir no aplicativo padrão" e
// "Mostrar no Explorer" agiriam no computador do servidor, então viram "Baixar".
export function createViewer({ onChange, onRequestClose, onOpenExternal, onReveal, onCopy, revealLabel, remote }) {
  const DOWNLOAD_LABEL = 'Baixar para este computador';
  const root = document.getElementById('viewer');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Visualizador de arquivos');
  root.tabIndex = -1;
  root.innerHTML = `
    <div class="v-top">
      <button class="v-btn v-back" type="button" data-act="close" title="Voltar à pasta (Esc, Backspace ou botão direito)">
        ${icon('arrowLeft')}<span>Voltar à pasta</span>
      </button>
      <div class="v-title">
        <div class="v-name"></div>
        <div class="v-sub"></div>
      </div>
      <div class="v-tools">
        <div class="v-group v-image-only">
          <button class="v-btn" type="button" data-act="zoom-out" title="Diminuir zoom (−)">${icon('zoomOut')}</button>
          <button class="v-btn v-zoom-label" type="button" data-act="zoom-toggle"
                  title="Alternar entre ajustar à tela e tamanho real (duplo clique na imagem)">100%</button>
          <button class="v-btn" type="button" data-act="zoom-in" title="Aumentar zoom (+)">${icon('zoomIn')}</button>
          <button class="v-btn" type="button" data-act="rotate" title="Girar 90° (R)">${icon('rotate')}</button>
          <span class="v-divider"></span>
        </div>
        <button class="v-btn" type="button" data-act="info" title="Informações (I)">${icon('info')}</button>
        ${remote
          ? `<button class="v-btn" type="button" data-act="download" title="${DOWNLOAD_LABEL}">${icon('download')}</button>`
          : `<button class="v-btn" type="button" data-act="external" title="Abrir no aplicativo padrão">${icon('external')}</button>
        <button class="v-btn" type="button" data-act="reveal" title="${esc(revealLabel)}">${icon('folderSearch')}</button>`}
        <button class="v-btn" type="button" data-act="fullscreen" title="Tela cheia (F)">${icon('maximize')}</button>
        <span class="v-divider"></span>
        <button class="v-btn v-close" type="button" data-act="close" title="Fechar (Esc)">${icon('x')}</button>
      </div>
    </div>
    <div class="v-body">
      <div class="v-main">
        <div class="v-stage">
          <div class="v-spinner spinner spinner-lg" hidden></div>
          <div class="v-msg" hidden></div>
        </div>
        <button class="v-nav v-prev" type="button" data-act="prev" title="Anterior (←)">${icon('chevronLeft')}</button>
        <button class="v-nav v-next" type="button" data-act="next" title="Próximo (→)">${icon('chevronRight')}</button>
        <div class="v-hud" aria-hidden="true"></div>
      </div>
      <aside class="v-info" hidden></aside>
    </div>
    <div class="v-strip"><div class="v-strip-track"></div></div>`;

  const q = (s) => root.querySelector(s);
  const stage = q('.v-stage');
  const nameEl = q('.v-name');
  const subEl = q('.v-sub');
  const spinner = q('.v-spinner');
  const msg = q('.v-msg');
  const hud = q('.v-hud');
  const info = q('.v-info');
  const strip = q('.v-strip');
  const track = q('.v-strip-track');
  const prevBtn = q('.v-prev');
  const nextBtn = q('.v-next');
  const zoomLabel = q('.v-zoom-label');
  const fsBtn = q('[data-act="fullscreen"]');

  let list = [];
  let index = -1;
  let isOpen = false;
  let media = null;
  let token = 0;
  let stripObs = null;
  let firstStripScroll = true;
  let infoOpen = store.get('painelInfo', false);
  const z = { s: 1, tx: 0, ty: 0, rot: 0, fit: 1, natW: 0, natH: 0 };

  /* --------------------------------------------------------- abrir/fechar */

  function open(newList, i) {
    if (!isOpen) {
      isOpen = true;
      root.hidden = false;
      document.documentElement.classList.add('viewer-open');
      document.getElementById('app').inert = true;
      firstStripScroll = true;
      requestAnimationFrame(() => root.classList.add('shown'));
      root.focus({ preventScroll: true });
      wake();
    }
    if (newList !== list) {
      list = newList;
      buildStrip();
    }
    show(clamp(i, 0, list.length - 1));
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    token++;
    clearMedia();
    hideMessage();
    clearTimeout(idleTimer);
    root.classList.remove('shown', 'idle', 'is-zoomed');
    root.hidden = true;
    document.documentElement.classList.remove('viewer-open');
    document.getElementById('app').inert = false;
  }

  /* -------------------------------------------------------------- exibição */

  function show(i) {
    index = i;
    const f = list[i];
    const my = ++token;
    root.dataset.kind = f.kind;
    nameEl.textContent = f.name;
    nameEl.title = f.name;
    subEl.textContent = `${fmtNumber(i + 1)} de ${fmtNumber(list.length)}`;
    prevBtn.disabled = i <= 0;
    nextBtn.disabled = i >= list.length - 1;
    hideMessage();
    clearMedia();
    resetZoom();
    if (f.kind === 'image') showImage(f, my);
    else showVideo(f, my);
    updateStrip();
    renderInfo();
    preloadNeighbors(i);
  }

  function clearMedia() {
    clearTimeout(spinTimer);
    spinner.hidden = true;
    if (!media) return;
    if (media.tagName === 'VIDEO') {
      media.pause();
      media.removeAttribute('src');
      try { media.load(); } catch { /* ignorado */ }
    }
    media.remove();
    media = null;
  }

  let spinTimer = 0;
  function spinLater(my) {
    clearTimeout(spinTimer);
    spinTimer = setTimeout(() => { if (my === token) spinner.hidden = false; }, 200);
  }
  function stopSpin() {
    clearTimeout(spinTimer);
    spinner.hidden = true;
  }

  function showImage(f, my) {
    const th = peekThumb(f);
    if (th && th.w && th.h && !th.direct) {
      // Mostra a miniatura ampliada enquanto a imagem completa carrega.
      const preview = document.createElement('img');
      preview.className = 'v-img is-preview';
      preview.alt = '';
      preview.draggable = false;
      preview.src = th.url;
      z.natW = th.w;
      z.natH = th.h;
      stage.appendChild(preview);
      media = preview;
      layout();
    }
    spinLater(my);
    const full = new Image();
    full.className = 'v-img';
    full.alt = f.name;
    full.draggable = false;
    full.decoding = 'async';
    full.onload = async () => {
      try { await full.decode(); } catch { /* exibe mesmo assim */ }
      if (my !== token) return;
      stopSpin();
      z.natW = full.naturalWidth;
      z.natH = full.naturalHeight;
      if (media) stage.replaceChild(full, media);
      else stage.appendChild(full);
      media = full;
      layout();
      renderInfo();
    };
    full.onerror = () => {
      if (my !== token) return;
      stopSpin();
      if (media) { media.remove(); media = null; }
      showMessage(f);
    };
    full.src = fileSrc(f);
  }

  function showVideo(f, my) {
    const v = document.createElement('video');
    v.className = 'v-video';
    v.controls = true;
    v.playsInline = true;
    v.preload = 'auto';
    const th = peekThumb(f);
    if (th) v.poster = th.url;
    const vol = store.get('volume', { v: 1, m: false });
    v.volume = clamp(Number(vol.v) || 0, 0, 1);
    v.muted = !!vol.m;
    v.addEventListener('volumechange', () => store.set('volume', { v: v.volume, m: v.muted }));
    v.addEventListener('error', () => {
      if (my !== token) return;
      stopSpin();
      v.remove();
      if (media === v) media = null;
      showMessage(f);
    });
    v.addEventListener('loadedmetadata', () => {
      if (my !== token) return;
      stopSpin();
      if (!v.videoWidth) {
        showNote('O Chrome não conseguiu decodificar a imagem deste vídeo (codec não suportado). '
          + `Somente o áudio será reproduzido — use “${remote ? 'Baixar' : 'Abrir no aplicativo padrão'}” para assisti-lo.`);
      }
      renderInfo();
    });
    spinLater(my);
    v.src = fileSrc(f);
    stage.appendChild(v);
    media = v;
    v.play().catch(() => { /* reprodução automática bloqueada: o usuário aperta play */ });
  }

  const UNSUPPORTED = {
    heic: 'HEIC (formato de fotos do iPhone)', heif: 'HEIF', tif: 'TIFF', tiff: 'TIFF',
    avi: 'AVI', wmv: 'WMV', flv: 'FLV', mpg: 'MPEG', mpeg: 'MPEG', '3gp': '3GP', mts: 'MTS', m2ts: 'M2TS',
  };

  function showMessage(f) {
    const isImg = f.kind === 'image';
    const title = isImg ? 'Não foi possível exibir esta imagem' : 'Não foi possível reproduzir este vídeo';
    const fmt = UNSUPPORTED[f.ext];
    const how = remote ? 'Baixe o arquivo e abra-o em um aplicativo deste computador' : 'Abra no aplicativo padrão do computador';
    const text = fmt
      ? `O Google Chrome não ${isImg ? 'exibe imagens' : 'reproduz vídeos'} no formato ${fmt}. ${how} para ${isImg ? 'vê-la' : 'assisti-lo'}.`
      : `O arquivo pode estar corrompido ou usar um ${isImg ? 'formato' : 'codec'} que o Chrome não suporta.`;
    msg.innerHTML = `
      <div class="v-msg-card">
        <div class="v-msg-icon">${icon(isImg ? 'imageOff' : 'video')}</div>
        <h3>${title}</h3>
        <p>${esc(text)}</p>
        <div class="v-msg-actions">${remote
          ? `<button class="btn btn-primary" type="button" data-act="download">${icon('download')}${DOWNLOAD_LABEL}</button>`
          : `<button class="btn btn-primary" type="button" data-act="external">${icon('external')}Abrir no aplicativo padrão</button>
          <button class="btn btn-dark" type="button" data-act="reveal">${icon('folderSearch')}${esc(revealLabel)}</button>`}
        </div>
      </div>`;
    msg.hidden = false;
  }

  function showNote(text) {
    msg.innerHTML = `<div class="v-note">${icon('alert')}<span>${esc(text)}</span></div>`;
    msg.hidden = false;
  }

  function hideMessage() {
    msg.hidden = true;
    msg.innerHTML = '';
  }

  function preloadNeighbors(i) {
    for (const j of [i + 1, i - 1]) {
      const f = list[j];
      if (f && f.kind === 'image' && f.web !== false) {
        const im = new Image();
        im.decoding = 'async';
        im.src = fileSrc(f);
      }
    }
  }

  /* ------------------------------------------------------------------ zoom */

  function resetZoom() {
    z.s = 1; z.tx = 0; z.ty = 0; z.rot = 0; z.fit = 1; z.natW = 0; z.natH = 0;
    root.classList.remove('is-zoomed');
    zoomLabel.textContent = '100%';
  }

  const isImage = () => media && media.tagName === 'IMG';
  const maxScale = () => Math.max(2, MAX_NATURAL / (z.fit || 1));

  function layout(animate = false) {
    if (!isImage()) return;
    const aw = Math.max(40, stage.clientWidth - PAD * 2);
    const ah = Math.max(40, stage.clientHeight - PAD * 2);
    let nw = z.natW;
    let nh = z.natH;
    if (!nw || !nh) { nw = aw; nh = ah; } // ex.: SVG sem tamanho próprio
    const rotated = z.rot % 180 !== 0;
    z.fit = Math.min(1, aw / (rotated ? nh : nw), ah / (rotated ? nw : nh));
    media.style.width = `${nw * z.fit}px`;
    media.style.height = `${nh * z.fit}px`;
    z.s = clamp(z.s, 1, maxScale());
    clampPan();
    applyTransform(animate);
  }

  function extents() {
    const w = (z.natW || stage.clientWidth) * z.fit;
    const h = (z.natH || stage.clientHeight) * z.fit;
    const rotated = z.rot % 180 !== 0;
    return { ew: (rotated ? h : w) * z.s, eh: (rotated ? w : h) * z.s };
  }

  function clampPan() {
    const { ew, eh } = extents();
    const mx = Math.max(0, (ew - stage.clientWidth) / 2 + PAD);
    const my = Math.max(0, (eh - stage.clientHeight) / 2 + PAD);
    z.tx = ew > stage.clientWidth ? clamp(z.tx, -mx, mx) : 0;
    z.ty = eh > stage.clientHeight ? clamp(z.ty, -my, my) : 0;
  }

  function applyTransform(animate) {
    if (!isImage()) return;
    media.classList.toggle('animate', !!animate);
    media.style.transform = `translate(-50%, -50%) translate(${z.tx}px, ${z.ty}px) scale(${z.s}) rotate(${z.rot}deg)`;
    root.classList.toggle('is-zoomed', z.s > 1.001);
    zoomLabel.textContent = `${Math.round(z.s * z.fit * 100)}%`;
  }

  // (cx, cy): ponto da tela, relativo ao centro da área de exibição, que fica parado.
  function zoomTo(s, cx = 0, cy = 0, animate = true) {
    if (!isImage()) return;
    const ns = clamp(s, 1, maxScale());
    const r = ns / z.s;
    z.tx = cx - (cx - z.tx) * r;
    z.ty = cy - (cy - z.ty) * r;
    z.s = ns;
    if (ns <= 1.001) { z.s = 1; z.tx = 0; z.ty = 0; }
    clampPan();
    applyTransform(animate);
    flashHud(zoomLabel.textContent);
  }

  function toggleZoom(cx = 0, cy = 0) {
    if (z.s > 1.001) zoomTo(1, 0, 0);
    else zoomTo(z.fit < 0.999 ? 1 / z.fit : 2, cx, cy);
  }

  function rotate(deg) {
    if (!isImage()) return;
    // Sem normalizar para 0–359: assim a animação sempre gira 90° no sentido certo.
    z.rot += deg;
    z.s = 1; z.tx = 0; z.ty = 0;
    layout(true);
  }

  let hudTimer = 0;
  function flashHud(text) {
    hud.textContent = text;
    hud.classList.add('on');
    clearTimeout(hudTimer);
    hudTimer = setTimeout(() => hud.classList.remove('on'), 900);
  }

  function stagePoint(e) {
    const r = stage.getBoundingClientRect();
    return [e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2];
  }

  stage.addEventListener('wheel', (e) => {
    if (!isImage()) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 0.05 : e.deltaMode === 2 ? 1 : 0.0018;
    const factor = Math.exp(-e.deltaY * unit);
    const [cx, cy] = stagePoint(e);
    zoomTo(z.s * factor, cx, cy, false);
  }, { passive: false });

  let drag = null;
  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.v-msg, video')) return;
    drag = { x: e.clientX, y: e.clientY, tx: z.tx, ty: z.ty, moved: false, onMedia: e.target === media, id: e.pointerId };
    if (isImage() && z.s > 1.001) {
      stage.setPointerCapture(e.pointerId);
      root.classList.add('is-panning');
    }
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) > 4) drag.moved = true;
    if (drag.moved && isImage() && z.s > 1.001) {
      z.tx = drag.tx + dx;
      z.ty = drag.ty + dy;
      clampPan();
      applyTransform(false);
    }
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    root.classList.remove('is-panning');
    if (stage.hasPointerCapture(e.pointerId)) stage.releasePointerCapture(e.pointerId);
    // Clique no fundo (fora da mídia, sem zoom) fecha a visualização.
    if (e.type === 'pointerup' && !d.moved && !d.onMedia && e.target === stage && z.s <= 1.001) onRequestClose();
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  stage.addEventListener('dblclick', (e) => {
    if (!isImage() || e.target !== media) return;
    const [cx, cy] = stagePoint(e);
    toggleZoom(cx, cy);
  });

  new ResizeObserver(() => { if (isOpen) layout(); }).observe(stage);

  /* ----------------------------------------------------------- navegação */

  function go(delta) {
    const j = index + delta;
    if (j < 0 || j >= list.length) {
      const btn = delta < 0 ? prevBtn : nextBtn;
      btn.classList.remove('bump');
      void btn.offsetWidth;
      btn.classList.add('bump');
      return;
    }
    goTo(j);
  }

  function goTo(j) {
    if (j === index || j < 0 || j >= list.length) return;
    show(j);
    onChange(list[j], j);
  }

  /* ---------------------------------------------------- faixa de miniaturas */

  function buildStrip() {
    if (stripObs) stripObs.disconnect();
    track.innerHTML = list.map((f, i) => `
      <button class="v-thumb${f.kind === 'video' ? ' is-video' : ''}" type="button" data-i="${i}" tabindex="-1" title="${esc(f.name)}">
        <img alt="" draggable="false">
        <span class="v-thumb-icon">${icon(f.kind === 'video' ? 'video' : 'image')}</span>
        ${f.kind === 'video' ? `<span class="v-thumb-play">${icon('play')}</span>` : ''}
      </button>`).join('');
    stripObs = createThumbObserver({ root: strip, margin: '0px 800px' });
    for (const b of track.children) {
      const f = list[Number(b.dataset.i)];
      stripObs.observe(b, f, (res) => {
        if (!res) { b.classList.add('failed'); return; }
        const img = b.querySelector('img');
        img.onload = () => b.classList.add('ready');
        img.onerror = () => b.classList.add('failed');
        img.src = res.url;
      });
    }
    strip.hidden = list.length < 2;
    root.classList.toggle('single', list.length < 2);
  }

  function updateStrip() {
    const prev = track.querySelector('.v-thumb.on');
    if (prev) prev.classList.remove('on');
    const cur = track.children[index];
    if (!cur) return;
    cur.classList.add('on');
    const left = cur.offsetLeft - strip.clientWidth / 2 + cur.offsetWidth / 2;
    strip.scrollTo({ left, behavior: firstStripScroll ? 'auto' : 'smooth' });
    firstStripScroll = false;
  }

  track.addEventListener('click', (e) => {
    const b = e.target.closest('.v-thumb');
    if (b) goTo(Number(b.dataset.i));
  });

  function download(f) {
    const a = document.createElement('a');
    a.href = fileSrc(f) + '&download=1';
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  /* ---------------------------------------------------------- informações */

  function renderInfo() {
    info.hidden = !infoOpen;
    root.classList.toggle('info-open', infoOpen);
    q('[data-act="info"]').classList.toggle('on', infoOpen);
    if (!infoOpen || index < 0) return;
    const f = list[index];
    const th = peekThumb(f);
    let w = 0;
    let h = 0;
    let dur = 0;
    if (media && media.tagName === 'IMG' && !media.classList.contains('is-preview')) { w = media.naturalWidth; h = media.naturalHeight; }
    if (media && media.tagName === 'VIDEO') { w = media.videoWidth; h = media.videoHeight; dur = media.duration; }
    if (!w && th) { w = th.w; h = th.h; }
    if (!dur && th) dur = th.dur;
    const rows = [
      ['Nome', esc(f.name)],
      ['Tipo', esc(typeLabel(f))],
    ];
    if (w && h) {
      const mp = (w * h) / 1e6;
      rows.push(['Dimensões', `${fmtNumber(w)} × ${fmtNumber(h)} px${f.kind === 'image' && mp >= 0.1 ? ` · ${mp.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MP` : ''}`]);
    }
    if (f.kind === 'video' && Number.isFinite(dur) && dur > 0) rows.push(['Duração', fmtDuration(dur)]);
    rows.push(['Tamanho', `${fmtSize(f.size)} <span class="muted">(${fmtNumber(f.size)} bytes)</span>`]);
    rows.push(['Modificado em', esc(fmtDateLong(f.mtime))]);
    rows.push(['Pasta', `<span class="v-path">${esc(P.parent(f.path) || '')}</span>`]);
    info.innerHTML = `
      <div class="v-info-head">
        <h3>Informações</h3>
        <button class="v-btn" type="button" data-act="info" title="Fechar painel (I)">${icon('x')}</button>
      </div>
      <dl class="v-info-list">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
      <div class="v-info-actions">
        <button class="btn btn-dark btn-sm" type="button" data-act="copy">${icon('copy')}Copiar caminho</button>
        ${remote
          ? `<button class="btn btn-dark btn-sm" type="button" data-act="download">${icon('download')}Baixar</button>`
          : `<button class="btn btn-dark btn-sm" type="button" data-act="reveal">${icon('folderSearch')}${esc(revealLabel)}</button>`}
      </div>`;
  }

  function toggleInfo() {
    infoOpen = !infoOpen;
    store.set('painelInfo', infoOpen);
    renderInfo();
    requestAnimationFrame(layout);
  }

  /* ------------------------------------------------------------- tela cheia */

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => {});
  }
  document.addEventListener('fullscreenchange', () => {
    const on = !!document.fullscreenElement;
    fsBtn.innerHTML = icon(on ? 'minimize' : 'maximize');
    fsBtn.title = on ? 'Sair da tela cheia (F)' : 'Tela cheia (F)';
  });

  /* ------------------------------------------------------- ações e teclado */

  function act(name) {
    const f = list[index];
    switch (name) {
      case 'close': onRequestClose(); break;
      case 'prev': go(-1); break;
      case 'next': go(1); break;
      case 'zoom-in': zoomTo(z.s * 1.25); break;
      case 'zoom-out': zoomTo(z.s / 1.25); break;
      case 'zoom-toggle': toggleZoom(); break;
      case 'rotate': rotate(90); break;
      case 'info': toggleInfo(); break;
      case 'fullscreen': toggleFullscreen(); break;
      case 'external': if (f) onOpenExternal(f); break;
      case 'reveal': if (f) onReveal(f); break;
      case 'download': if (f) download(f); break;
      case 'copy': if (f) onCopy(f.path); break;
      default: break;
    }
  }

  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || !root.contains(b)) return;
    act(b.dataset.act);
    if (e.detail > 0) b.blur(); // clique do mouse: não deixa o foco "preso" no botão
  });

  function videoEl() {
    return media && media.tagName === 'VIDEO' ? media : null;
  }

  function handleKey(e) {
    if (e.metaKey || (e.altKey && e.key !== 'Alt')) return false;
    if (e.ctrlKey && !['+', '=', '-', '_', '0'].includes(e.key)) return false;
    const v = videoEl();
    let handled = true;
    switch (e.key) {
      case 'Escape':
      case 'Backspace': onRequestClose(); break;
      case 'ArrowLeft':
        if (v && e.shiftKey) v.currentTime = Math.max(0, v.currentTime - 5);
        else go(-1);
        break;
      case 'ArrowRight':
        if (v && e.shiftKey) v.currentTime = Math.min(v.duration || Infinity, v.currentTime + 5);
        else go(1);
        break;
      case 'ArrowUp': if (v) { v.muted = false; v.volume = clamp(v.volume + 0.1, 0, 1); flashHud(`Volume ${Math.round(v.volume * 100)}%`); } break;
      case 'ArrowDown': if (v) { v.volume = clamp(v.volume - 0.1, 0, 1); flashHud(`Volume ${Math.round(v.volume * 100)}%`); } break;
      case 'Home': goTo(0); break;
      case 'End': goTo(list.length - 1); break;
      case ' ':
      case 'k':
      case 'K':
        if (v) { if (v.paused) v.play().catch(() => {}); else v.pause(); }
        break;
      case '+': case '=': zoomTo(z.s * 1.25); break;
      case '-': case '_': zoomTo(z.s / 1.25); break;
      case '0': zoomTo(1); break;
      case '1': if (isImage()) zoomTo(1 / z.fit); break;
      case 'r': case 'R': rotate(e.shiftKey ? -90 : 90); break;
      case 'f': case 'F': toggleFullscreen(); break;
      case 'i': case 'I': toggleInfo(); break;
      case 'm': case 'M': if (v) { v.muted = !v.muted; flashHud(v.muted ? 'Sem som' : 'Som ativado'); } break;
      case 'Tab': trapFocus(e); break;
      default: handled = false;
    }
    if (handled) {
      if (e.key !== 'Tab') e.preventDefault();
      e.stopPropagation();
      wake();
    }
    return handled;
  }

  function trapFocus(e) {
    const items = Array.from(root.querySelectorAll('button:not([disabled]), video'))
      .filter((el) => el.offsetParent !== null && el.tabIndex !== -1);
    if (!items.length) return;
    const i = items.indexOf(document.activeElement);
    const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i + 1) % items.length;
    e.preventDefault();
    items[next].focus();
  }

  /* --------------------------------------- controles somem quando parados */

  let idleTimer = 0;
  let overControls = false;
  function wake() {
    root.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (isOpen && !overControls) root.classList.add('idle');
    }, 2800);
  }
  root.addEventListener('pointermove', wake);
  root.addEventListener('pointerdown', wake);
  for (const el of [q('.v-top'), strip, info, prevBtn, nextBtn]) {
    el.addEventListener('pointerenter', () => { overControls = true; wake(); });
    el.addEventListener('pointerleave', () => { overControls = false; wake(); });
  }

  return {
    open,
    close,
    isOpen: () => isOpen,
    current: () => (isOpen ? list[index] : null),
    handleKey,
  };
}
