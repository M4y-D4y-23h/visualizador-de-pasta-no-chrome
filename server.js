'use strict';
/*
 * Visualizador de Pastas — servidor local (sem dependências externas).
 *
 * Serve a interface (pasta public/) e uma API mínima para:
 *   - listar pastas (somente subpastas, imagens e vídeos);
 *   - transmitir imagens e vídeos do disco (com suporte a Range, para vídeos);
 *   - abrir o seletor de pastas do Windows, o aplicativo padrão e o Explorer.
 *
 * Escuta apenas em 127.0.0.1 (e ::1): nada fica exposto na rede. Com --tailscale,
 * também atende nos endereços do Tailscale deste computador, e somente a outros
 * aparelhos da mesma rede Tailscale (veja "Acesso pelo Tailscale" abaixo).
 */

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { pipeline } = require('stream');
const { fileURLToPath } = require('url');

const APP_ID = 'visualizador-de-pastas';
const VERSION = '1.0.0';
const IS_WIN = process.platform === 'win32';
const PUBLIC_DIR = path.join(__dirname, 'public');
const SCRIPTS_DIR = path.join(__dirname, 'scripts');

const argv = process.argv.slice(2);
const NO_OPEN = argv.includes('--no-open');
const TAILSCALE = argv.includes('--tailscale');
const portArg = argv.find((a) => a.startsWith('--port='));
const BASE_PORT = Number(portArg ? portArg.slice('--port='.length) : process.env.PORT) || 4321;
let PORT = BASE_PORT;

/* -------------------------------------------------------------- mídias */

// extensão -> [tipo, MIME]
const MEDIA_TYPES = {
  jpg: ['image', 'image/jpeg'], jpeg: ['image', 'image/jpeg'], jpe: ['image', 'image/jpeg'],
  jfif: ['image', 'image/jpeg'], pjpeg: ['image', 'image/jpeg'], pjp: ['image', 'image/jpeg'],
  png: ['image', 'image/png'], apng: ['image', 'image/apng'], gif: ['image', 'image/gif'],
  webp: ['image', 'image/webp'], avif: ['image', 'image/avif'], bmp: ['image', 'image/bmp'],
  ico: ['image', 'image/x-icon'], svg: ['image', 'image/svg+xml'],
  heic: ['image', 'image/heic'], heif: ['image', 'image/heif'],
  tif: ['image', 'image/tiff'], tiff: ['image', 'image/tiff'],
  mp4: ['video', 'video/mp4'], m4v: ['video', 'video/mp4'], webm: ['video', 'video/webm'],
  ogv: ['video', 'video/ogg'], mov: ['video', 'video/mp4'], mkv: ['video', 'video/x-matroska'],
  avi: ['video', 'video/x-msvideo'], wmv: ['video', 'video/x-ms-wmv'], flv: ['video', 'video/x-flv'],
  mpg: ['video', 'video/mpeg'], mpeg: ['video', 'video/mpeg'], '3gp': ['video', 'video/3gpp'],
  mts: ['video', 'video/mp2t'], m2ts: ['video', 'video/mp2t'],
};
// Formatos que o Chrome não exibe: aparecem na lista, e o visualizador
// oferece abri-los no aplicativo padrão do sistema.
const NOT_IN_BROWSER = new Set(['heic', 'heif', 'tif', 'tiff', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', '3gp', 'mts', 'm2ts']);

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

function mediaOf(name) {
  const ext = extOf(name);
  const t = Object.prototype.hasOwnProperty.call(MEDIA_TYPES, ext) ? MEDIA_TYPES[ext] : null;
  return t ? { ext, kind: t[0], mime: t[1], web: !NOT_IN_BROWSER.has(ext) } : null;
}

/* ------------------------------------------------------------- caminhos */

const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });

const isUncRoot = (p) => /^\\\\[^\\]+\\[^\\]+\\?$/.test(p);
const isDriveRoot = (p) => /^[A-Za-z]:\\$/.test(p);

