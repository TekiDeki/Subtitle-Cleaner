#!/usr/bin/env node
/* Model checks for Subtitle Cleaner. No browser, no network.
 *
 *     node tests/logic_test.cjs
 *
 * Subtitles go wrong in ways that are hard to see: a cue that ends after the
 * next one starts, a line that loses a word when it is re-wrapped, a shift that
 * pushes the first cue below zero. Every case below is one of those.
 */
'use strict';

const M = require('../src/model.js');

let checks = 0;
const failures = [];

function ok(condition, message) {
  checks++;
  if (!condition) failures.push(message);
}

function eq(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(a === e, message + '\n    expected ' + e + '\n    got      ' + a);
}

function cue(start, end, text) {
  return { index: 0, start: start, end: end, text: text };
}

/* --------------------------------------------------------------- timecodes */

eq(M.parseStamp('00:00:01,000'), 1000, 'a comma stamp is read');
eq(M.parseStamp('00:00:01.250'), 1250, 'a dot stamp is read');
eq(M.parseStamp(' 00:00:01,000 '), 1000, 'spaces around a stamp are ignored');
eq(M.parseStamp('01:02:03,004'), 3723004, 'hours, minutes, seconds and milliseconds');
eq(M.parseStamp('0:00:01,5'), 1500, 'one digit milliseconds are tenths');
eq(M.parseStamp('00:00:01,05'), 1050, 'two digit milliseconds are hundredths');
eq(M.parseStamp('1:02:03,4'), 3723400, 'one digit hours are accepted');
eq(M.parseStamp('1:2:3,4'), null, 'one digit minutes and seconds are refused');
eq(M.parseStamp('00:60:00,000'), null, 'sixty minutes is not a stamp');
eq(M.parseStamp('00:00:60,000'), null, 'sixty seconds is not a stamp');
eq(M.parseStamp('00:00:01'), null, 'a stamp without milliseconds is refused');
eq(M.parseStamp('hello'), null, 'words are not a stamp');
eq(M.parseStamp(null), null, 'null is not a stamp');

eq(M.formatStamp(0, ','), '00:00:00,000', 'zero formats with a comma');
eq(M.formatStamp(3723004, '.'), '01:02:03.004', 'a long time formats with hours');
eq(M.formatStamp(-50, ','), '00:00:00,000', 'a negative time is clamped to zero');
eq(M.formatStamp(1500, ','), '00:00:01,500', 'half a second keeps its milliseconds');

eq(M.formatClock(0), '0:00', 'zero is a short clock');
eq(M.formatClock(65000), '1:05', 'a minute and five seconds');
eq(M.formatClock(3661000), '1:01:01', 'an hour brings the third field');

/* ------------------------------------------------------------------- parse */

const srt = [
  '1',
  '00:00:01,000 --> 00:00:04,000',
  'Hello there',
  '',
  '2',
  '00:00:05,000 --> 00:00:07,500',
  'Second cue',
  ''
].join('\n');

const fromSrt = M.parse(srt);
eq(fromSrt.format, 'srt', 'an SRT without a header is an SRT');
eq(fromSrt.cues.length, 2, 'two cues are read');
eq(fromSrt.cues[0], { index: 1, start: 1000, end: 4000, text: 'Hello there' }, 'the first cue keeps its times and text');
eq(fromSrt.cues[1].end, 7500, 'the second cue ends at seven and a half seconds');
eq(fromSrt.warnings, [], 'a clean file has no warnings');

const crlf = M.parse('\uFEFF1\r\n00:00:01,000 --> 00:00:02,000\r\nLine one\r\n\r\n');
eq(crlf.cues.length, 1, 'a byte order mark and CRLF line endings are handled');
eq(crlf.cues[0].text, 'Line one', 'the text loses the carriage return');

const noIndex = M.parse('00:00:01,000 --> 00:00:02,000\nNo number\n');
eq(noIndex.cues.length, 1, 'a cue without its number is still read');
eq(noIndex.cues[0].index, 1, 'the index is rebuilt from the position');

const threeLines = M.parse('1\n00:00:01,000 --> 00:00:02,000\nOne\nTwo\nThree\n');
eq(threeLines.cues[0].text, 'One\nTwo\nThree', 'a three line cue keeps its lines');

