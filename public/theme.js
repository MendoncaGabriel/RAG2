// Tema do Bento conforme o Jabil Brand Guidelines (paleta primária, escala de azuis/cinzas e cores de uso limitado; fonte Roboto).
// Carregado depois do Tailwind CDN em index.html e login.html. As cores são variáveis CSS (--c-*) em canais RGB, para o tema claro/escuro
// trocar só os valores. Sky Blue não deve ser usado para texto/linhas finas sobre branco: no tema claro use jabil.light/medium.
(function () {
  var LIGHT = {
    jabil: '0 56 101', navy: '0 43 73', old: '0 82 136', medium: '1 100 161', light: '9 144 207', sky: '21 190 240',
    ink: '65 64 66', 'ink-muted': '96 96 91', 'ink-soft': '147 149 152', line: '204 204 204', canvas: '241 242 242', surface: '255 255 255',
    heading: '0 56 101', header: '0 56 101',
    ok: '0 134 81', 'ok-ink': '0 134 81', danger: '203 51 59', 'danger-ink': '203 51 59', warn: '220 88 42', gold: '255 192 0', spring: '102 153 51', leaf: '127 186 0'
  };
  // Escuro: fundos derivados do Navy (#002B49); Sky Blue e Leaf Green (permitidos pelo guia) servem de texto/realce; vermelho de texto é mais claro para dar contraste.
  var DARK = {
    jabil: '0 82 136', navy: '38 62 84', old: '1 100 161', medium: '21 190 240',
    ink: '230 234 237', 'ink-muted': '169 179 188', 'ink-soft': '124 135 145', line: '42 59 74', canvas: '11 22 32', surface: '18 32 45',
    heading: '21 190 240', header: '0 43 73', 'ok-ink': '132 189 0', 'danger-ink': '240 112 118'
  };
  var vars = function (o) { return Object.keys(o).map(function (k) { return '--c-' + k + ':' + o[k]; }).join(';'); };
  var style = document.createElement('style');
  style.textContent = ':root{' + vars(LIGHT) + ';color-scheme:light}html.dark{' + vars(DARK) + ';color-scheme:dark}';
  document.head.appendChild(style);

  var c = function (n) { return 'rgb(var(--c-' + n + ') / <alpha-value>)'; };
  tailwind.config = { theme: { extend: {
    colors: {
      jabil: { DEFAULT: c('jabil'), navy: c('navy'), old: c('old'), medium: c('medium'), light: c('light'), sky: c('sky') },
      ink: { DEFAULT: c('ink'), muted: c('ink-muted'), soft: c('ink-soft') },
      line: c('line'), canvas: c('canvas'), surface: c('surface'), heading: c('heading'), header: c('header'),
      ok: { DEFAULT: c('ok'), ink: c('ok-ink') }, danger: { DEFAULT: c('danger'), ink: c('danger-ink') },
      warn: c('warn'), gold: c('gold'), spring: c('spring'), leaf: c('leaf')
    },
    fontFamily: {
      sans: ['Roboto', 'system-ui', '-apple-system', '"Segoe UI"', 'Arial', 'sans-serif'],
      condensed: ['"Roboto Condensed"', 'Roboto', 'system-ui', 'Arial', 'sans-serif']
    }
  } } };

  // Escolha do tema: preferência salva; sem ela, segue o sistema. Aplicado antes da primeira pintura (script no <head>).
  var KEY = 'bento-theme', root = document.documentElement, mq = matchMedia('(prefers-color-scheme: dark)');
  var saved = function () { try { var s = localStorage.getItem(KEY); return s === 'dark' || s === 'light' ? s : null; } catch (e) { return null; } };
  var current = saved() || (mq.matches ? 'dark' : 'light');
  function apply(t) {
    current = t; var dark = t === 'dark';
    root.classList.toggle('dark', dark);
    var meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.content = dark ? '#002B49' : '#003865';
    document.querySelectorAll('[data-theme-toggle]').forEach(function (b) {
      var label = dark ? 'Mudar para o tema claro' : 'Mudar para o tema escuro';
      b.setAttribute('aria-label', label); b.title = label; b.setAttribute('aria-pressed', String(dark));
    });
  }
  apply(current);
  document.addEventListener('DOMContentLoaded', function () {
    apply(current);
    document.querySelectorAll('[data-theme-toggle]').forEach(function (b) {
      b.addEventListener('click', function () {
        var next = current === 'dark' ? 'light' : 'dark';
        try { localStorage.setItem(KEY, next); } catch (e) {}
        apply(next);
      });
    });
  });
  mq.addEventListener('change', function (e) { if (!saved()) apply(e.matches ? 'dark' : 'light'); });
})();