// Converte o texto recebido (caminho colado, URL file://, ~, %VARIAVEL%) num
// caminho absoluto normalizado. Retorna null se não for um caminho válido.
function normalizePath(input) {
  if (typeof input !== 'string') return null;
  let p = input.trim();
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1).trim();
  if (!p || p.length > 4096 || p.includes('\0')) return null;
  if (/^file:\/\//i.test(p)) {
    try { p = fileURLToPath(p); } catch { return null; }
  }
  if (p === '~' || /^~[\\/]/.test(p)) p = os.homedir() + p.slice(1);

  if (IS_WIN) {
    p = p.replace(/%([^%\\/]+)%/g, (m, name) => (process.env[name] !== undefined ? process.env[name] : m));
    p = p.replace(/\//g, '\\');
    if (/^[a-zA-Z]:$/.test(p)) p += '\\';
    // Somente "C:\..." ou "\\servidor\compartilhamento\..." (sem caminhos de dispositivo \\?\ e \\.\)
    if (!/^[a-zA-Z]:\\/.test(p) && !/^\\\\[^\\?.][^\\]*\\[^\\]+/.test(p)) return null;
    p = path.win32.normalize(p);
    if (/^[a-z]:/.test(p)) p = p[0].toUpperCase() + p.slice(1);
    if (p.length > 3 && p.endsWith('\\') && !isUncRoot(p)) p = p.slice(0, -1);
    return p;
  }
  if (!p.startsWith('/')) return null;
  p = path.posix.normalize(p);
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

function parentOf(p) {
  if (IS_WIN) {
    if (isDriveRoot(p) || isUncRoot(p)) return null;
    const d = path.win32.dirname(p);
    return d === p ? null : d;
  }
  if (p === '/') return null;
  return path.posix.dirname(p);
}

function displayName(p) {
  if (IS_WIN && isDriveRoot(p)) return p.slice(0, 2);
  if (IS_WIN && isUncRoot(p)) return p.replace(/\\$/, '');
  return path.basename(p) || p;
}

// Itens de sistema que o Explorer também esconde.
const HIDDEN_ANYWHERE = new Set(['$recycle.bin', 'system volume information', 'thumbs.db', 'desktop.ini']);
const HIDDEN_AT_DRIVE_ROOT = new Set([
  'recovery', 'programdata', 'config.msi', 'msocache', 'documents and settings',
  'pagefile.sys', 'hiberfil.sys', 'swapfile.sys', 'dumpstack.log', 'dumpstack.log.tmp',
]);

function isHidden(name, dir) {
  if (name.startsWith('.') || name.startsWith('$') || name.startsWith('~$')) return true;
  const l = name.toLowerCase();
  if (HIDDEN_ANYWHERE.has(l)) return true;
  if (IS_WIN) {
    if (isDriveRoot(dir) && HIDDEN_AT_DRIVE_ROOT.has(l)) return true;
    if (l === 'appdata' && /^[a-z]:\\users\\[^\\]+$/i.test(dir)) return true;
  }
  return false;
}

async function mapLimit(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

// Atalhos/junções: segue o link e confirma que a pasta de destino pode ser aberta
// (junções de compatibilidade do Windows, como "Documents and Settings", negam acesso).
async function resolveLink(full) {
  const st = await fsp.stat(full);
  if (st.isDirectory()) {
    const handle = await fsp.opendir(full);
    await handle.close();
  }
  return st;
}

async function listDir(dir) {
  const dirents = await fsp.readdir(dir, { withFileTypes: true });
  const folders = [];
  const files = [];
  let others = 0;

  await mapLimit(dirents, 32, async (d) => {
    const name = d.name;
    if (isHidden(name, dir)) return;
    const full = path.join(dir, name);
    let isDir = d.isDirectory();
    let isFile = d.isFile();
    let st = null;
    try {
      if (d.isSymbolicLink()) {
        st = await resolveLink(full);
        isDir = st.isDirectory();
        isFile = st.isFile();
      }
      if (isDir) {
        st = st || (await fsp.stat(full));
        folders.push({ name, path: full, mtime: Math.round(st.mtimeMs) });
        return;
      }
      if (!isFile) return;
      const media = mediaOf(name);
      if (!media) { others++; return; }
      st = st || (await fsp.stat(full));
      files.push({
        name, path: full, kind: media.kind, ext: media.ext, web: media.web,
        size: st.size, mtime: Math.round(st.mtimeMs),
      });
    } catch {
      // Item inacessível ou removido durante a leitura: simplesmente não aparece.
    }
  });

  folders.sort((a, b) => collator.compare(a.name, b.name));
  files.sort((a, b) => collator.compare(a.name, b.name));
  return { folders, files, others };
}

// Resumo de uma subpasta para o cartão (contagens + até 3 arquivos de capa).
async function peekDir(dir) {
  const dirents = await fsp.readdir(dir, { withFileTypes: true });
  let folders = 0;
  let images = 0;
  let videos = 0;
  const media = [];

  await mapLimit(dirents, 16, async (d) => {
    const name = d.name;
    if (isHidden(name, dir)) return;
    let isDir = d.isDirectory();
    let isFile = d.isFile();
    if (d.isSymbolicLink()) {
      try {
        const st = await resolveLink(path.join(dir, name));
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch { return; }
    }
    if (isDir) { folders++; return; }
    if (!isFile) return;
    const m = mediaOf(name);
    if (!m) return;
    if (m.kind === 'image') images++; else videos++;
    media.push({ name, ...m });
  });

  // Capa: prefere formatos exibíveis no Chrome e imagens (mais leves que vídeos).
  const rank = (m) => (m.web ? 0 : 2) + (m.kind === 'image' ? 0 : 1);
  media.sort((a, b) => rank(a) - rank(b) || collator.compare(a.name, b.name));

  const preview = [];
  for (const m of media) {
    if (preview.length >= 3) break;
    const full = path.join(dir, m.name);
    try {
      const st = await fsp.stat(full);
      preview.push({
        name: m.name, path: full, kind: m.kind, ext: m.ext, web: m.web,
        size: st.size, mtime: Math.round(st.mtimeMs),
      });
    } catch { /* ignorado */ }
  }
  return { path: dir, folders, images, videos, preview };
}

async function nearestExisting(p) {
  let cur = parentOf(p);
  while (cur) {
    try {
      if ((await fsp.stat(cur)).isDirectory()) return cur;
    } catch { /* continua subindo */ }
    cur = parentOf(cur);
  }
  return null;
}

function fsErrorInfo(err) {
  switch (err && err.code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return [404, 'not_found', 'Este caminho não existe — ele pode ter sido movido, renomeado ou excluído.'];
    case 'EPERM':
    case 'EACCES':
      return [403, 'forbidden', 'Você não tem permissão para acessar este local.'];
    case 'EBUSY':
      return [423, 'busy', 'Este local está ocupado ou bloqueado por outro programa.'];
    case 'ENODEV':
    case 'ENXIO':
    case 'EIO':
      return [503, 'unavailable', 'A unidade não está disponível no momento.'];
    default:
      return [500, 'error', `Não foi possível abrir este local (${(err && err.code) || 'erro desconhecido'}).`];
  }
}

/* ------------------------------------------------------- HTTP: utilitários */

// Nomes e endereços do Tailscale deste computador (preenchido só com --tailscale).
const tailscaleHosts = new Set();

const hostWithPort = (h) => (h.includes(':') ? `[${h}]:${PORT}` : `${h}:${PORT}`);

function allowedHosts() {
  return new Set([
    `localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`,
    ...Array.from(tailscaleHosts, hostWithPort),
  ]);
}

// Bloqueia DNS rebinding: só aceita requisições endereçadas ao próprio servidor
// (localhost ou, com --tailscale, o endereço/nome deste computador no Tailscale).
function hostAllowed(req) {
  return allowedHosts().has(String(req.headers.host || '').toLowerCase());
}

// "::ffff:100.64.1.2" -> "100.64.1.2"
const plainAddress = (ip) => String(ip || '').replace(/^::ffff:/i, '');

// Quem está usando o visualizador neste próprio computador (e não por outro aparelho
// do Tailscale)? Só esse pode abrir janelas e programas aqui.
function isLocalClient(req) {
  const ip = plainAddress(req.socket.remoteAddress);
  return ip === '::1' || ip.startsWith('127.') || tailscaleServers.has(ip);
}

// Requisições que executam ações exigem um cabeçalho próprio e JSON: navegadores não
// conseguem enviar isso de outro site sem uma pré-verificação CORS (que recusamos).
function postAllowed(req) {
  if (req.headers['x-visualizador'] !== '1') return false;
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) return false;
  const origin = req.headers.origin;
  if (origin && !allowedHosts().has(origin.replace(/^https?:\/\//i, '').toLowerCase())) return false;
  return true;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function sendError(res, status, code, message, extra) {
  sendJson(res, status, { error: code, message, ...(extra || {}) });
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Corpo muito grande'), { status: 413 }));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(Object.assign(new Error('JSON inválido'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/* --------------------------------------------------------- PowerShell (Windows) */

const POWERSHELL = IS_WIN
  ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : null;

// Executa um script da pasta scripts/. Os scripts devolvem o resultado em base64
// (UTF-8), o que evita qualquer problema de codificação do console com acentos.
function runPowerShell(script, env = {}, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(POWERSHELL, [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA',
        '-File', path.join(SCRIPTS_DIR, script),
      ], { env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      reject(e);
      return;
    }
    let out = '';
    let errOut = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { errOut += d; });
    let timer = null;
    if (timeoutMs) {
      timer = setTimeout(() => {
        child.kill();
        reject(new Error('tempo esgotado'));
      }, timeoutMs);
    }
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(errOut.trim() || `código de saída ${code}`));
    });
  });
}

const fromBase64 = (s) => Buffer.from(s, 'base64').toString('utf8');

function spawnDetached(cmd, args, options = {}) {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false, ...options });
  child.on('error', (e) => console.warn('[aviso]', e.message));
  child.unref();
}

