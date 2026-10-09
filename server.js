'use strict';
/*
 * Visualizador de Pastas — servidor local (sem dependências obrigatórias).
 *
 * Serve a interface (pasta public/) e uma API mínima para:
 *   - listar pastas (somente subpastas, imagens e vídeos);
 *   - transmitir imagens e vídeos do disco (com suporte a Range, para vídeos);
 *   - gerar miniaturas das imagens (com o pacote opcional "sharp"; veja "Miniaturas");
 *   - baixar uma pasta inteira, com as subpastas, num .zip (veja "Baixar uma pasta");
 *   - abrir o seletor de pastas do Windows, o aplicativo padrão e o Explorer.
 *
 * Escuta apenas em 127.0.0.1 (e ::1): nada fica exposto na rede. Com --tailscale,
 * também atende nos endereços do Tailscale deste computador, e somente a outros
 * aparelhos da mesma rede Tailscale (veja "Acesso pelo Tailscale" abaixo).
 */

// Leituras de disco e miniaturas rodam no pool de threads do Node, que por padrão tem só
// 4: com elas ocupadas (miniaturas, tamanho das pastas), até listar uma pasta esperava na
// fila. Precisa ser definido antes da primeira operação de disco.
if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = '24';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const { once } = require('events');
const { spawn, execFile } = require('child_process');
const { pipeline } = require('stream');
const { fileURLToPath } = require('url');

// Opcional: gera as miniaturas aqui (rápido e leve para o navegador). Sem ele, o navegador
// baixa cada imagem original inteira para fazer a miniatura, como nas versões anteriores.
let sharp = null;
let sharpError = '';
try {
  sharp = require('sharp');
  sharp.cache(false); // não mantém as fotos abertas (no Windows, isso impediria renomeá-las)
} catch (e) {
  sharpError = e && e.code === 'MODULE_NOT_FOUND' && /'sharp'/.test(e.message)
    ? 'pacote "sharp" não instalado'
    : String((e && e.message) || e).split('\n')[0];
}

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

