// Miniaturas: pedidas sob demanda (só o que está perto da tela), com fila e cache em
// memória. Imagens com "thumb" vêm prontas do servidor (pequenas e guardadas por ele);
// as demais são geradas aqui, a partir do arquivo original, e guardadas no Cache Storage.
import { fileSrc, thumbSrc } from './api.js';

const SIZE = 400;               // lado menor da miniatura, em pixels
// Pedidos simultâneos: as do servidor são leves; gerar aqui exige baixar o original.
const LIMIT = { server: 6, image: 3, video: 2 };
const MEM_TARGET = 4000;        // entradas mantidas em memória após limpeza
const CACHE_NAME = 'miniaturas-v1';

const mem = new Map();          // chave -> { url, w, h, dur, direct? } (ordem = uso recente)
const failed = new Set();
const jobs = new Map();         // chave -> job
const queue = [];
const active = { server: 0, image: 0, video: 0 };

export const thumbKey = (f) => `${f.path}|${f.mtime}|${f.size}`;

// Há como ter miniatura: o servidor faz, ou o Chrome exibe o formato.
const hasThumb = (f) => !!f.thumb || f.web !== false;

export function peekThumb(f) {
  const k = thumbKey(f);
  const v = mem.get(k);
  if (v) { mem.delete(k); mem.set(k, v); }
  return v || null;
}

export const thumbFailed = (f) => failed.has(thumbKey(f));

// Libera miniaturas antigas, preservando as da pasta atual e as que estão na tela.
export function trimThumbs(keepFiles) {
  if (mem.size <= MEM_TARGET) return;
  const keep = new Set(keepFiles.map(thumbKey));
  const inUse = new Set(Array.from(document.images, (img) => img.src));
  for (const [k, v] of mem) {
    if (mem.size <= MEM_TARGET) break;
    if (keep.has(k) || inUse.has(v.url)) continue;
    if (!v.direct) URL.revokeObjectURL(v.url);
    mem.delete(k);
  }
}

/* ---------------------------------------------------------- Cache Storage */

let cachePromise = null;
function openCache() {
  if (!('caches' in self)) return Promise.resolve(null);
  if (!cachePromise) cachePromise = caches.open(CACHE_NAME).catch(() => null);
  return cachePromise;
}

const cacheRequest = (key) => new Request('/@miniatura/' + encodeURIComponent(key));

async function fromCache(key) {
  const cache = await openCache();
  if (!cache) return null;
  try {
    const res = await cache.match(cacheRequest(key));
    if (!res) return null;
    const meta = JSON.parse(res.headers.get('x-meta') || '{}');
    const blob = await res.blob();
    if (!blob.size) return null;
    return { url: URL.createObjectURL(blob), w: meta.w || 0, h: meta.h || 0, dur: meta.dur || 0 };
  } catch {
    return null;
  }
}

async function toCache(key, blob, meta) {
  const cache = await openCache();
  if (!cache) return;
  try {
    await cache.put(cacheRequest(key), new Response(blob, {
      headers: { 'content-type': blob.type || 'image/webp', 'x-meta': JSON.stringify(meta) },
    }));
  } catch { /* cota cheia: sem problema */ }
}

export async function clearThumbCache() {
  for (const v of mem.values()) if (!v.direct) URL.revokeObjectURL(v.url);
  mem.clear();
  failed.clear();
  cachePromise = null;
  if ('caches' in self) await caches.delete(CACHE_NAME).catch(() => {});
}

/* ---------------------------------------------------------------- geração */

let worker = null;
let workerSeq = 0;
const workerWaiting = new Map();

function getWorker() {
  if (!worker) {
    worker = new Worker('/@app/js/thumb-worker.js');
    worker.onmessage = (e) => {
      const done = workerWaiting.get(e.data.id);
      if (done) { workerWaiting.delete(e.data.id); done(e.data); }
    };
    worker.onerror = () => {
      for (const done of workerWaiting.values()) done({ ok: false });
      workerWaiting.clear();
      worker.terminate();
      worker = null;
    };
  }
  return worker;
}

function imageThumb(f) {
  return new Promise((resolve) => {
    const id = ++workerSeq;
    const timer = setTimeout(() => { workerWaiting.delete(id); resolve(null); }, 45000);
    workerWaiting.set(id, (d) => {
      clearTimeout(timer);
      resolve(d.ok ? { blob: d.blob, w: d.w, h: d.h, dur: 0 } : null);
    });
    getWorker().postMessage({ id, url: fileSrc(f), size: SIZE });
  });
}

