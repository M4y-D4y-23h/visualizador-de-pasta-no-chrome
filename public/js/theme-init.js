// Aplica o tema antes de a página ser desenhada (evita o "piscar" de cores).
(function () {
  var theme = null;
  try { theme = JSON.parse(localStorage.getItem('vp:tema')); } catch (e) { /* sem armazenamento */ }
  if (theme !== 'light' && theme !== 'dark') {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  document.documentElement.setAttribute('data-theme', theme);
})();