// Formatos de que o servidor gera miniatura (o sharp lê; TIFF inclusive, que o Chrome não
// exibe). SVG já é leve e vai direto; BMP, ICO e HEIC ficam com o navegador.
const THUMB_EXTS = new Set(['jpg', 'jpeg', 'jpe', 'jfif', 'pjpeg', 'pjp', 'png', 'apng', 'gif', 'webp', 'avif', 'tif', 'tiff']);
const canThumb = (ext) => !!sharp && THUMB_EXTS.has(ext);

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
        name, path: full, kind: media.kind, ext: media.ext, web: media.web, thumb: canThumb(media.ext),
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

  // Capa: prefere formatos com miniatura (exibíveis no Chrome ou feitas aqui) e imagens
  // (mais leves que vídeos).
  const rank = (m) => (m.web || canThumb(m.ext) ? 0 : 2) + (m.kind === 'image' ? 0 : 1);
  media.sort((a, b) => rank(a) - rank(b) || collator.compare(a.name, b.name));

  const preview = [];
  for (const m of media) {
    if (preview.length >= 3) break;
    const full = path.join(dir, m.name);
    try {
      const st = await fsp.stat(full);
      preview.push({
        name: m.name, path: full, kind: m.kind, ext: m.ext, web: m.web, thumb: canThumb(m.ext),
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

function sendJson(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(extraHeaders || {}),
  });
  res.end(body);
}

// Cabeçalho Server-Timing: o Chrome mostra, em Ferramentas do desenvolvedor › Rede ›
// Timing, quanto da espera foi trabalho deste computador (disco, miniatura) e quanto foi
// transferência pela rede.
const serverTiming = (name, t0, desc) => ({
  'Server-Timing': `${name};${desc ? `desc="${desc}";` : ''}dur=${(performance.now() - t0).toFixed(1)}`,
});

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
  const t0 = performance.now();
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

  sendJson(res, 200, {
    path: dir, name: displayName(dir), parent: parentOf(dir), mtime, ...listing, open, notice,
  }, serverTiming('disco', t0, 'listar a pasta'));
  warmFolder(dir, listing);
  return undefined;
}

// Resumos já calculados (pela pré-geração ou por outro pedido), válidos enquanto a pasta
// não muda.
const PEEK_TTL = 5 * 60 * 1000;
const peekCache = new Map(); // caminho -> { mtime, at, data }

async function cachedPeek(dir) {
  const st = await fsp.stat(dir);
  const hit = peekCache.get(dir);
  if (hit && hit.mtime === st.mtimeMs && Date.now() - hit.at < PEEK_TTL) return hit.data;
  const data = await peekDir(dir);
  peekCache.delete(dir);
  peekCache.set(dir, { mtime: st.mtimeMs, at: Date.now(), data });
  if (peekCache.size > 5000) peekCache.delete(peekCache.keys().next().value);
  return data;
}

async function apiPeek(res, raw) {
  const t0 = performance.now();
  const dir = normalizePath(raw);
  if (!dir) return sendError(res, 400, 'invalid', 'Caminho inválido.');
  try {
    return sendJson(res, 200, await cachedPeek(dir), serverTiming('disco', t0, 'resumo da pasta'));
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
// Abaixo do pool de threads (UV_THREADPOOL_SIZE): sobra espaço para listar e para miniaturas.
const diskOp = limiter(16);
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

/* ------------------------------------------------------------- miniaturas */

// Com o sharp, as miniaturas são feitas aqui e guardadas em disco: o navegador recebe
// ~20 KB por foto em vez do arquivo original inteiro (vários MB), o que faz muita diferença
// em pastas grandes e, principalmente, pelo Tailscale. Ao abrir uma pasta, o servidor também
// prepara em segundo plano as miniaturas das capas das subpastas, das imagens da pasta e das
// primeiras imagens de cada subpasta, para que entrar nelas já seja imediato.

const THUMB_SIZE = 400;          // lado menor, em pixels (o mesmo do navegador)
const THUMB_VERSION = 1;         // mude para descartar as miniaturas antigas
const THUMB_CACHE_MAX = 2 * 1024 ** 3; // acima disso, as mais antigas são apagadas
const CPUS = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
const THUMB_JOBS = Math.max(2, Math.min(8, CPUS));     // miniaturas feitas ao mesmo tempo
const THUMB_BG_JOBS = Math.max(1, Math.floor(THUMB_JOBS / 2)); // ...das quais em segundo plano
const WARM_PER_SUBFOLDER = 40;   // primeiras imagens preparadas em cada subpasta
const WARM_MAX_NEW = 1500;       // miniaturas novas por pasta aberta, no máximo

const STATE_DIR = process.env.VISUALIZADOR_ESTADO || (IS_WIN
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'VisualizadorDePastas')
  : path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'visualizador-de-pastas'));
const THUMB_DIR = path.join(STATE_DIR, 'miniaturas');

// Muda quando o arquivo muda (tamanho ou data). A data é arredondada como na listagem,
// para que a pré-geração e o pedido do navegador cheguem ao mesmo nome.
function thumbId(full, size, mtimeMs) {
  const key = `${THUMB_VERSION}|${THUMB_SIZE}|${IS_WIN ? full.toLowerCase() : full}|${size}|${Math.round(mtimeMs)}`;
  return crypto.createHash('sha1').update(key).digest('hex');
}
const thumbPath = (id) => path.join(THUMB_DIR, id.slice(0, 2), `${id}.vzt`);

// Arquivo de cache: "VZT1", largura e altura da imagem original (uint32) e o WebP.
async function readThumb(id) {
  try {
    const data = await fsp.readFile(thumbPath(id));
    if (data.length <= 12 || data.toString('latin1', 0, 4) !== 'VZT1') return null;
    return { w: data.readUInt32LE(4), h: data.readUInt32LE(8), buf: data.subarray(12) };
  } catch {
    return null;
  }
}

async function writeThumb(id, t) {
  const file = thumbPath(id);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const head = Buffer.alloc(12);
  head.write('VZT1', 0, 'latin1');
  head.writeUInt32LE(t.w, 4);
  head.writeUInt32LE(t.h, 8);
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(tmp, Buffer.concat([head, t.buf]));
    await fsp.rename(tmp, file); // quem lê nunca vê um arquivo pela metade
  } catch {
    fsp.unlink(tmp).catch(() => {});
  }
}