/* ------------------------------------------------------- locais e unidades */

const PLACE_NAMES = {
  desktop: 'Área de Trabalho',
  downloads: 'Downloads',
  documents: 'Documentos',
  pictures: 'Imagens',
  videos: 'Vídeos',
  home: 'Pasta pessoal',
};

async function diskSpace(p) {
  if (typeof fsp.statfs !== 'function') return { total: 0, free: 0 };
  try {
    const s = await fsp.statfs(p);
    return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch {
    return { total: 0, free: 0 };
  }
}

async function probeWindowsDrives() {
  const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const found = await Promise.all(letters.map(async (letter) => {
    const p = `${letter}:\\`;
    const ok = await Promise.race([
      fsp.access(p).then(() => true, () => false),
      new Promise((r) => setTimeout(() => r(false), 1500)),
    ]);
    return ok ? { path: p, label: '', type: 'Fixed', ...(await diskSpace(p)) } : null;
  }));
  return found.filter(Boolean);
}

async function computeHome() {
  let raw = null;
  if (IS_WIN) {
    try {
      raw = JSON.parse(fromBase64(await runPowerShell('locais.ps1', {}, 15000)));
    } catch (e) {
      console.warn('[aviso] Não foi possível ler os locais do Windows:', e.message);
    }
  }

  const home = os.homedir();
  const guess = {
    desktop: path.join(home, 'Desktop'),
    downloads: path.join(home, 'Downloads'),
    documents: path.join(home, 'Documents'),
    pictures: path.join(home, 'Pictures'),
    videos: path.join(home, 'Videos'),
    home,
  };

  const places = [];
  const seen = new Set();
  for (const id of Object.keys(PLACE_NAMES)) {
    const p = normalizePath((raw && raw.places && raw.places[id]) || guess[id]);
    if (!p || seen.has(p.toLowerCase())) continue;
    try {
      if (!(await fsp.stat(p)).isDirectory()) continue;
    } catch { continue; }
    seen.add(p.toLowerCase());
    places.push({ id, name: id === 'home' ? displayName(p) : PLACE_NAMES[id], path: p });
  }

  let drives;
  if (raw && raw.drives) {
    drives = [].concat(raw.drives)
      .map((d) => ({
        path: normalizePath(String(d.path || '')),
        label: String(d.label || ''),
        type: String(d.type || ''),
        total: Number(d.total) || 0,
        free: Number(d.free) || 0,
      }))
      .filter((d) => d.path);
  } else if (IS_WIN) {
    drives = await probeWindowsDrives();
  } else {
    drives = [{ path: '/', label: 'Sistema de arquivos', type: 'Fixed', ...(await diskSpace('/')) }];
  }
  return { places, drives };
}

let homeCache = null;
let homeCacheAt = 0;
let homePending = null;

function getHome(force) {
  if (!force && homeCache && Date.now() - homeCacheAt < 30000) return Promise.resolve(homeCache);
  if (!homePending) {
    homePending = computeHome()
      .then((data) => {
        homeCache = data;
        homeCacheAt = Date.now();
        return data;
      })
      .finally(() => { homePending = null; });
  }
  return homePending;
}

/* ------------------------------------------------------------------ API */

async function apiList(res, raw) {
  const target = normalizePath(raw);
  if (!target) {
    return sendError(res, 400, 'invalid', 'Caminho inválido. Use um caminho completo, por exemplo C:\\Users\\Você\\Pictures.');
  }
  let st;
  try {
    st = await fsp.stat(target);
  } catch (e) {
    const [status, code, message] = fsErrorInfo(e);
    return sendError(res, status, code, message, { path: target, nearest: await nearestExisting(target) });
  }

  let dir = target;
  let open = null;
  let notice = null;
  if (!st.isDirectory()) {
    dir = parentOf(target);
    const name = path.basename(target);
    if (st.isFile() && mediaOf(name)) open = name;
    else notice = `“${name}” não é uma imagem nem um vídeo — mostrando a pasta onde ele está.`;
  }

  let listing;
  try {
    listing = await listDir(dir);
  } catch (e) {
    const [status, code, message] = fsErrorInfo(e);
    return sendError(res, status, code, message, { path: dir, nearest: await nearestExisting(dir) });
  }
  if (open && !listing.files.some((f) => f.name === open)) open = null;

  let mtime = 0;
  try { mtime = Math.round((await fsp.stat(dir)).mtimeMs); } catch { /* opcional */ }

  return sendJson(res, 200, {
    path: dir, name: displayName(dir), parent: parentOf(dir), mtime, ...listing, open, notice,
  });
}

async function apiPeek(res, raw) {
  const dir = normalizePath(raw);
  if (!dir) return sendError(res, 400, 'invalid', 'Caminho inválido.');
  try {
    return sendJson(res, 200, await peekDir(dir));
  } catch (e) {
    const [status, code, message] = fsErrorInfo(e);
    return sendError(res, status, code, message);
  }
}

/* ------------------------------------------------- tamanho das pastas */

// Tamanho total de uma pasta (todos os arquivos dentro dela, em qualquer nível), para
// ordenar as subpastas por tamanho. Atalhos e junções não são seguidos (evita contar em
// dobro e laços). Itens sem permissão ficam de fora e o resultado sai como "partial".

// Limita as operações de disco simultâneas de todos os cálculos juntos.
function limiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}
const diskOp = limiter(32);
const CANCELLED = new Error('cálculo cancelado');

