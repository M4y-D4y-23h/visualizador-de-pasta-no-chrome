// Gera miniaturas de imagens fora da thread principal (a rolagem continua suave).
self.onmessage = async (e) => {
  const { id, url, size } = e.data;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    const w = bmp.width;
    const h = bmp.height;
    // Lado menor = size (para preencher quadrados), lado maior limitado (panoramas).
    const scale = Math.min(1, size / Math.min(w, h), (size * 3) / Math.max(w, h));
    const tw = Math.max(1, Math.round(w * scale));
    const th = Math.max(1, Math.round(h * scale));
    const canvas = new OffscreenCanvas(tw, th);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, tw, th);
    bmp.close();
    const out = await canvas.convertToBlob({ type: 'image/webp', quality: 0.82 });
    self.postMessage({ id, ok: true, blob: out, w, h });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