async function makeThumb(full) {
  const img = sharp(full, { failOn: 'none', sequentialRead: true });
  const meta = await img.metadata();
  let w = meta.width;
  let h = meta.height;
  if (!w || !h) throw new Error('imagem sem dimensões');
  if (meta.orientation >= 5) [w, h] = [h, w]; // fotos de celular "deitadas" (EXIF)
  // Lado menor = THUMB_SIZE (preenche os quadrados), lado maior limitado (panoramas).
  const scale = Math.min(1, THUMB_SIZE / Math.min(w, h), (THUMB_SIZE * 3) / Math.max(w, h));
  const buf = await img
    .rotate()
    .resize(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)), { fit: 'fill' })
    .webp({ quality: 80, effort: 2 })
    .toBuffer();
  return { w, h, buf };
}

// Fila com prioridade: o que o navegador pediu passa na frente da pré-geração, que usa
// no máximo THUMB_BG_JOBS dos THUMB_JOBS lugares.
const thumbJobs = new Map(); // id -> trabalho (pedidos iguais esperam o mesmo)
const thumbQueue = { fg: [], bg: [] };
let thumbActive = 0;
let thumbActiveBg = 0;
const thumbFailed = new Set();

function pumpThumbs() {
  while (thumbActive < THUMB_JOBS) {
    let job = thumbQueue.fg.shift();
    if (!job) {
      if (thumbActiveBg >= THUMB_BG_JOBS || !thumbQueue.bg.length) return;
      job = thumbQueue.bg.shift();
    }
    const bg = job.bg;
    job.started = true;
    thumbActive++;
    if (bg) thumbActiveBg++;
    makeThumb(job.full)
      .then(async (t) => {
        await writeThumb(job.id, t);
        job.resolve(t);
      }, (err) => {
        thumbFailed.add(job.id);
        if (thumbFailed.size > 20000) thumbFailed.delete(thumbFailed.values().next().value);
        job.reject(err);
      })
      .finally(() => {
        thumbJobs.delete(job.id);
        thumbActive--;
        if (bg) thumbActiveBg--;
        pumpThumbs();
      });
  }
}

// Miniatura de um arquivo: do cache em disco ou gerada agora. Rejeita se não der para gerar.
async function getThumb(full, size, mtimeMs, bg) {
  const id = thumbId(full, size, mtimeMs);
  const job = thumbJobs.get(id);
  if (job) {
    const i = !bg && job.bg && !job.started ? thumbQueue.bg.indexOf(job) : -1;
    if (i >= 0) { // o navegador pediu: passa para a frente da fila
      thumbQueue.bg.splice(i, 1);
      job.bg = false;
      thumbQueue.fg.push(job);
      pumpThumbs();
    }
    return { ...(await job.promise), cached: false };
  }
  const hit = await readThumb(id);
  if (hit) return { ...hit, cached: true };
  if (thumbFailed.has(id)) throw new Error('miniatura falhou antes');
  if (thumbJobs.has(id)) return getThumb(full, size, mtimeMs, bg); // outro pedido começou enquanto líamos
  const created = { id, full, bg, started: false };
  created.promise = new Promise((resolve, reject) => { created.resolve = resolve; created.reject = reject; });
  created.promise.catch(() => {}); // a pré-geração não espera por falhas
  thumbJobs.set(id, created);
  thumbQueue[bg ? 'bg' : 'fg'].push(created);
  pumpThumbs();
  return { ...(await created.promise), cached: false };
}