// Operação de disco de um cálculo; se ele for cancelado, o que ainda está na fila é descartado.
const sizeOp = (ctx, fn) => diskOp(() => (ctx.aborted ? Promise.reject(CANCELLED) : fn()));

// Resultados por pasta (inclusive as subpastas percorridas): reabrir uma pasta já
// calculada, ou entrar numa subpasta dela, fica instantâneo por alguns minutos.
const SIZE_TTL = 10 * 60 * 1000;
const SIZE_CACHE_MAX = 200000;
const sizeCache = new Map(); // caminho -> { size, files, partial, at }

function cacheSize(dir, r) {
  sizeCache.delete(dir);
  sizeCache.set(dir, { ...r, at: Date.now() });
  if (sizeCache.size > SIZE_CACHE_MAX) {
    for (const k of sizeCache.keys()) {
      sizeCache.delete(k);
      if (sizeCache.size <= SIZE_CACHE_MAX * 0.9) break;
    }
  }
}

async function dirTotal(dir, ctx) {
  if (!ctx.refresh) {
    const hit = sizeCache.get(dir);
    if (hit && Date.now() - hit.at < SIZE_TTL) return hit;
  }
  if (ctx.aborted) return { size: 0, files: 0, partial: true };
  let dirents;
  try {
    dirents = await sizeOp(ctx, () => fsp.readdir(dir, { withFileTypes: true }));
  } catch (e) {
    return { size: 0, files: 0, partial: true, error: e };
  }
  let size = 0;
  let files = 0;
  let partial = false;
  const subdirs = [];
  await Promise.all(dirents.map(async (d) => {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) { subdirs.push(full); return; }
    if (!d.isFile() || ctx.aborted) return; // atalhos/junções e itens especiais
    try {
      // Lê antes de somar: "size += await ..." perderia valores com leituras paralelas.
      const st = await sizeOp(ctx, () => fsp.lstat(full));
      size += st.size;
      files++;
    } catch {
      partial = true;
    }
  }));
  const subs = await Promise.all(subdirs.map((sd) => dirTotal(sd, ctx)));
  for (const r of subs) {
    size += r.size;
    files += r.files;
    if (r.partial) partial = true;
  }
  const result = { size, files, partial: partial || ctx.aborted };
  if (!ctx.aborted) cacheSize(dir, result);
  return result;
}

