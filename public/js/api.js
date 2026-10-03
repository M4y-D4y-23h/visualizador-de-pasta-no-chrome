// Comunicação com o servidor local.

export class ApiError extends Error {
  constructor(message, status, code, data) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

async function request(url, options) {
  const res = await fetch(url, options);
  let data = null;
  try { data = await res.json(); } catch { /* resposta sem JSON */ }
  if (!res.ok) {
    throw new ApiError((data && data.message) || `Erro ${res.status}`, res.status, data && data.error, data);
  }
  return data;
}

const post = (url, body) => request(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Visualizador': '1' },
  body: JSON.stringify(body || {}),
});

const q = (p) => encodeURIComponent(p);

export const api = {
  info: () => request('/@api/info'),
  home: (refresh) => request('/@api/home' + (refresh ? '?refresh=1' : '')),
  list: (p, signal) => request('/@api/list?path=' + q(p), { signal }),
  peek: (p) => request('/@api/peek?path=' + q(p)),
  dirSize: (p, refresh, signal) => request('/@api/dirsize?path=' + q(p) + (refresh ? '&refresh=1' : ''), { signal }),
  pick: (initial) => post('/@api/pick', { initial }),
  open: (p) => post('/@api/open', { path: p, action: 'open' }),
  reveal: (p) => post('/@api/open', { path: p, action: 'reveal' }),
};

// Endereço do arquivo; "v" muda quando o arquivo muda, permitindo cache seguro.
export const fileSrc = (f) => `/@api/file?path=${q(f.path)}&v=${f.mtime}-${f.size}`;