const vtt = [
  'WEBVTT',
  '',
  '00:00:01.000 --> 00:00:02.500 align:start position:10%',
  'A VTT cue',
  ''
].join('\n');
const fromVtt = M.parse(vtt);
eq(fromVtt.format, 'vtt', 'WEBVTT marks the file as VTT');
eq(fromVtt.cues.length, 1, 'the header block is not a cue');
eq(fromVtt.cues[0].start, 1000, 'VTT times are read the same way');
eq(fromVtt.cues[0].end, 2500, 'the cue settings after the arrow are ignored');

const bad = M.parse('1\n00:00:aa,000 --> 00:00:02,000\nBroken\n');
eq(bad.cues.length, 0, 'a broken stamp drops the cue');
eq(bad.warnings.length, 1, 'and leaves a warning');
eq(bad.warnings[0].code, 'badTiming', 'the warning names the reason');

eq(M.parse('').cues.length, 0, 'empty text has no cues');
eq(M.parse('just words\nand more words').cues.length, 0, 'a text without an arrow has no cues');

/* --------------------------------------------------------------- serialize */

const two = [cue(1000, 4000, 'Hello'), cue(5000, 7500, 'Second')];
eq(M.serialize(two, 'srt'),
  '1\n00:00:01,000 --> 00:00:04,000\nHello\n\n2\n00:00:05,000 --> 00:00:07,500\nSecond\n\n',
  'SRT output is numbered from one');
ok(M.serialize(two, 'vtt').startsWith('WEBVTT\n\n'), 'VTT output opens with the header');
ok(M.serialize(two, 'vtt').includes('00:00:01.000 --> 00:00:04.000'), 'VTT output uses dots');
ok(!M.serialize(two, 'vtt').includes('\n1\n'), 'VTT output carries no cue numbers');

const round = M.parse(M.serialize(two, 'srt'));
eq(round.cues.map(function (c) { return [c.start, c.end, c.text]; }),
  [[1000, 4000, 'Hello'], [5000, 7500, 'Second']],
  'a serialized file reads back the same');

const roundVtt = M.parse(M.serialize(two, 'vtt'));
eq(roundVtt.format, 'vtt', 'the VTT round trip stays VTT');
eq(roundVtt.cues.length, 2, 'the VTT round trip keeps both cues');

eq(M.serialize([], 'srt'), '', 'an empty list writes nothing');
eq(M.serialize([], 'vtt'), 'WEBVTT\n\n', 'an empty VTT keeps the header');

/* ------------------------------------------------------------------- text */

eq(M.plain('<i>Hi</i>  there'), 'Hi there', 'tags are dropped and spaces collapse');
eq(M.plain('{\\an8}Top'), 'Top', 'an ASS position block is dropped');
eq(M.plain('a &amp; b'), 'a & b', 'entities are decoded');
eq(M.countChars('<i>ab cd</i>'), 4, 'the character count skips tags and spaces');
eq(M.countChars(''), 0, 'an empty line counts zero');

/* ------------------------------------------------------------------ audit */

const messy = [
  cue(0, 4000, 'First'),
  cue(3500, 5000, 'Second'),
  cue(6000, 6300, 'Tiny'),
  cue(7000, 7100, ''),
  cue(8000, 9000, 'A line that is far too long to sit on a single line of the screen at once'),
  cue(10000, 9500, 'Backwards')
];
const report = M.audit(messy);
eq(report.counts.overlap, 1, 'the second of two overlapping cues is counted');
eq(report.counts.short, 2, 'the 0.3 second cue and the empty one are short');
eq(report.counts.empty, 1, 'a cue with no text is empty');
eq(report.counts.backwards, 1, 'a cue that ends before it starts is counted');
eq(report.counts.lineLong, 1, 'a line over the limit is counted');
eq(report.counts.tooManyLines, 0, 'one long line is not too many lines');
eq(report.rows.length, 6, 'six cues carry at least one code');
eq(report.rows[1].codes, ['overlap'], 'the code names the problem');
eq(report.counts.fast, 1, 'the long line is also too fast for one second');
eq(report.rows[4].codes, ['fast', 'lineLong'], 'one cue can carry two codes');
eq(report.total, 7, 'the total adds the counts');