async function apiThumb(req, res, raw) {
  const t0 = performance.now();
  const target = normalizePath(raw);
  const media = target && mediaOf(path.basename(target));
  if (!media || !canThumb(media.ext)) return sendError(res, 404, 'no_thumb', 'Sem miniatura para este arquivo.');
  let st;
  try {
    st = await fsp.stat(target);
  } catch (e) {
    const [status, code, message] = fsErrorInfo(e);
    return sendError(res, status, code, message);
  }
  if (!st.isFile()) return sendError(res, 404, 'not_found', 'Arquivo não encontrado.');

  const etag = `"m${thumbId(target, st.size, st.mtimeMs)}"`;
  const headers = {
    'Content-Type': 'image/webp',
    ETag: etag,
    'Cache-Control': 'private, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  let t;
  try {
    t = await getThumb(target, st.size, st.mtimeMs, false);
  } catch {
    // Arquivo corrompido ou variação que o sharp não lê: o navegador tenta do jeito antigo.
    return sendError(res, 415, 'thumb_failed', 'Não foi possível gerar a miniatura.');
  }
  res.writeHead(200, {
    ...headers,
    'Content-Length': t.buf.length,
    'X-Thumb-Width': t.w, // tamanho da imagem original
    'X-Thumb-Height': t.h,
    ...serverTiming('miniatura', t0, t.cached ? 'do cache' : 'gerada agora'),
  });
  return res.end(req.method === 'HEAD' ? undefined : t.buf);
}

// Pré-geração em segundo plano. Uma pasta aberta cancela a anterior. A mesma pasta listada
// de novo (a interface relista ao voltar para a aba) não recomeça tudo.
const WARM_REPEAT_MS = 10 * 60 * 1000;
let warmToken = 0;
let warmState = null; // { dir, done, at }

function warmFolder(dir, listing) {
  if (!sharp) return;
  if (warmState && warmState.dir === dir && (!warmState.done || Date.now() - warmState.at < WARM_REPEAT_MS)) return;
  const token = ++warmToken;
  const state = { dir, done: false, at: 0 };
  warmState = state;
  // Um instante depois: os primeiros pedidos do navegador chegam antes.
  setTimeout(() => {
    warmRun(token, listing)
      .catch((e) => console.warn('[aviso] Pré-geração de miniaturas:', e.message))
      .finally(() => {
        state.done = true;
        state.at = Date.now();
      });
  }, 300);
}

// As primeiras imagens (por nome) de uma subpasta, sem listar tudo o que há nela.
async function firstImages(dir, n) {
  const names = [];
  for (const d of await fsp.readdir(dir, { withFileTypes: true })) {
    if (!d.isFile() || isHidden(d.name, dir)) continue;
    const m = mediaOf(d.name);
    if (m && canThumb(m.ext)) names.push(d.name);
  }
  names.sort(collator.compare);
  const out = [];
  for (const name of names.slice(0, n)) {
    const full = path.join(dir, name);
    try {
      const st = await fsp.stat(full);
      out.push({ path: full, size: st.size, mtime: Math.round(st.mtimeMs) });
    } catch { /* sumiu */ }
  }
  return out;
}

async function warmRun(token, listing) {
  const alive = () => token === warmToken;
  let made = 0;
  const warm = async (files) => {
    await mapLimit(files, THUMB_BG_JOBS, async (f) => {
      if (!alive() || made >= WARM_MAX_NEW) return;
      const id = thumbId(f.path, f.size, f.mtime);
      if (thumbFailed.has(id)) return;
      try {
        await fsp.access(thumbPath(id)); // já existe: não precisa ler
        return;
      } catch { /* ainda não existe */ }
      try {
        if (!(await getThumb(f.path, f.size, f.mtime, true)).cached) made++;
      } catch { /* arquivo com problema: o navegador mostra o ícone */ }
    });
  };
  const subfolders = listing.folders.slice().sort((a, b) => collator.compare(a.name, b.name));

  // 1) Capas das subpastas (aparecem no topo da tela).
  const covers = [];
  await mapLimit(subfolders, 4, async (sub, i) => {
    if (!alive()) return;
    try { covers[i] = (await cachedPeek(sub.path)).preview.filter((p) => p.thumb); } catch { /* sem acesso */ }
  });
  if (!alive()) return;
  await warm(covers.flat());
  // 2) Imagens desta pasta.
  if (!alive()) return;
  await warm(listing.files.filter((f) => f.thumb));
  // 3) Primeiras imagens de cada subpasta: entrar nelas já mostra tudo.
  for (const sub of subfolders) {
    if (!alive() || made >= WARM_MAX_NEW) return;
    try { await warm(await firstImages(sub.path, WARM_PER_SUBFOLDER)); } catch { /* sem acesso */ }
  }
}

// Mantém o cache abaixo de THUMB_CACHE_MAX, apagando as miniaturas mais antigas.
async function trimThumbCache() {
  let shards;
  try { shards = await fsp.readdir(THUMB_DIR); } catch { return; }
  const files = [];
  let total = 0;
  await mapLimit(shards, 4, async (shard) => {
    const dir = path.join(THUMB_DIR, shard);
    let names;
    try { names = await fsp.readdir(dir); } catch { return; }
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        const st = await fsp.stat(full);
        files.push({ full, size: st.size, t: st.mtimeMs });
        total += st.size;
      } catch { /* apagado no meio do caminho */ }
    }
  });
  if (total <= THUMB_CACHE_MAX) return;
  files.sort((a, b) => a.t - b.t);
  for (const f of files) {
    if (total <= THUMB_CACHE_MAX * 0.8) break;
    try {
      await fsp.unlink(f.full);
      total -= f.size;
    } catch { /* em uso: fica para a próxima */ }
  }
}