async function apiDirSize(req, res, raw, refresh) {
  const dir = normalizePath(raw);
  if (!dir) return sendError(res, 400, 'invalid', 'Caminho inválido.');
  const ctx = { aborted: false, refresh };
  // Quem pediu desistiu (trocou de pasta ou de ordenação): para de percorrer o disco.
  res.on('close', () => { if (!res.writableFinished) ctx.aborted = true; });
  const r = await dirTotal(dir, ctx);
  if (ctx.aborted) return undefined;
  if (r.error) {
    const [status, code, message] = fsErrorInfo(r.error);
    return sendError(res, status, code, message);
  }
  return sendJson(res, 200, { path: dir, size: r.size, files: r.files, partial: r.partial });
}

// RFC 8187: além do que encodeURIComponent já codifica, ' ( ) * também precisam ser.
const encodeFilename = (name) => encodeURIComponent(name)
  .replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

async function apiFile(req, res, raw, download) {
  const target = normalizePath(raw);
  const media = target && mediaOf(path.basename(target));
  if (!media) return sendError(res, 403, 'not_media', 'Somente imagens e vídeos podem ser abertos.');

  let st;
  try {
    st = await fsp.stat(target);
  } catch (e) {
    const [status, code, message] = fsErrorInfo(e);
    return sendError(res, status, code, message);
  }
  if (!st.isFile()) return sendError(res, 404, 'not_found', 'Arquivo não encontrado.');

  const size = st.size;
  const etag = `"${size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
  const headers = {
    'Content-Type': media.mime,
    'Accept-Ranges': 'bytes',
    ETag: etag,
    'Last-Modified': st.mtime.toUTCString(),
    'Cache-Control': 'private, max-age=86400',
    // download=1: "Baixar", usado por quem acessa de outro computador.
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeFilename(path.basename(target))}`,
    'X-Content-Type-Options': 'nosniff',
    // Se um SVG for aberto diretamente numa aba, nenhum script dele roda.
    'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'; sandbox",
  };

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }

  let start = 0;
  let end = size - 1;
  let status = 200;
  const range = req.headers.range;
  if (range && size > 0) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (m && (m[1] !== '' || m[2] !== '')) {
      if (m[1] === '') {
        start = Math.max(0, size - Number(m[2]));
      } else {
        start = Number(m[1]);
        if (m[2] !== '') end = Math.min(Number(m[2]), size - 1);
      }
      if (start > end || start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' });
        return res.end();
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
    // Faixas múltiplas ou malformadas: ignora e envia o arquivo inteiro (permitido pela RFC 9110).
  }
  headers['Content-Length'] = size === 0 ? 0 : end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || size === 0) return res.end();

  const stream = fs.createReadStream(target, { start, end });
  pipeline(stream, res, () => { /* cliente cancelou (ex.: ao avançar um vídeo) — normal */ });
}

let picking = false;