const fast = M.audit([cue(0, 1000, 'This cue holds far too many characters for one second of screen time')]);
eq(fast.counts.fast, 1, 'a cue over 21 characters a second is fast');

const stacked = M.audit([cue(0, 5000, 'one\ntwo\nthree')]);
eq(stacked.counts.tooManyLines, 1, 'three lines is one too many');

const cleanReport = M.audit([cue(0, 2000, 'Fine')]);
eq(cleanReport.total, 0, 'a clean cue has no codes');
eq(cleanReport.rows, [], 'and no rows');

/* --------------------------------------------------------------- cleanText */

const dirty = [cue(0, 1000, '  spaced   out  '), cue(1000, 2000, '   '), cue(2000, 3000, 'a\n\nb')];
const cleaned = M.cleanText(dirty);
eq(cleaned.cues.length, 2, 'the empty cue is removed');
eq(cleaned.removed, 1, 'the removed cue is counted');
eq(cleaned.cues[0].text, 'spaced out', 'inner spaces collapse and the edges go');
eq(cleaned.cues[1].text, 'a\nb', 'a blank line inside a cue is dropped');
eq(cleaned.cues.map(function (c) { return c.index; }), [1, 2], 'the cues are renumbered');

const stripped = M.stripTags([cue(0, 1000, '<i>Hi</i> {\\an8}there'), cue(1000, 2000, 'plain')]);
eq(stripped.cues[0].text, 'Hi there', 'tags and ASS blocks are removed');
eq(stripped.changed, 1, 'only the cue that changed is counted');

/* ------------------------------------------------------------------ shift */

const moved = M.shift([cue(1000, 3000, 'a'), cue(3000, 5000, 'b')], 1500);
eq(moved.cues.map(function (c) { return [c.start, c.end]; }),
  [[2500, 4500], [4500, 6500]], 'a positive shift moves every cue later');
eq(moved.clamped, 0, 'nothing had to be clamped');

const back = M.shift([cue(500, 2500, 'a'), cue(4000, 6000, 'b')], -1000);
eq(back.cues[0].start, 0, 'a cue that would go below zero starts at zero');
eq(back.cues[0].end, 2000, 'and keeps its length');
eq(back.cues[1].start, 3000, 'the next cue still moves by the full amount');
eq(back.clamped, 1, 'the clamped cue is counted');
ok(back.cues.every(function (c) { return c.start >= 0 && c.end >= 0; }), 'no time goes negative');

/* ----------------------------------------------------------------- retime */

const sped = M.retime([cue(1000, 3000, 'a')], 2);
eq(sped.cues[0].start, 500, 'twice the speed halves the time');
eq(sped.cues[0].end, 1500, 'both ends move');
eq(sped.factor, 2, 'the factor is echoed back');

const slow = M.retime([cue(1000, 3000, 'a')], 0.5);
eq(slow.cues[0].start, 2000, 'half the speed doubles the time');
eq(slow.factor, 0.5, 'a factor under one is allowed');

const refused = M.retime([cue(1000, 3000, 'a')], 0);
eq(refused.cues[0].start, 1000, 'a zero factor changes nothing');
eq(refused.factor, 1, 'and reports one');

/* ------------------------------------------------------------ fixOverlaps */

const overlap = M.fixOverlaps([cue(0, 4000, 'a'), cue(3500, 5000, 'b')], 800);
eq(overlap.cues[0].end, 3500, 'the earlier cue is cut where the next one starts');
eq(overlap.fixed, 1, 'the repair is counted');
eq(overlap.left, 0, 'nothing is left');
eq(M.audit(overlap.cues).counts.overlap, 0, 'the file is clean afterwards');

const tooShort = M.fixOverlaps([cue(0, 500, 'a'), cue(400, 2000, 'b')], 800);
eq(tooShort.cues[0].end, 500, 'a cue that would fall under the floor is left alone');
eq(tooShort.fixed, 0, 'nothing is counted as fixed');
eq(tooShort.left, 1, 'the leftover is counted');
eq(M.audit(tooShort.cues).counts.overlap, 1, 'and the overlap is still there');