function scheduleThumbCacheTrim() {
  if (!sharp) return;
  const run = () => trimThumbCache().catch(() => {});
  setTimeout(run, 2 * 60 * 1000).unref();
  setInterval(run, 6 * 60 * 60 * 1000).unref();
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

/* ------------------------------------------------------- baixar uma pasta */

// "Baixar tudo": as imagens e os vídeos de uma pasta e de todas as subpastas dela num só
// .zip, montado enquanto é enviado (nada é gravado em disco nem acumulado na memória, e o
// download começa na hora). Entram os mesmos arquivos que o visualizador mostra: somente
// imagens e vídeos, sem itens ocultos ou de sistema. Sem compressão: fotos e vídeos já vêm
// comprimidos, e comprimir de novo só gastaria processador. Arquivos de 4 GB ou mais e zips
// muito grandes usam a extensão ZIP64, que o Windows, o 7-Zip e o macOS abrem normalmente.

const ZIP_MAX32 = 0xffffffff;
const ZIP_FLAGS = 0x0808; // CRC e tamanhos depois dos dados (bit 3) e nomes em UTF-8 (bit 11)
const ZIP_SKIPPED_NAME = 'ARQUIVOS NÃO INCLUÍDOS.txt';

// CRC-32 exigido pelo zip: nativo a partir do Node 20.15/22.2; antes disso, em JavaScript.
let crcTable = null;
function crc32js(buf, prev = 0) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = ~prev;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
const crc32 = typeof zlib.crc32 === 'function' ? zlib.crc32 : crc32js;

// Data de modificação no formato do zip (MS-DOS: hora local, de 1980 a 2107).
function dosDateTime(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  if (!(y >= 1980)) return { date: (1 << 5) | 1, time: 0 }; // 01/01/1980 (ou data inválida)
  if (y > 2107) return { date: (127 << 9) | (12 << 5) | 31, time: (23 << 11) | (59 << 5) | 29 };
  return {
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
  };
}

// Campo extra ZIP64 (0x0001): os valores de 64 bits que não cabem no cabeçalho.
function zip64Extra(values) {
  const b = Buffer.alloc(4 + 8 * values.length);
  b.writeUInt16LE(0x0001, 0);
  b.writeUInt16LE(8 * values.length, 2);
  values.forEach((v, i) => b.writeBigUInt64LE(BigInt(v), 4 + 8 * i));
  return b;
}

// Nome da pasta dentro do zip e do próprio .zip, válido como nome de arquivo no Windows.
function zipRootName(dir) {
  let name = displayName(dir);
  if (IS_WIN && isDriveRoot(dir)) name = `Disco ${dir[0]}`;
  else if (IS_WIN && isUncRoot(dir)) name = dir.split('\\').filter(Boolean).pop();
  else if (dir === '/') name = 'Raiz';
  name = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '');
  return name || 'Pasta';
}