async function apiPick(req, res) {
  if (!IS_WIN) return sendError(res, 501, 'unsupported', 'O seletor de pastas nativo só está disponível no Windows.');
  if (picking) return sendError(res, 409, 'busy', 'A janela de seleção de pastas já está aberta.');
  const body = await readJson(req);
  const initial = normalizePath(String(body.initial || '')) || '';
  picking = true;
  try {
    const out = await runPowerShell('escolher-pasta.ps1', {
      VISUALIZADOR_TITULO: 'Escolha uma pasta para visualizar',
      VISUALIZADOR_INICIAL: initial,
    }, 30 * 60 * 1000);
    const chosen = out ? normalizePath(fromBase64(out)) : null;
    return sendJson(res, 200, { path: chosen });
  } catch (e) {
    console.warn('[aviso] Seletor de pastas:', e.message);
    return sendError(res, 500, 'pick_failed', 'Não foi possível abrir a janela de seleção de pastas.');
  } finally {
    picking = false;
  }
}

async function apiOpen(req, res) {
  const body = await readJson(req);
  const target = normalizePath(String(body.path || ''));
  const action = body.action === 'reveal' ? 'reveal' : 'open';
  if (!target) return sendError(res, 400, 'invalid', 'Caminho inválido.');

  let st;
  try {
    st = await fsp.stat(target);
  } catch (e) {
    const [status, code, message] = fsErrorInfo(e);
    return sendError(res, status, code, message);
  }
  // Por segurança, só abre pastas, imagens e vídeos (nunca executáveis).
  if (st.isFile() && !mediaOf(path.basename(target))) {
    return sendError(res, 403, 'not_media', 'Somente imagens, vídeos e pastas podem ser abertos.');
  }
  if (!st.isFile() && !st.isDirectory()) return sendError(res, 400, 'invalid', 'Item não suportado.');

  try {
    if (IS_WIN) {
      if (action === 'reveal' && st.isFile()) {
        // Caminhos do Windows não podem conter aspas, então a montagem é segura.
        spawnDetached('explorer.exe', [`/select,"${target}"`], { windowsVerbatimArguments: true });
      } else {
        await runPowerShell('abrir.ps1', { VISUALIZADOR_ALVO: target }, 20000);
      }
    } else if (process.platform === 'darwin') {
      spawnDetached('open', action === 'reveal' ? ['-R', target] : [target]);
    } else {
      spawnDetached('xdg-open', [action === 'reveal' && st.isFile() ? path.dirname(target) : target]);
    }
    return sendJson(res, 200, { ok: true });
  } catch (e) {
    console.warn('[aviso] Abrir:', e.message);
    return sendError(res, 500, 'open_failed', 'O Windows não conseguiu abrir este item. Talvez não haja um aplicativo associado a este tipo de arquivo.');
  }
}

async function handleApi(req, res, url) {
  const route = url.pathname.slice('/@api/'.length);
  const q = url.searchParams;

  if (req.method === 'POST') {
    if (!postAllowed(req)) return sendError(res, 403, 'forbidden', 'Requisição recusada.');
    // Seletor de pastas e "abrir no aplicativo padrão" abririam janelas no computador
    // do servidor, não no de quem está acessando pelo Tailscale.
    if (!isLocalClient(req)) {
      return sendError(res, 403, 'remote', 'Esta ação só funciona no computador onde o visualizador está rodando.');
    }
    if (route === 'pick') return apiPick(req, res);
    if (route === 'open') return apiOpen(req, res);
    return sendError(res, 404, 'not_found', 'Rota desconhecida.');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'method', 'Método não permitido.');

  switch (route) {
    case 'info':
      return sendJson(res, 200, {
        app: APP_ID, version: VERSION, platform: process.platform, sep: path.sep, home: os.homedir(),
        tailscale: TAILSCALE, remote: !isLocalClient(req),
      });
    case 'home':
      return sendJson(res, 200, await getHome(q.get('refresh') === '1'));
    case 'list':
      return apiList(res, q.get('path'));
    case 'peek':
      return apiPeek(res, q.get('path'));
    case 'dirsize':
      return apiDirSize(req, res, q.get('path'), q.get('refresh') === '1');
    case 'file':
      return apiFile(req, res, q.get('path'), q.get('download') === '1');
    default:
      return sendError(res, 404, 'not_found', 'Rota desconhecida.');
  }
}

/* ------------------------------------------------------- arquivos da interface */

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const PAGE_CSP = [
  "default-src 'self'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

async function serveStatic(req, res, rel) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end();
  }
  let decoded;
  try { decoded = decodeURIComponent(rel); } catch { decoded = ''; }
  const file = path.resolve(PUBLIC_DIR, '.' + path.posix.normalize('/' + decoded));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(404);
    return res.end();
  }
  let data;
  try {
    data = await fsp.readFile(file);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Não encontrado');
  }
  const ext = path.extname(file).toLowerCase();
  const headers = {
    'Content-Type': STATIC_TYPES[ext] || 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  };
  if (ext === '.html') {
    headers['Content-Security-Policy'] = PAGE_CSP;
    headers['Referrer-Policy'] = 'no-referrer';
  }
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : data);
}

/* ---------------------------------------------------------------- servidor */

