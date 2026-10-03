// Conversão entre caminhos do disco e endereços (URLs) do visualizador.
//
//   C:\Users\Kevin\Pictures           <->  /C:/Users/Kevin/Pictures/
//   C:\Users\Kevin\Pictures\foto.jpg  <->  /C:/Users/Kevin/Pictures/foto.jpg
//   \\servidor\fotos\2024             <->  /UNC/servidor/fotos/2024/
//
// Pastas terminam com "/" e arquivos não; apagar o último trecho da URL volta
// para a pasta de cima.

let win = true;

export function setPlatform(platform) {
  win = platform === 'win32';
}

export const isWin = () => win;
const sep = () => (win ? '\\' : '/');

const KEEP = { '%3A': ':', '%40': '@', '%24': '$', '%26': '&', '%2B': '+', '%2C': ',', '%3B': ';', '%3D': '=' };
const encSeg = (s) => encodeURIComponent(s).replace(/%(3A|40|24|26|2B|2C|3B|3D)/gi, (m) => KEEP[m.toUpperCase()]);

// Divide um caminho em raiz + partes.
function split(p) {
  if (win) {
    let m = /^([A-Za-z]):\\?(.*)$/.exec(p);
    if (m) return { kind: 'drive', root: m[1].toUpperCase() + ':', parts: m[2].split('\\').filter(Boolean) };
    m = /^\\\\([^\\]+)\\([^\\]+)\\?(.*)$/.exec(p);
    if (m) return { kind: 'unc', root: `\\\\${m[1]}\\${m[2]}`, server: m[1], share: m[2], parts: m[3].split('\\').filter(Boolean) };
    return null;
  }
  return { kind: 'posix', root: '/', parts: p.split('/').filter(Boolean) };
}

function rootPath(s) {
  if (s.kind === 'drive') return s.root + '\\';
  if (s.kind === 'unc') return s.root + '\\';
  return '/';
}

function joinParts(s, parts) {
  const root = rootPath(s);
  return parts.length ? root + parts.join(sep()) : root;
}

export function dirUrl(p) {
  const s = split(p);
  if (!s) return '/';
  const tail = s.parts.map((x) => encSeg(x) + '/').join('');
  if (s.kind === 'drive') return `/${s.root}/${tail}`;
  if (s.kind === 'unc') return `/UNC/${encSeg(s.server)}/${encSeg(s.share)}/${tail}`;
  return s.parts.length ? `/${tail}` : '/@raiz/';
}

export const fileUrl = (dir, name) => dirUrl(dir) + encSeg(name);

// Endereço -> caminho. null = página inicial; undefined = endereço inválido.
// Pode lançar URIError se a URL tiver uma sequência "%" malformada.
export function urlToPath(pathname) {
  const segs = pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
  if (!segs.length) return null;
  if (win) {
    if (/^[A-Za-z]:$/.test(segs[0])) return segs[0].toUpperCase() + '\\' + segs.slice(1).join('\\');
    if (segs[0] === 'UNC' && segs.length >= 3) return '\\\\' + segs.slice(1).join('\\');
    return undefined;
  }
  if (segs[0] === '@raiz') return '/' + segs.slice(1).join('/');
  return '/' + segs.join('/');
}

export function parent(p) {
  const s = split(p);
  if (!s || !s.parts.length) return null;
  return joinParts(s, s.parts.slice(0, -1));
}

export function base(p) {
  const s = split(p);
  if (!s) return p;
  if (s.parts.length) return s.parts[s.parts.length - 1];
  return s.kind === 'posix' ? '/' : s.root;
}

export function join(dir, name) {
  return dir.endsWith(sep()) ? dir + name : dir + sep() + name;
}

const norm = (p) => {
  let x = p;
  if (x.length > 1 && x.endsWith(sep()) && !/^[A-Za-z]:\\$/.test(x)) x = x.slice(0, -1);
  return win ? x.toLowerCase() : x;
};

export const same = (a, b) => a != null && b != null && norm(a) === norm(b);
export const sameName = (a, b) => (win ? a.toLowerCase() === b.toLowerCase() : a === b);

// a é igual a b ou está dentro de b?
export function within(a, b) {
  const na = norm(a);
  let nb = norm(b);
  if (na === nb) return true;
  if (!nb.endsWith(sep())) nb += sep();
  return na.startsWith(nb);
}

// Trechos para a barra de caminho: [{ name, path }]
export function crumbs(p) {
  const s = split(p);
  if (!s) return [{ name: p, path: p }];
  const out = [];
  if (s.kind === 'drive') out.push({ name: s.root, path: s.root + '\\', root: true });
  else if (s.kind === 'unc') out.push({ name: s.root, path: s.root + '\\', root: true });
  else out.push({ name: '/', path: '/', root: true });
  s.parts.forEach((name, i) => out.push({ name, path: joinParts(s, s.parts.slice(0, i + 1)) }));
  return out;
}
