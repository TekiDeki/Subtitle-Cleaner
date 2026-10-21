/* Subtitle Cleaner - TekiDeki
   The file is read here, cleaned here and written back here. Nothing leaves
   the tab, so there is no upload step to wait for and nothing to sign up to. */

(function () {
  'use strict';

  var M = window.TDSubs;
  var ALL = window.TD_LOCALES || {};

  var THEME_KEY = 'subs.theme';
  var LANG_KEY = 'subs.lang';
  var RENDER_LIMIT = 400;
  var TOAST_MS = 3200;

  var state = {
    lang: 'en',
    format: 'srt',
    cues: [],
    name: ''
  };

  var wired = false;
  var toastTimer = 0;

  var $ = function (id) { return document.getElementById(id); };

  /* --------------------------------------------------------------- strings */

  function t(key, vars) {
    var table = ALL[state.lang] || ALL.en || {};
    var text = table[key];
    if (text === undefined) text = (ALL.en || {})[key];
    if (text === undefined) return key;
    if (vars) {
      Object.keys(vars).forEach(function (name) {
        text = text.split('{' + name + '}').join(String(vars[name]));
      });
    }
    return text;
  }

  // Serbian has three plural shapes, Romanian two plus "de" from twenty up,
  // English two. The count decides which key is read.
  function pluralIndex(count) {
    var n = Math.abs(Number(count) || 0);
    if (state.lang === 'ro') {
      if (n === 1) return 'one';
      return (n === 0 || n % 100 >= 20) ? 'many' : 'few';
    }
    if (state.lang === 'sr-latn' || state.lang === 'sr-cyrl') {
      var ten = n % 10;
      var hundred = n % 100;
      if (ten === 1 && hundred !== 11) return 'one';
      if (ten >= 2 && ten <= 4 && (hundred < 12 || hundred > 14)) return 'few';
      return 'many';
    }
    return n === 1 ? 'one' : 'many';
  }

  function tn(base, count, vars) {
    var merged = { n: count };
    if (vars) Object.keys(vars).forEach(function (name) { merged[name] = vars[name]; });
    return t(base + '_' + pluralIndex(count), merged);
  }

  var LANGS = [
    ['en', 'English'],
    ['ro', 'Română'],
    ['sr-latn', 'Srpski (latinica)'],
    ['sr-cyrl', 'Српски (ћирилица)']
  ];

  function detectLang() {
    var saved = '';
    try { saved = localStorage.getItem(LANG_KEY) || ''; } catch (error) {}
    if (ALL[saved]) return saved;
    var tag = String((navigator.language || navigator.userLanguage || 'en')).toLowerCase();
    if (tag.indexOf('ro') === 0) return 'ro';
    if (tag.indexOf('sr') === 0) return 'sr-latn';
    return 'en';
  }

  function applyLang(lang) {
    if (!ALL[lang]) lang = 'en';
    state.lang = lang;
    document.documentElement.lang = lang === 'sr-cyrl' ? 'sr-Cyrl' : lang === 'sr-latn' ? 'sr-Latn' : lang;
    document.querySelectorAll('[data-i18n]').forEach(function (node) {
      node.textContent = t(node.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(function (node) {
      node.setAttribute('placeholder', t(node.getAttribute('data-i18n-placeholder')));
    });
    document.querySelectorAll('[data-i18n-aria-label]').forEach(function (node) {
      node.setAttribute('aria-label', t(node.getAttribute('data-i18n-aria-label')));
    });
    $('lang').value = lang;
    try { localStorage.setItem(LANG_KEY, lang); } catch (error) {}
    render();
  }

  /* ----------------------------------------------------------------- theme */

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  function toggleTheme() {
    var next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem(THEME_KEY, next); } catch (error) {}
  }

  /* ----------------------------------------------------------------- toast */

  function toast(text) {
    var node = $('toast');
    node.textContent = text;
    node.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { node.hidden = true; }, TOAST_MS);
  }

  /* ------------------------------------------------------------------ load */

  var SAMPLE = [
    '1',
    '00:00:00,500 --> 00:00:02,900',
    'This is a sample subtitle file with a few things to fix.',
    '',
    '2',
    '00:00:02,500 --> 00:00:04,000',
    'The first two cues overlap by four hundred milliseconds.',
    '',
    '3',
    '00:00:04,200 --> 00:00:04,700',
    'Too fast',
    '',
    '4',
    '00:00:05,000 --> 00:00:06,200',
    '   Extra   spaces   and <i>tags</i>   inside a line that is far too long to fit   ',
    '',
    '5',
    '00:00:06,400 --> 00:00:12,200',
    'A cue that sits on screen for almost six seconds and keeps one very long line of text.',
    '',
    '6',
    '00:00:13,000 --> 00:00:14,000',
    '   ',
    ''
  ].join('\n');

  function decodeBytes(bytes) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) {
      try { return new TextDecoder('windows-1250').decode(bytes); } catch (inner) { return null; }
    }
  }

  function load(text, name) {
    var parsed = M.parse(text);
    if (!parsed.cues.length) {
      toast(t('errorParse'));
      return false;
    }
    state.cues = parsed.cues;
    state.name = name || '';
    state.format = parsed.format;
    $('format').value = state.format;
    render();
    return true;
  }

  function readFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var bytes = new Uint8Array(reader.result);
      var text = decodeBytes(bytes);
      if (text === null) {
        toast(t('errorFile'));
        return;
      }
      load(text, file.name);
    };
    reader.onerror = function () { toast(t('errorFile')); };
    reader.readAsArrayBuffer(file);
  }

  /* ----------------------------------------------------------------- render */

  function issueLabel(code) {
    if (code === 'overlap') return t('issueOverlap');
    if (code === 'backwards') return t('issueBackwards');
    if (code === 'empty') return t('issueEmpty');
    if (code === 'short') return t('issueShort');
    if (code === 'long') return t('issueLong');
    if (code === 'fast') return t('issueFast');
    if (code === 'lineLong') return t('issueLineLong');
    if (code === 'tooManyLines') return t('issueLines');
    return code;
  }

  var ISSUE_ORDER = ['overlap', 'backwards', 'empty', 'short', 'long', 'fast', 'lineLong', 'tooManyLines'];

  function render() {
    var cues = state.cues;
    var has = cues.length > 0;

    $('file-line').hidden = !has;
    if (has) {
      $('file-name').textContent = state.name || '';
      $('file-meta').textContent = tn('fileCues', cues.length) + ' · ' +
        t('fileLength', { t: M.formatClock(M.totalLength(cues)) });
    }
    $('btn-clear').hidden = !has;
    ['btn-overlaps', 'btn-clean', 'btn-wrap', 'btn-split', 'btn-strip', 'btn-sort',
     'btn-download', 'btn-copy', 'apply-shift', 'apply-speed'].forEach(function (id) {
      $(id).disabled = !has;
    });

    var report = M.audit(cues);
    $('stat-cues').textContent = String(cues.length);
    $('stat-length').textContent = M.formatClock(M.totalLength(cues));
    $('stat-issues').textContent = String(report.total);

    var flags = {};
    report.rows.forEach(function (row) { flags[row.index] = row.codes; });

    var list = $('issues');
    list.textContent = '';
    ISSUE_ORDER.forEach(function (code) {
      var count = report.counts[code] || 0;
      if (!count) return;
      var item = document.createElement('li');
      item.appendChild(document.createTextNode(issueLabel(code)));
      var dot = document.createElement('span');
      dot.className = 'dot';
      dot.textContent = '\u00b7';
      item.appendChild(dot);
      var number = document.createElement('b');
      number.textContent = String(count);
      item.appendChild(number);
      list.appendChild(item);
    });
    $('clean-note').hidden = !(has && report.total === 0);

    $('count').textContent = has ? tn('fileCues', cues.length) : '';
    $('empty').hidden = has;

    var box = $('cues');
    box.textContent = '';
    var shown = cues.slice(0, RENDER_LIMIT);
    shown.forEach(function (cue, index) {
      var row = document.createElement('li');
      row.className = 'cue';

      var time = document.createElement('span');
      time.className = 'cue-time';
      var start = document.createElement('b');
      start.textContent = M.formatStamp(cue.start, '.');
      time.appendChild(start);
      time.appendChild(document.createTextNode(M.formatStamp(cue.end, '.')));

      var body = document.createElement('span');
      body.className = 'cue-text';
      body.textContent = M.plain(cue.text) || '';

      var codes = flags[index];
      if (codes && codes.length) {
        row.className = 'cue flag';
        var tag = document.createElement('span');
        tag.className = 'cue-flags';
        tag.textContent = codes.map(issueLabel).join(' · ');
        body.appendChild(tag);
      }

      row.appendChild(time);
      row.appendChild(body);
      box.appendChild(row);
    });

    var more = $('too-many');
    if (cues.length > RENDER_LIMIT) {
      more.textContent = t('tooMany', { n: RENDER_LIMIT });
      more.hidden = false;
    } else {
      more.hidden = true;
      more.textContent = '';
    }
  }

  /* ------------------------------------------------------------- operations */

  function apply(result) {
    if (result && result.cues) state.cues = result.cues;
    render();
  }

  function wrapLimit() {
    var value = Math.round(Number($('wrap').value));
    if (!isFinite(value) || value < 20) value = 20;
    if (value > 60) value = 60;
    $('wrap').value = String(value);
    return value;
  }

  function onOverlaps() {
    var result = M.fixOverlaps(state.cues, M.DEFAULT_LIMITS.minDuration);
    apply(result);
    var text = t('toastFixed', { n: result.fixed });
    if (result.left > 0) text += ' ' + t('toastLeft', { n: result.left });
    toast(text);
  }

  function onClean() {
    var result = M.cleanText(state.cues);
    apply(result);
    toast(t('toastCleaned', { n: result.removed }));
  }

  function onWrap() {
    var result = M.rewrap(state.cues, wrapLimit());
    apply(result);
    toast(t('toastWrapped', { n: result.changed }));
  }

  function onSplit() {
    var result = M.splitLong(state.cues, wrapLimit(), M.DEFAULT_LIMITS.maxLines);
    apply(result);
    toast(t('toastSplit', { n: result.parts }));
  }

  function onStrip() {
    var result = M.stripTags(state.cues);
    apply(result);
    toast(t('toastStripped', { n: result.changed }));
  }

  function onSort() {
    apply({ cues: M.sortByTime(state.cues, true) });
    toast(t('toastSorted'));
  }

  function onShift() {
    var seconds = Number($('shift').value);
    if (!isFinite(seconds)) seconds = 0;
    if (!seconds) return;
    apply(M.shift(state.cues, Math.round(seconds * 1000)));
    toast(t('toastShift', { n: seconds }));
    $('shift').value = '0';
  }

  function onSpeed() {
    var factor = Number($('speed').value);
    if (!isFinite(factor) || factor <= 0) return;
    factor = Math.min(3, Math.max(0.5, factor));
    $('speed').value = String(factor);
    apply(M.retime(state.cues, factor));
    toast(t('toastSpeed', { n: factor }));
  }

  /* ----------------------------------------------------------------- export */

  function output() {
    return M.serialize(state.cues, state.format);
  }

  function fileName() {
    var base = (state.name || '').replace(/\.(srt|vtt)$/i, '');
    if (!base) base = 'subtitles';
    return base + '.' + state.format;
  }

  function download() {
    if (!state.cues.length) return;
    var blob = new Blob([output()], { type: 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = fileName();
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function copyOut() {
    if (!state.cues.length) return;
    var text = output();
    function done() { toast(t('copied')); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); } catch (error) {}
    document.body.removeChild(area);
    done();
  }

  function clearAll() {
    state.cues = [];
    state.name = '';
    $('paste').value = '';
    $('file-input').value = '';
    $('format').value = state.format;
    render();
  }

  /* ------------------------------------------------------------------- wire */

  function wire() {
    if (wired) return;
    wired = true;

    var select = $('lang');
    LANGS.forEach(function (pair) {
      var option = document.createElement('option');
      option.value = pair[0];
      option.textContent = pair[1];
      select.appendChild(option);
    });
    select.addEventListener('change', function () { applyLang(select.value); });
    $('theme').addEventListener('click', toggleTheme);

    $('file-input').addEventListener('change', function () {
      readFile($('file-input').files[0]);
    });

    var drop = $('drop');
    ['dragenter', 'dragover'].forEach(function (name) {
      drop.addEventListener(name, function (event) {
        event.preventDefault();
        drop.classList.add('over');
      });
    });
    ['dragleave', 'dragend'].forEach(function (name) {
      drop.addEventListener(name, function () { drop.classList.remove('over'); });
    });
    drop.addEventListener('drop', function (event) {
      event.preventDefault();
      drop.classList.remove('over');
      var file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) readFile(file);
    });
    ['dragover', 'drop'].forEach(function (name) {
      window.addEventListener(name, function (event) {
        if (event.target !== drop && !drop.contains(event.target)) event.preventDefault();
      });
    });

    $('btn-paste').addEventListener('click', function () {
      var text = $('paste').value;
      if (!text.trim()) {
        toast(t('errorParse'));
        return;
      }
      if (load(text, '')) $('paste').value = '';
    });

    $('btn-sample').addEventListener('click', function () {
      load(SAMPLE, t('sampleName'));
    });

    $('btn-clear').addEventListener('click', clearAll);
    $('btn-overlaps').addEventListener('click', onOverlaps);
    $('btn-clean').addEventListener('click', onClean);
    $('btn-wrap').addEventListener('click', onWrap);
    $('btn-split').addEventListener('click', onSplit);
    $('btn-strip').addEventListener('click', onStrip);
    $('btn-sort').addEventListener('click', onSort);
    $('apply-shift').addEventListener('click', onShift);
    $('apply-speed').addEventListener('click', onSpeed);
    $('btn-download').addEventListener('click', download);
    $('btn-copy').addEventListener('click', copyOut);

    $('format').addEventListener('change', function () {
      state.format = $('format').value === 'vtt' ? 'vtt' : 'srt';
    });
  }

  /* ------------------------------------------------------------------- boot */

  function boot() {
    wire();
    applyLang(detectLang());

    var local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || local)) {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.__subs = {
    state: state,
    load: load,
    render: render,
    output: output
  };
}());