async function handler(req, res) {
  try {
    if (!hostAllowed(req)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Acesso negado.');
    }
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (p.startsWith('/@api/')) return await handleApi(req, res, url);
    if (p.startsWith('/@app/')) return await serveStatic(req, res, p.slice('/@app/'.length));
    if (p === '/favicon.ico') return await serveStatic(req, res, 'icon.svg');
    // Qualquer outro endereço é uma pasta ou arquivo: a interface interpreta a URL.
    return await serveStatic(req, res, 'index.html');
  } catch (err) {
    console.error('[erro]', err);
    if (!res.headersSent) sendError(res, err.status || 500, 'error', 'Erro interno do servidor.');
    else res.destroy();
  }
}

const server = http.createServer(handler);
server.keepAliveTimeout = 30000;

function findChrome() {
  if (IS_WIN) {
    const candidates = [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ].filter(Boolean);
    return candidates.find((c) => fs.existsSync(c)) || null;
  }
  return null;
}

function openBrowser(url) {
  if (NO_OPEN) return;
  try {
    if (IS_WIN) {
      const chrome = findChrome();
      if (chrome) spawnDetached(chrome, [url]);
      else spawnDetached('cmd.exe', ['/c', 'start', '', url], { windowsHide: true });
    } else if (process.platform === 'darwin') {
      spawnDetached('open', ['-a', 'Google Chrome', url]);
    } else {
      spawnDetached('xdg-open', [url]);
    }
  } catch (e) {
    console.warn('[aviso] Não foi possível abrir o navegador automaticamente:', e.message);
  }
}

/* ------------------------------------------------------ acesso pelo Tailscale */

// Com --tailscale, o servidor também escuta nos endereços deste computador na rede
// Tailscale e só aceita conexões vindas de aparelhos dessa rede. A rede local
// (Wi-Fi/cabo) e a internet continuam sem acesso.

const isTailscaleIPv4 = (ip) => {
  const m = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(ip);
  return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127; // 100.64.0.0/10
};
const isTailscaleIPv6 = (ip) => /^fd7a:115c:a1e0:/i.test(ip); // fd7a:115c:a1e0::/48
const isTailscaleAddress = (ip) => isTailscaleIPv4(ip) || isTailscaleIPv6(ip);

// Endereços deste computador no Tailscale. A interface se chama "Tailscale" no Windows e
// "tailscale0" no Linux; no macOS (utunN), é reconhecida pelo IPv6 próprio do Tailscale.
// Exigir a interface evita confundir com a faixa 100.64.0.0/10 usada por algumas operadoras.
function findTailscaleAddresses() {
  let ifaces;
  try { ifaces = os.networkInterfaces(); } catch { return []; }
  const found = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    const list = addrs || [];
    if (!/tailscale/i.test(name) && !list.some((a) => isTailscaleIPv6(a.address))) continue;
    for (const a of list) if (isTailscaleAddress(a.address)) found.push(a.address.toLowerCase());
  }
  return found;
}

function tailscaleCli() {
  const candidates = IS_WIN
    ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe')]
    : ['/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
  return candidates.find((c) => fs.existsSync(c)) || 'tailscale';
}

// Nomes do computador no MagicDNS do Tailscale (ex.: "meupc" e "meupc.tail1234.ts.net").
// Sem a linha de comando do Tailscale, fica com o nome do computador, que é o padrão dele.
function findTailscaleNames() {
  const names = new Set([os.hostname().toLowerCase().split('.')[0]]);
  return new Promise((resolve) => {
    execFile(tailscaleCli(), ['status', '--json'],
      { timeout: 5000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        if (!err) {
          try {
            const dns = String((JSON.parse(stdout).Self || {}).DNSName || '').toLowerCase().replace(/\.$/, '');
            if (dns) { names.add(dns); names.add(dns.split('.')[0]); }
          } catch { /* saída inesperada: fica só com o nome do computador */ }
        }
        resolve(Array.from(names).filter((n) => /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(n)));
      });
  });
}

const tailscaleServers = new Map(); // endereço -> servidor
const tailscaleWarned = new Set();

// Escuta num endereço do Tailscale. Resolve com true/false quando terminar.
function listenTailscale(addr) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.keepAliveTimeout = 30000;
    // Defesa extra: mesmo escutando no endereço do Tailscale, recusa quem não veio dele.
    srv.on('connection', (socket) => {
      if (!isTailscaleAddress(plainAddress(socket.remoteAddress))) socket.destroy();
    });
    srv.on('error', (err) => {
      if (srv.listening) return;
      tailscaleServers.delete(addr);
      tailscaleHosts.delete(addr);
      // EADDRNOTAVAIL: o endereço acabou de sumir ou ainda não está pronto; tenta de novo depois.
      const key = `${addr}|${err.code}`;
      if (err.code !== 'EADDRNOTAVAIL' && !tailscaleWarned.has(key)) {
        tailscaleWarned.add(key);
        console.warn(`  [aviso] Não foi possível atender pelo Tailscale em ${addr}: ${err.message}`);
      }
      resolve(false);
    });
    tailscaleServers.set(addr, srv);
    tailscaleHosts.add(addr);
    srv.listen(PORT, addr, () => resolve(true));
  });
}