// Percorre a pasta e as subpastas (por nome; em cada uma, os arquivos antes das subpastas) e
// entrega as imagens e os vídeos com o caminho que terão dentro do zip. Segue atalhos e
// junções, como a listagem, mas não entra num atalho que aponta para uma pasta de cima
// (o que seria um laço sem fim). Se a própria pasta não puder ser lida, lança o erro;
// subpastas sem acesso são anotadas em ctx.skipped e ficam de fora.
async function* walkMedia(dir, prefix, ctx, ancestors = new Set()) {
  let real = dir;
  try { real = await fsp.realpath(dir); } catch { /* fica com o caminho recebido */ }
  const key = IS_WIN ? real.toLowerCase() : real;
  if (ancestors.has(key)) return;

  const dirents = await fsp.readdir(dir, { withFileTypes: true });
  const files = [];
  const subdirs = [];
  await mapLimit(dirents, 16, async (d) => {
    if (ctx.aborted || isHidden(d.name, dir)) return;
    const full = path.join(dir, d.name);
    try {
      let st = null;
      let isDir = d.isDirectory();
      let isFile = d.isFile();
      if (d.isSymbolicLink()) {
        st = await resolveLink(full);
        isDir = st.isDirectory();
        isFile = st.isFile();
      }
      if (isDir) { subdirs.push({ name: d.name, full }); return; }
      if (!isFile || !mediaOf(d.name)) return;
      st = st || (await fsp.stat(full));
      files.push({ name: d.name, full, size: st.size, mtime: st.mtimeMs });
    } catch {
      // Item inacessível ou removido durante a leitura: também não aparece na listagem.
    }
  });
  const byName = (a, b) => collator.compare(a.name, b.name);
  files.sort(byName);
  subdirs.sort(byName);

  // Barra invertida é separador dentro do zip; só aparece em nomes fora do Windows.
  const zipName = (name) => prefix + name.replace(/\\/g, '_');
  for (const f of files) yield { ...f, zipName: zipName(f.name) };
  ancestors.add(key);
  try {
    for (const s of subdirs) {
      if (ctx.aborted) return;
      try {
        yield* walkMedia(s.full, `${zipName(s.name)}/`, ctx, ancestors);
      } catch {
        ctx.skipped.push(`${zipName(s.name)}/  (pasta sem acesso)`);
      }
    }
  } finally {
    ancestors.delete(key);
  }
}

const ZIP_CHUNK = 1024 * 1024;  // leitura dos arquivos
const ZIP_BATCH = 64 * 1024;    // pedaços menores (cabeçalhos, arquivos pequenos) vão juntos

// Lê o arquivo em pedaços, sempre com a leitura do próximo já em andamento (o disco trabalha
// enquanto a rede envia). Lê só até o tamanho visto na listagem: um arquivo que ainda está
// sendo copiado para a pasta não muda o zip no meio do caminho.
async function* readChunks(fh, size) {
  const read = (pos) => {
    const len = Math.min(ZIP_CHUNK, size - pos);
    const p = fh.read(Buffer.allocUnsafe(len), 0, len, pos);
    p.catch(() => {}); // o erro chega pelo await abaixo; sem isto, um download cancelado derrubaria o servidor
    return p;
  };
  let pos = 0;
  let pending = size > 0 ? read(0) : null;
  try {
    while (pending) {
      const { bytesRead, buffer } = await pending;
      pending = null;
      if (!bytesRead) return; // o arquivo diminuiu
      pos += bytesRead;
      if (pos < size) pending = read(pos);
      yield bytesRead < buffer.length ? buffer.subarray(0, bytesRead) : buffer;
    }
  } finally {
    if (pending) await pending.catch(() => {}); // o arquivo só é fechado depois da última leitura
  }
}

