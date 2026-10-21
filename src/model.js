/* Subtitle Cleaner - TekiDeki
   SPDX-License-Identifier: Apache-2.0

   Everything here is plain text in, plain text out. Times are whole
   milliseconds, never floats, so the same file always gives the same result
   and the tests can compare numbers instead of hoping. */

(function (global) {
  'use strict';

  var DEFAULT_LIMITS = {
    minDuration: 800,
    maxDuration: 7000,
    maxCharsPerLine: 42,
    maxLines: 2,
    maxCps: 21
  };

  function pad(value, width) {
    var text = String(Math.abs(value));
    while (text.length < width) text = '0' + text;
    return text;
  }

  /* ---------------------------------------------------------------- timecodes */

  function parseStamp(raw) {
    if (typeof raw !== 'string') return null;
    var match = raw.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/);
    if (!match) return null;
    var hours = match[1] ? Number(match[1]) : 0;
    var minutes = Number(match[2]);
    var seconds = Number(match[3]);
    var millis = Number((match[4] + '000').slice(0, 3));
    if (minutes > 59 || seconds > 59) return null;
    return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
  }

  function formatStamp(ms, separator) {
    var total = Math.max(0, Math.round(ms));
    var hours = Math.floor(total / 3600000);
    var minutes = Math.floor((total % 3600000) / 60000);
    var seconds = Math.floor((total % 60000) / 1000);
    var millis = total % 1000;
    return pad(hours, 2) + ':' + pad(minutes, 2) + ':' + pad(seconds, 2) +
      separator + pad(millis, 3);
  }

  function formatClock(ms) {
    var total = Math.max(0, Math.round(ms / 1000));
    var hours = Math.floor(total / 3600);
    var minutes = Math.floor((total % 3600) / 60);
    var seconds = total % 60;
    return hours ? hours + ':' + pad(minutes, 2) + ':' + pad(seconds, 2)
      : minutes + ':' + pad(seconds, 2);
  }

  /* -------------------------------------------------------------------- text */

  var ENTITIES = {
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
    '&apos;': "'", '&nbsp;': ' '
  };

  function decodeEntities(text) {
    return text.replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, function (one) {
      return ENTITIES[one] || one;
    });
  }

  function plain(text) {
    return decodeEntities(text)
      .replace(/<[^>]*>/g, '')
      .replace(/\{\\[^}]*\}/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function countChars(text) {
    return plain(text).replace(/\s/g, '').length;
  }

  /* ------------------------------------------------------------------- parse */

  function splitBlocks(text) {
    return text.split(/\n{2,}/).map(function (block) {
      return block.split('\n');
    }).filter(function (lines) {
      return lines.some(function (line) { return line.trim() !== ''; });
    });
  }

  function parse(text) {
    var clean = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    var warnings = [];
    var looksVtt = /^WEBVTT/.test(clean.trimStart());
    var format = looksVtt ? 'vtt' : 'srt';
    var cues = [];
    var blocks = splitBlocks(clean);

    blocks.forEach(function (lines, blockIndex) {
      if (blocks.length && blockIndex === 0 && /^\s*WEBVTT/.test(lines[0])) {
        lines = lines.slice(1);
        if (!lines.length) return;
      }
      var arrow = -1;
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].indexOf('-->') !== -1) { arrow = i; break; }
      }
      if (arrow === -1) return;

      var timing = lines[arrow].split('-->');
      var start = parseStamp(timing[0]);
      var end = parseStamp(String(timing[1] || '').trim().split(/\s+/)[0]);
      if (start === null || end === null) {
        warnings.push({ code: 'badTiming', line: lines[arrow] });
        return;
      }
      var body = lines.slice(arrow + 1).join('\n').replace(/\s+$/, '');
      cues.push({ index: cues.length + 1, start: start, end: end, text: body });
    });

    return { format: format, cues: cues, warnings: warnings };
  }

  /* --------------------------------------------------------------- serialize */

  function serialize(cues, format) {
    var vtt = format === 'vtt';
    var sep = vtt ? '.' : ',';
    var out = vtt ? ['WEBVTT', ''] : [];
    cues.forEach(function (cue, position) {
      if (!vtt) out.push(String(position + 1));
      out.push(formatStamp(cue.start, sep) + ' --> ' + formatStamp(cue.end, sep));
      out.push(cue.text);
      out.push('');
    });
    if (out.length) out.push('');
    return out.join('\n');
  }

  /* ------------------------------------------------------------------ audit */

  function audit(cues, limits) {
    var L = limits || DEFAULT_LIMITS;
    var counts = {
      empty: 0, backwards: 0, overlap: 0, short: 0, long: 0,
      fast: 0, lineLong: 0, tooManyLines: 0
    };
    var rows = [];

    cues.forEach(function (cue, position) {
      var text = cue.text || '';
      var duration = cue.end - cue.start;
      var body = plain(text);
      var lines = text.split('\n');

      var overlapsNext = position + 1 < cues.length && cue.end > cues[position + 1].start;
      var overlapsPrev = position > 0 && cues[position - 1].end > cue.start;

      var longLine = false;
      lines.forEach(function (line) {
        if (plain(line).length > L.maxCharsPerLine) longLine = true;
      });

      var tooFast = body !== '' && duration > 0 &&
        countChars(text) / (duration / 1000) > L.maxCps + 0.5;

      if (body === '') counts.empty++;
      if (cue.end < cue.start) counts.backwards++;
      if (overlapsPrev) counts.overlap++;
      if (duration > 0 && duration < L.minDuration) counts.short++;
      if (duration > L.maxDuration) counts.long++;
      if (tooFast) counts.fast++;
      if (longLine) counts.lineLong++;
      if (lines.length > L.maxLines) counts.tooManyLines++;

      var codes = [];
      if (body === '') codes.push('empty');
      if (cue.end < cue.start) codes.push('backwards');
      if (overlapsPrev || overlapsNext) codes.push('overlap');
      if (duration > 0 && duration < L.minDuration) codes.push('short');
      if (duration > L.maxDuration) codes.push('long');
      if (tooFast) codes.push('fast');
      if (longLine) codes.push('lineLong');
      if (lines.length > L.maxLines) codes.push('tooManyLines');

      if (codes.length) rows.push({ index: position, codes: codes });
    });

    var total = 0;
    Object.keys(counts).forEach(function (key) { total += counts[key]; });

    return { counts: counts, rows: rows, total: total };
  }

  /* ------------------------------------------------------------- operations */

  function cleanText(cues) {
    var removed = 0;
    var out = [];
    cues.forEach(function (cue) {
      var lines = cue.text.split('\n').map(function (line) {
        return line.replace(/\s+/g, ' ').trim();
      }).filter(function (line) { return line !== ''; });
      if (!lines.length) { removed++; return; }
      var copy = { index: 0, start: cue.start, end: cue.end, text: lines.join('\n') };
      if (copy.text !== cue.text) copy.changed = true;
      out.push(copy);
    });
    return { cues: renumber(out), removed: removed };
  }

  function stripTags(cues) {
    var changed = 0;
    var out = cues.map(function (cue) {
      var text = cue.text
        .replace(/<[^>]*>/g, '')
        .replace(/\{\\[^}]*\}/g, '')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
      if (text !== cue.text) changed++;
      return { index: 0, start: cue.start, end: cue.end, text: text };
    });
    return { cues: renumber(out), changed: changed };
  }

  function shift(cues, millis) {
    var clamped = 0;
    var out = cues.map(function (cue) {
      var start = cue.start + millis;
      var end = cue.end + millis;
      if (start < 0) {
        var duration = cue.end - cue.start;
        start = 0;
        end = Math.max(0, duration);
        clamped++;
      }
      return { index: 0, start: Math.round(start), end: Math.round(end), text: cue.text };
    });
    return { cues: renumber(out), clamped: clamped };
  }

  function retime(cues, factor) {
    var safe = Number(factor);
    if (!isFinite(safe) || safe <= 0.1 || safe > 10) return { cues: cues.slice(), factor: 1 };
    var out = cues.map(function (cue) {
      return {
        index: 0,
        start: Math.round(cue.start / safe),
        end: Math.round(cue.end / safe),
        text: cue.text
      };
    });
    return { cues: renumber(out), factor: safe };
  }

  function fixOverlaps(cues, minDuration) {
    var floor = typeof minDuration === 'number' ? minDuration : 100;
    var out = cues.map(function (cue) {
      return { index: 0, start: cue.start, end: cue.end, text: cue.text };
    });
    var fixed = 0;
    var left = 0;
    for (var i = 0; i < out.length - 1; i++) {
      var a = out[i];
      var b = out[i + 1];
      if (a.end > b.start) {
        if (b.start - a.start >= floor) {
          a.end = b.start;
          fixed++;
        } else {
          left++;
        }
      }
    }
    return { cues: renumber(out), fixed: fixed, left: left };
  }

  function wrapLine(line, maxChars) {
    var words = line.split(/\s+/).filter(Boolean);
    var lines = [];
    var current = '';
    words.forEach(function (word) {
      while (word.length > maxChars) {
        if (current) { lines.push(current); current = ''; }
        lines.push(word.slice(0, maxChars));
        word = word.slice(maxChars);
      }
      if (!current) current = word;
      else if ((current + ' ' + word).length <= maxChars) current += ' ' + word;
      else { lines.push(current); current = word; }
    });
    if (current) lines.push(current);
    return lines;
  }

  function rewrap(cues, maxChars) {
    var limit = maxChars || DEFAULT_LIMITS.maxCharsPerLine;
    var changed = 0;
    var out = cues.map(function (cue) {
      var joined = cue.text.split('\n').map(function (line) { return line.trim(); })
        .filter(Boolean).join(' ');
      var text = wrapLine(joined, limit).join('\n');
      if (text !== cue.text) changed++;
      return { index: 0, start: cue.start, end: cue.end, text: text };
    });
    return { cues: renumber(out), changed: changed };
  }

  function splitLong(cues, maxChars, maxLines) {
    var limit = (maxChars || DEFAULT_LIMITS.maxCharsPerLine) * (maxLines || DEFAULT_LIMITS.maxLines);
    var parts = 0;
    var out = [];
    cues.forEach(function (cue) {
      var joined = cue.text.split('\n').map(function (line) { return line.trim(); })
        .filter(Boolean).join(' ');
      if (joined.length <= limit || cue.end <= cue.start) {
        out.push({ index: 0, start: cue.start, end: cue.end, text: cue.text });
        return;
      }
      var words = joined.split(/\s+/);
      var chunks = [];
      var current = '';
      words.forEach(function (word) {
        if (!current) current = word;
        else if ((current + ' ' + word).length <= limit) current += ' ' + word;
        else { chunks.push(current); current = word; }
      });
      if (current) chunks.push(current);
      if (chunks.length < 2) {
        out.push({ index: 0, start: cue.start, end: cue.end, text: cue.text });
        return;
      }
      var totalChars = joined.length;
      var span = cue.end - cue.start;
      var cursor = cue.start;
      chunks.forEach(function (chunk, at) {
        var last = at === chunks.length - 1;
        var share = last ? cue.end - cursor
          : Math.round(span * (chunk.length / totalChars));
        var end = last ? cue.end : Math.min(cue.end, cursor + Math.max(300, share));
        out.push({ index: 0, start: cursor, end: end, text: chunk });
        cursor = end;
      });
      parts += chunks.length - 1;
    });
    return { cues: renumber(out), parts: parts };
  }

  function sortByTime(cues, stable) {
    var rows = cues.map(function (cue, at) { return { cue: cue, at: at }; });
    rows.sort(function (a, b) {
      if (a.cue.start !== b.cue.start) return a.cue.start - b.cue.start;
      if (stable) return a.at - b.at;
      return a.cue.end - b.cue.end;
    });
    return renumber(rows.map(function (row) {
      return { index: 0, start: row.cue.start, end: row.cue.end, text: row.cue.text };
    }));
  }

  function renumber(cues) {
    return cues.map(function (cue, at) {
      var copy = { index: at + 1, start: cue.start, end: cue.end, text: cue.text };
      if (cue.changed) copy.changed = true;
      return copy;
    });
  }

  function totalLength(cues) {
    if (!cues.length) return 0;
    var end = 0;
    cues.forEach(function (cue) { if (cue.end > end) end = cue.end; });
    return end;
  }

  var api = {
    DEFAULT_LIMITS: DEFAULT_LIMITS,
    parse: parse,
    serialize: serialize,
    parseStamp: parseStamp,
    formatStamp: formatStamp,
    formatClock: formatClock,
    plain: plain,
    countChars: countChars,
    audit: audit,
    cleanText: cleanText,
    stripTags: stripTags,
    shift: shift,
    retime: retime,
    fixOverlaps: fixOverlaps,
    rewrap: rewrap,
    splitLong: splitLong,
    sortByTime: sortByTime,
    wrapLine: wrapLine,
    totalLength: totalLength
  };

  global.TDSubs = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof window !== 'undefined' ? window : globalThis));