// Acompanha o Tailscale: começa a atender quando ele conecta (mesmo que depois do
// visualizador) e larga o endereço quando ele desconecta. Devolve os endereços novos.
let tailscaleSyncing = false;
async function syncTailscale() {
  if (tailscaleSyncing) return [];
  tailscaleSyncing = true;
  try {
    const current = findTailscaleAddresses();
    for (const [addr, srv] of tailscaleServers) {
      if (current.includes(addr)) continue;
      srv.close();
      tailscaleServers.delete(addr);
      tailscaleHosts.delete(addr);
    }
    const added = current.filter((a) => !tailscaleServers.has(a));
    const ok = await Promise.all(added.map(listenTailscale));
    const fresh = added.filter((a, i) => ok[i]);
    if (fresh.length) for (const n of await findTailscaleNames()) tailscaleHosts.add(n);
    return fresh;
  } finally {
    tailscaleSyncing = false;
  }
}

// Endereços para mostrar na janela: IPv4 e o nome curto do MagicDNS.
function tailscaleUrls() {
  const hosts = [
    ...Array.from(tailscaleServers.keys()).filter(isTailscaleIPv4),
    ...Array.from(tailscaleHosts).filter((h) => !isTailscaleAddress(h) && !h.includes('.')),
  ];
  return hosts.map((h) => `http://${h}:${PORT}/`);
}

function watchTailscale() {
  const timer = setInterval(async () => {
    if ((await syncTailscale()).length) {
      console.log(`\n  Tailscale conectado. Nos outros aparelhos, abra: ${tailscaleUrls().join('  ou  ')}\n`);
    }
  }, 15000);
  timer.unref();
}

/* ---------------------------------------------------------------- início */

// Pergunta ao servidor que já ocupa a porta se ele é o Visualizador (e como está configurado).
function ourServerInfo(port) {
  return new Promise((resolve) => {
    const req = http.get({
      host: '127.0.0.1', port, path: '/@api/info', timeout: 1500,
      headers: { Host: `127.0.0.1:${port}` },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try {
          const info = JSON.parse(body);
          resolve(info.app === APP_ID ? info : null);
        } catch { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function printBanner(url) {
  const line = '─'.repeat(56);
  console.log('');
  console.log(`  ${line}`);
  console.log('   Visualizador de Pastas está rodando!');
  console.log('');
  console.log(`   Endereço:  ${url}`);
  if (TAILSCALE) {
    const urls = tailscaleUrls();
    console.log('');
    if (urls.length) {
      console.log('   Nos outros aparelhos da sua rede Tailscale, abra:');
      for (const u of urls) console.log(`              ${u}`);
    } else {
      console.log('   Tailscale: aguardando a conexão (o endereço aparecerá aqui).');
    }
  }
  console.log('');
  console.log('   Mantenha esta janela aberta enquanto usa o visualizador.');
  console.log('   Para encerrar, feche esta janela ou pressione Ctrl+C.');
  console.log(`  ${line}`);
  console.log('');
}

function start(port, attempt = 0) {
  const onError = async (err) => {
    if (err.code === 'EADDRINUSE') {
      const info = await ourServerInfo(port);
      if (info) {
        const url = `http://localhost:${port}/`;
        if (TAILSCALE && !info.tailscale) {
          console.log(`\n  O Visualizador de Pastas já está aberto em ${url}, mas sem o acesso pelo Tailscale.`);
          console.log('  Feche a janela preta dele e abra "Iniciar Visualizador (Tailscale).bat" de novo.\n');
          process.exitCode = 1;
          return;
        }
        console.log(`\n  O Visualizador de Pastas já está aberto em ${url}\n  Abrindo uma nova aba...\n`);
        openBrowser(url);
        setTimeout(() => process.exit(0), 500);
        return;
      }
      if (attempt < 20) {
        start(port + 1, attempt + 1);
        return;
      }
    }
    console.error('\n  [erro] Não foi possível iniciar o servidor:', err.message);
    process.exitCode = 1;
  };
  server.once('error', onError);
  server.listen(port, '127.0.0.1', async () => {
    server.removeListener('error', onError);
    PORT = port;
    // Também atende em ::1 para que "localhost" responda imediatamente em qualquer configuração.
    const v6 = http.createServer(handler);
    v6.keepAliveTimeout = 30000;
    v6.on('error', () => { /* IPv6 indisponível: sem problema */ });
    v6.listen(port, '::1');

    if (TAILSCALE) {
      await syncTailscale();
      watchTailscale();
    }

    const url = `http://localhost:${port}/`;
    printBanner(url);
    getHome().catch(() => {}); // pré-carrega locais e unidades
    openBrowser(url);
  });
}

// Ctrl+C na janela: encerra sem ser tratado como erro.
process.on('SIGINT', () => {
  console.log('\n  Visualizador encerrado.\n');
  process.exit(0);
});

start(BASE_PORT);