const chain = M.fixOverlaps([cue(0, 3000, 'a'), cue(2000, 4000, 'b'), cue(3500, 6000, 'c')], 500);
eq(chain.cues.map(function (c) { return c.end; }), [2000, 3500, 6000], 'a run of overlaps is cut one by one');
eq(chain.fixed, 2, 'both cuts are counted');

eq(M.fixOverlaps([cue(0, 1000, 'a'), cue(1000, 2000, 'b')], 800).fixed, 0, 'cues that touch are not overlapping');

/* ---------------------------------------------------------------- wrapLine */

eq(M.wrapLine('one two three four', 9), ['one two', 'three', 'four'], 'words are packed up to the limit');
eq(M.wrapLine('abcdefghij', 4), ['abcd', 'efgh', 'ij'], 'a word over the limit is cut');
eq(M.wrapLine('', 10), [], 'an empty line wraps to nothing');

const wrapped = M.rewrap([cue(0, 2000, 'one two three four five six seven eight nine ten eleven')], 20);
ok(wrapped.cues[0].text.split('\n').every(function (line) { return line.length <= 20; }),
  'no wrapped line is over the limit');
eq(wrapped.cues[0].text.split('\n').join(' '),
  'one two three four five six seven eight nine ten eleven', 'no word is lost');
eq(wrapped.changed, 1, 'the changed cue is counted');

const already = M.rewrap([cue(0, 2000, 'short line')], 20);
eq(already.changed, 0, 'a cue that already fits is not touched');

/* --------------------------------------------------------------- splitLong */

const longCue = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen';
const split = M.splitLong([cue(0, 10000, longCue)], 20, 2);
ok(split.cues.length > 1, 'a cue over two lines of twenty is split');
ok(split.cues.every(function (c) { return c.text.length <= 40; }), 'every piece fits the limit');
eq(split.cues.map(function (c) { return c.text; }).join(' '), longCue, 'the words survive the split in order');
eq(split.cues[0].start, 0, 'the first piece starts where the cue started');
eq(split.cues[split.cues.length - 1].end, 10000, 'the last piece ends where the cue ended');
ok(split.cues.every(function (c, at) {
  return c.end > c.start && (at === 0 || c.start === split.cues[at - 1].end);
}), 'the pieces run one after another without a gap or an overlap');
eq(split.parts, split.cues.length - 1, 'the extra pieces are counted');

const notLong = M.splitLong([cue(0, 2000, 'short enough')], 20, 2);
eq(notLong.cues.length, 1, 'a short cue is not split');
eq(notLong.parts, 0, 'and nothing is counted');

const noRoom = M.splitLong([cue(0, 0, longCue)], 20, 2);
eq(noRoom.cues.length, 1, 'a cue with no duration is not split');

/* -------------------------------------------------------------- sortByTime */

const unordered = [cue(5000, 6000, 'c'), cue(1000, 2000, 'a'), cue(3000, 4000, 'b')];
eq(M.sortByTime(unordered, true).map(function (c) { return c.text; }), ['a', 'b', 'c'], 'cues come out in order');
eq(M.sortByTime(unordered, true).map(function (c) { return c.index; }), [1, 2, 3], 'the order is renumbered');

const twins = [cue(1000, 2000, 'first'), cue(1000, 3000, 'second')];
eq(M.sortByTime(twins, true).map(function (c) { return c.text; }), ['first', 'second'], 'cues that start together keep their order');
eq(M.sortByTime(twins, false).map(function (c) { return c.text; }), ['first', 'second'], 'and the ending breaks the tie');

eq(M.totalLength([cue(0, 2000, 'a'), cue(5000, 9000, 'b'), cue(0, 1000, 'c')]), 9000, 'the length is the last end');
eq(M.totalLength([]), 0, 'an empty file has no length');

/* ------------------------------------------------------------------ report */

if (failures.length) {
  console.log('FAIL: ' + failures.length + ' of ' + checks + ' checks');
  failures.forEach(function (message) { console.log('  - ' + message); });
  process.exit(1);
}
console.log('PASS: ' + checks + ' logic checks, stamps, parsing, the audit and every repair');