// Escreve o zip na resposta no ritmo de quem baixa. Se o download for cancelado, as
// escritas lançam CANCELLED.
function createZipWriter(res, ctx) {
  let offset = 0;
  const entries = [];
  const closed = once(res, 'close').catch(() => {});
  let batch = [];
  let batchSize = 0;

  async function send(buf) {
    if (!res.write(buf)) await Promise.race([once(res, 'drain'), closed]);
  }
  async function flush() {
    if (!batchSize) return;
    const buf = batch.length === 1 ? batch[0] : Buffer.concat(batch, batchSize);
    batch = [];
    batchSize = 0;
    await send(buf);
  }
  async function out(buf) {
    if (ctx.aborted) throw CANCELLED;
    offset += buf.length;
    if (buf.length >= ZIP_BATCH) {
      await flush();
      await send(buf);
      return;
    }
    batch.push(buf);
    batchSize += buf.length;
    if (batchSize >= ZIP_BATCH) await flush();
  }

  // Uma entrada: cabeçalho, dados (os pedaços de "chunks", sem compressão) e o descritor com
  // o CRC e o tamanho, que só são conhecidos no fim. "big": arquivo de 4 GB ou mais (ZIP64).
  // Devolve false se a leitura falhou no meio: o que foi lido fica, e o zip continua válido.
  async function add(name, mtimeMs, big, chunks) {
    const nameBuf = Buffer.from(name, 'utf8');
    const { date, time } = dosDateTime(mtimeMs);
    const extra = big ? zip64Extra([0, 0]) : Buffer.alloc(0);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(big ? 45 : 20, 4); // versão necessária para extrair
    head.writeUInt16LE(ZIP_FLAGS, 6);
    head.writeUInt16LE(0, 8); // sem compressão
    head.writeUInt16LE(time, 10);
    head.writeUInt16LE(date, 12);
    // CRC e tamanhos (bytes 14 a 25) ficam zerados: vão no descritor, depois dos dados.
    head.writeUInt16LE(nameBuf.length, 26);
    head.writeUInt16LE(extra.length, 28);
    const start = offset;
    await out(head);
    await out(nameBuf);
    if (extra.length) await out(extra);

    let crc = 0;
    let size = 0;
    let ok = true;
    try {
      for await (const chunk of chunks) {
        crc = crc32(chunk, crc);
        size += chunk.length;
        await out(chunk);
      }
    } catch (e) {
      if (e === CANCELLED || ctx.aborted) throw CANCELLED;
      ok = false;
    }

    const desc = Buffer.alloc(big ? 24 : 16);
    desc.writeUInt32LE(0x08074b50, 0);
    desc.writeUInt32LE(crc, 4);
    if (big) {
      desc.writeBigUInt64LE(BigInt(size), 8);
      desc.writeBigUInt64LE(BigInt(size), 16);
    } else {
      desc.writeUInt32LE(size, 8);
      desc.writeUInt32LE(size, 12);
    }
    await out(desc);
    entries.push({ nameBuf, date, time, crc, size, big, offset: start });
    return ok;
  }

  // Diretório central (o índice que os programas leem para abrir o zip) e o registro final.
  async function finish() {
    const cdStart = offset;
    for (const e of entries) {
      const bigOffset = e.offset >= ZIP_MAX32;
      const values = e.big ? [e.size, e.size] : [];
      if (bigOffset) values.push(e.offset);
      const extra = values.length ? zip64Extra(values) : Buffer.alloc(0);
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(45, 4); // criado por: MS-DOS/Windows, especificação 4.5
      h.writeUInt16LE(values.length ? 45 : 20, 6);
      h.writeUInt16LE(ZIP_FLAGS, 8);
      h.writeUInt16LE(0, 10);
      h.writeUInt16LE(e.time, 12);
      h.writeUInt16LE(e.date, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(e.big ? ZIP_MAX32 : e.size, 20);
      h.writeUInt32LE(e.big ? ZIP_MAX32 : e.size, 24);
      h.writeUInt16LE(e.nameBuf.length, 28);
      h.writeUInt16LE(extra.length, 30);
      h.writeUInt32LE(bigOffset ? ZIP_MAX32 : e.offset, 42);
      await out(h);
      await out(e.nameBuf);
      if (extra.length) await out(extra);
    }

    const cdSize = offset - cdStart;
    const count = entries.length;
    if (count >= 0xffff || cdStart >= ZIP_MAX32 || cdSize >= ZIP_MAX32) {
      // Registro final ZIP64 e o localizador dele.
      const z = Buffer.alloc(56 + 20);
      z.writeUInt32LE(0x06064b50, 0);
      z.writeBigUInt64LE(44n, 4); // tamanho do restante do registro
      z.writeUInt16LE(45, 12);
      z.writeUInt16LE(45, 14);
      z.writeBigUInt64LE(BigInt(count), 24);
      z.writeBigUInt64LE(BigInt(count), 32);
      z.writeBigUInt64LE(BigInt(cdSize), 40);
      z.writeBigUInt64LE(BigInt(cdStart), 48);
      z.writeUInt32LE(0x07064b50, 56);
      z.writeBigUInt64LE(BigInt(offset), 64);
      z.writeUInt32LE(1, 72); // total de discos
      await out(z);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Math.min(count, 0xffff), 8);
    end.writeUInt16LE(Math.min(count, 0xffff), 10);
    end.writeUInt32LE(Math.min(cdSize, ZIP_MAX32), 12);
    end.writeUInt32LE(Math.min(cdStart, ZIP_MAX32), 16);
    await out(end);
    await flush();
    res.end();
  }

  return { add, finish };
}

async function apiZip(req, res, raw, check) {
  const dir = normalizePath(raw);
  if (!dir) return sendError(res, 400, 'invalid', 'Caminho inválido.');
  // Só a própria interface (ou o endereço colado na barra do Chrome) pode pedir: uma página
  // de outro site não consegue fazer o navegador ler uma pasta inteira daqui.
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return sendError(res, 403, 'forbidden', 'Requisição recusada.');

  const ctx = { aborted: false, skipped: [] };
  res.on('close', () => { if (!res.writableFinished) ctx.aborted = true; });
  const root = zipRootName(dir);
  const filename = `${root}.zip`;
  const files = walkMedia(dir, `${root}/`, ctx);

  // Procura o primeiro arquivo antes de responder: pasta vazia ou sem acesso vira uma
  // mensagem na interface (o "check" é feito antes de baixar), e não um download com erro.
  let next;
  try {
    next = await files.next();
  } catch (e) {
    const [status, code, message] = fsErrorInfo(e);
    return sendError(res, status, code, message);
  }
  if (next.done) return sendError(res, 404, 'empty', 'Não há imagens nem vídeos nesta pasta nem nas subpastas dela.');
  if (check) {
    await files.return();
    return sendJson(res, 200, { name: filename });
  }

  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeFilename(filename)}`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.flushHeaders(); // o Chrome já mostra o download, mesmo se o disco demorar a responder
  if (req.method === 'HEAD') {
    await files.return();
    return res.end();
  }
  const zip = createZipWriter(res, ctx);
  try {
    for (; !next.done; next = await files.next()) {
      const f = next.value;
      let fh;
      try {
        fh = await fsp.open(f.full, 'r');
      } catch {
        ctx.skipped.push(f.zipName);
        continue;
      }
      try {
        if (!(await zip.add(f.zipName, f.mtime, f.size >= ZIP_MAX32, readChunks(fh, f.size)))) {
          ctx.skipped.push(`${f.zipName}  (incompleto: erro de leitura)`);
        }
      } finally {
        await fh.close().catch(() => {});
      }
    }
    if (ctx.skipped.length) {
      const text = [
        'Estes itens não puderam ser lidos (sem permissão, em uso por outro programa ou',
        'removidos durante o download) e ficaram de fora deste arquivo .zip:',
        '',
        ...ctx.skipped,
        '',
      ].join('\r\n');
      await zip.add(`${root}/${ZIP_SKIPPED_NAME}`, Date.now(), false, [Buffer.from(`\ufeff${text}`, 'utf8')]);
    }
    await zip.finish();
  } catch (e) {
    if (e !== CANCELLED) console.warn('[aviso] Baixar pasta:', e.message);
    // Sem isto, um erro no meio deixaria um zip cortado parecendo completo; assim o Chrome
    // mostra o download como "falhou".
    res.destroy();
  } finally {
    files.return().catch(() => {});
  }
  return undefined;
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
        tailscale: TAILSCALE, remote: !isLocalClient(req), thumbs: !!sharp,
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
    case 'thumb':
      return apiThumb(req, res, q.get('path'));
    case 'zip':
      return apiZip(req, res, q.get('path'), q.get('check') === '1');
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
  console.log(sharp
    ? '   Miniaturas: geradas aqui e guardadas (rápido também pelo Tailscale).'
    : `   Miniaturas: feitas pelo navegador, mais lento (${sharpError}).`);
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
    scheduleThumbCacheTrim();
    openBrowser(url);
  });
}

// Ctrl+C na janela: encerra sem ser tratado como erro.
process.on('SIGINT', () => {
  console.log('\n  Visualizador encerrado.\n');
  process.exit(0);
});

start(BASE_PORT);
