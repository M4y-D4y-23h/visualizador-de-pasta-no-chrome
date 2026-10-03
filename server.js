'use strict';
/*
 * Visualizador de Pastas — servidor local (sem dependências externas).
 *
 * Serve a interface (pasta public/) e uma API mínima para:
 *   - listar pastas (somente subpastas, imagens e vídeos);
 *   - transmitir imagens e vídeos do disco (com suporte a Range, para vídeos);
 *   - abrir o seletor de pastas do Windows, o aplicativo padrão e o Explorer.
 *
 * Escuta apenas em 127.0.0.1 (e ::1): nada fica exposto na rede.
 */

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { pipeline } = require('stream');
const { fileURLToPath } = require('url');

const APP_ID = 'visualizador-de-pastas';
const VERSION = '1.0.0';
const IS_WIN = process.platform === 'win32';
const PUBLIC_DIR = path.join(__dirname, 'public');
const SCRIPTS_DIR = path.join(__dirname, 'scripts');

const argv = process.argv.slice(2);
const NO_OPEN = argv.includes('--no-open');
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

function allowedHosts() {
  return new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
}

// Bloqueia DNS rebinding: só aceita requisições endereçadas ao próprio servidor local.
function hostAllowed(req) {
  return allowedHosts().has(String(req.headers.host || '').toLowerCase());
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

async function apiFile(req, res, raw) {
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
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(path.basename(target))}`,
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
    if (route === 'pick') return apiPick(req, res);
    if (route === 'open') return apiOpen(req, res);
    return sendError(res, 404, 'not_found', 'Rota desconhecida.');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'method', 'Método não permitido.');

  switch (route) {
    case 'info':
      return sendJson(res, 200, {
        app: APP_ID, version: VERSION, platform: process.platform, sep: path.sep, home: os.homedir(),
      });
    case 'home':
      return sendJson(res, 200, await getHome(q.get('refresh') === '1'));
    case 'list':
      return apiList(res, q.get('path'));
    case 'peek':
      return apiPeek(res, q.get('path'));
    case 'file':
      return apiFile(req, res, q.get('path'));
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

function isOurServer(port) {
  return new Promise((resolve) => {
    const req = http.get({
      host: '127.0.0.1', port, path: '/@api/info', timeout: 1500,
      headers: { Host: `127.0.0.1:${port}` },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(body).app === APP_ID); } catch { resolve(false); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function printBanner(url) {
  const line = '─'.repeat(56);
  console.log('');
  console.log(`  ${line}`);
  console.log('   Visualizador de Pastas está rodando!');
  console.log('');
  console.log(`   Endereço:  ${url}`);
  console.log('');
  console.log('   Mantenha esta janela aberta enquanto usa o visualizador.');
  console.log('   Para encerrar, feche esta janela ou pressione Ctrl+C.');
  console.log(`  ${line}`);
  console.log('');
}

function start(port, attempt = 0) {
  const onError = async (err) => {
    if (err.code === 'EADDRINUSE') {
      if (await isOurServer(port)) {
        const url = `http://localhost:${port}/`;
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
  server.listen(port, '127.0.0.1', () => {
    server.removeListener('error', onError);
    PORT = port;
    // Também atende em ::1 para que "localhost" responda imediatamente em qualquer configuração.
    const v6 = http.createServer(handler);
    v6.keepAliveTimeout = 30000;
    v6.on('error', () => { /* IPv6 indisponível: sem problema */ });
    v6.listen(port, '::1');

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
