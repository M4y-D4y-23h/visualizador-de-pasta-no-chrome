// Utilitários gerais: DOM, formatação (pt-BR), armazenamento e avisos.
import { icon } from './icons.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

const nf0 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const dtShort = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const dtLong = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'long', timeStyle: 'short' });

export const fmtNumber = (n) => nf0.format(n);

export function fmtSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${(v >= 100 ? nf0 : nf1).format(v)} ${units[i]}`;
}

export const fmtDate = (ms) => (ms ? dtShort.format(new Date(ms)) : '');
export const fmtDateLong = (ms) => (ms ? dtLong.format(new Date(ms)) : '');

export function fmtDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const s = Math.max(1, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export const plural = (n, one, many) => `${nf0.format(n)} ${n === 1 ? one : many}`;

// Para busca: ignora maiúsculas e acentos ("ferias" encontra "Férias").
export const fold = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function debounce(fn, ms) {
  let t = 0;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('vp:' + key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem('vp:' + key, JSON.stringify(value)); } catch { /* sem armazenamento */ }
  },
};

const TOAST_ICONS = { info: 'info', success: 'check', error: 'alert' };

export function toast(message, type = 'info', ms = 3600) {
  const box = document.getElementById('toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.innerHTML = `${icon(TOAST_ICONS[type] || 'info')}<span>${esc(message)}</span>`;
  box.appendChild(el);
  while (box.children.length > 3) box.firstElementChild.remove();
  requestAnimationFrame(() => el.classList.add('in'));
  setTimeout(() => {
    el.classList.remove('in');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

export function errorMessage(err) {
  if (err && err.name === 'TypeError') {
    return 'Sem conexão com o Visualizador. Verifique se a janela do servidor continua aberta.';
  }
  return (err && err.message) || 'Algo deu errado.';
}

// A API de área de transferência só existe em localhost/HTTPS; pelo endereço do
// Tailscale (http://100.x.y.z) usa o método antigo.
function copyFallback(text) {
  const prev = document.activeElement;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (prev && prev.focus) prev.focus({ preventScroll: true });
  if (!ok) throw new Error('cópia recusada');
}

export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
    else copyFallback(text);
    toast('Caminho copiado', 'success', 2000);
  } catch {
    toast('Não foi possível copiar', 'error');
  }
}