function videoThumb(f) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'metadata';
    let settled = false;
    let dur = 0;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      v.removeAttribute('src');
      try { v.load(); } catch { /* ignorado */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 20000);
    v.addEventListener('error', () => finish(null));
    v.addEventListener('loadedmetadata', () => {
      dur = Number.isFinite(v.duration) ? v.duration : 0;
      if (!v.videoWidth || !v.videoHeight) { finish(null); return; }
      // Um pouco depois do início: o primeiro quadro costuma ser preto.
      v.currentTime = dur > 0 ? Math.min(dur * 0.1, 6) : 0.1;
    }, { once: true });
    v.addEventListener('seeked', () => {
      try {
        const w = v.videoWidth;
        const h = v.videoHeight;
        const scale = Math.min(1, SIZE / Math.min(w, h), (SIZE * 3) / Math.max(w, h));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w * scale));
        c.height = Math.max(1, Math.round(h * scale));
        const ctx = c.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(v, 0, 0, c.width, c.height);
        c.toBlob((blob) => finish(blob ? { blob, w, h, dur } : null), 'image/webp', 0.82);
      } catch {
        finish(null);
      }
    }, { once: true });
    v.src = fileSrc(f);
  });
}

async function serverThumb(f) {
  try {
    // Prioridade baixa: abrir uma pasta (listagem) passa na frente das miniaturas.
    const res = await fetch(thumbSrc(f), { priority: 'low' });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.size) return null;
    const w = Number(res.headers.get('x-thumb-width')) || 0;
    const h = Number(res.headers.get('x-thumb-height')) || 0;
    return { url: URL.createObjectURL(blob), w, h, dur: 0 };
  } catch {
    return null;
  }
}

async function produce(f) {
  if (f.thumb) {
    const fromServer = await serverThumb(f);
    // Se o servidor não conseguiu, tenta aqui (quando o Chrome exibe o formato).
    if (fromServer || f.web === false) return fromServer;
  }
  const key = thumbKey(f);
  const cached = await fromCache(key);
  if (cached) return cached;
  const out = f.kind === 'image' ? await imageThumb(f) : await videoThumb(f);
  if (!out) return null;
  const meta = { w: out.w, h: out.h, dur: out.dur || 0 };
  toCache(key, out.blob, meta);
  return { url: URL.createObjectURL(out.blob), ...meta };
}

/* ------------------------------------------------------------------- fila */

function pump() {
  for (let i = 0; i < queue.length;) {
    const job = queue[i];
    const kind = job.file.thumb ? 'server' : job.file.kind === 'video' ? 'video' : 'image';
    if (active[kind] >= LIMIT[kind]) { i++; continue; }
    queue.splice(i, 1);
    run(job, kind);
  }
}

async function run(job, kind) {
  job.started = true;
  active[kind]++;
  let result = null;
  try {
    result = await produce(job.file);
  } catch {
    result = null;
  } finally {
    active[kind]--;
  }
  jobs.delete(job.key);
  if (result) mem.set(job.key, result);
  else failed.add(job.key);
  for (const cb of job.listeners) {
    try { cb(result); } catch (e) { console.error(e); }
  }
  pump();
}

// Pede a miniatura de um arquivo. Retorna uma função para cancelar o pedido.
export function requestThumb(f, cb) {
  const key = thumbKey(f);
  const hit = peekThumb(f);
  if (hit) { cb(hit); return () => {}; }
  if (failed.has(key) || !hasThumb(f)) { cb(null); return () => {}; }
  if (f.ext === 'svg') {
    // SVG é vetorial e leve: usa o próprio arquivo.
    const v = { url: fileSrc(f), w: 0, h: 0, dur: 0, direct: true };
    mem.set(key, v);
    cb(v);
    return () => {};
  }
  let job = jobs.get(key);
  if (!job) {
    job = { key, file: f, listeners: new Set(), started: false };
    jobs.set(key, job);
    queue.push(job);
  }
  job.listeners.add(cb);
  pump();
  return () => {
    job.listeners.delete(cb);
    if (!job.started && job.listeners.size === 0) {
      jobs.delete(key);
      const i = queue.indexOf(job);
      if (i >= 0) queue.splice(i, 1);
    }
  };
}

// Observa elementos e carrega a miniatura quando chegam perto da área visível.
export function createThumbObserver({ root = null, margin = '600px' } = {}) {
  const recs = new Map(); // elemento -> { file, apply, cancel }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const rec = recs.get(e.target);
      if (!rec) continue;
      if (e.isIntersecting) {
        if (!rec.cancel) {
          rec.cancel = requestThumb(rec.file, (res) => {
            io.unobserve(e.target);
            recs.delete(e.target);
            if (e.target.isConnected) rec.apply(res);
          });
        }
      } else if (rec.cancel) {
        rec.cancel();
        rec.cancel = null;
      }
    }
  }, { root, rootMargin: margin });

  return {
    observe(el, file, apply) {
      const hit = peekThumb(file);
      if (hit) { apply(hit); return; }
      if (failed.has(thumbKey(file)) || !hasThumb(file)) { apply(null); return; }
      recs.set(el, { file, apply, cancel: null });
      io.observe(el);
    },
    disconnect() {
      io.disconnect();
      for (const rec of recs.values()) if (rec.cancel) rec.cancel();
      recs.clear();
    },
  };
}
