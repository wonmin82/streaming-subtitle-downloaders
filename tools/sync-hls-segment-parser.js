'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TEMPLATE_PATH = path.join(ROOT, 'shared', 'hls-segment-parser.template.js');
const PLACEHOLDER = '__HLS_SUBTITLE_EXTENSIONS__';
const SHARED_FUNCTIONS = [
  'extractSegmentUrls',
  'extractHlsSegmentEntries',
  'parseHlsByteRange',
  'isSafeHlsByteInteger',
  'resolveHlsByteRange'
];
const TARGETS = [
  {
    file: 'scripts/apple-tv-plus-subtitles-downloader.user.js',
    subtitleExtensions: 'vtt|webvtt'
  },
  {
    file: 'scripts/disney-plus-subtitles-downloader.user.js',
    subtitleExtensions: 'vtt|webvtt'
  },
  {
    file: 'scripts/coupang-play-subtitles-downloader.user.js',
    subtitleExtensions: 'vtt|webvtt|ttml|dfxp|srt'
  }
];

const args = new Set(process.argv.slice(2));
const check = args.has('--check');
const write = args.has('--write');
if (check === write || args.size !== 1) {
  console.error('Usage: node tools/sync-hls-segment-parser.js --check|--write');
  process.exit(2);
}

function normalizeLf(text) {
  return String(text).replace(/\r\n?|\u2028|\u2029/g, '\n');
}

const template = normalizeLf(fs.readFileSync(TEMPLATE_PATH, 'utf8'));
const placeholderCount = template.split(PLACEHOLDER).length - 1;
if (placeholderCount !== 1) {
  throw new Error(`Expected exactly one ${PLACEHOLDER} placeholder, found ${placeholderCount}`);
}

function topLevelFunctionNames(block) {
  return Array.from(block.matchAll(/^    function ([A-Za-z_$][\w$]*)\(/gm), match => match[1]);
}

function assertSharedFunctionShape(block, file) {
  const actual = topLevelFunctionNames(block);
  if (actual.length !== SHARED_FUNCTIONS.length || actual.some((name, index) => name !== SHARED_FUNCTIONS[index])) {
    throw new Error(`${file}: refusing to replace unexpected HLS parser function sequence: ${actual.join(', ')}`);
  }
}

assertSharedFunctionShape(template, 'shared HLS parser template');

function blockBounds(source, file) {
  const startMarker = '    function extractSegmentUrls(';
  const resolveMarker = '    function resolveHlsByteRange(';
  const start = source.indexOf(startMarker);
  if (start < 0 || source.indexOf(startMarker, start + 1) >= 0) {
    throw new Error(`${file}: expected exactly one extractSegmentUrls function`);
  }

  const resolveStart = source.indexOf(resolveMarker, start);
  if (resolveStart < 0 || source.indexOf(resolveMarker, resolveStart + 1) >= 0) {
    throw new Error(`${file}: expected exactly one resolveHlsByteRange function after extractSegmentUrls`);
  }

  const end = source.indexOf('\n    function ', resolveStart + resolveMarker.length);
  if (end < 0) throw new Error(`${file}: could not find the function following resolveHlsByteRange`);
  assertSharedFunctionShape(source.slice(start, end), file);
  return { start, end };
}

function firstDifferenceLine(actual, expected) {
  const actualLines = actual.split('\n');
  const expectedLines = expected.split('\n');
  const count = Math.max(actualLines.length, expectedLines.length);
  for (let i = 0; i < count; i++) {
    if (actualLines[i] !== expectedLines[i]) return i + 1;
  }
  return 0;
}

let changed = 0;
for (const target of TARGETS) {
  const filePath = path.join(ROOT, target.file);
  const source = normalizeLf(fs.readFileSync(filePath, 'utf8'));
  const bounds = blockBounds(source, target.file);
  const actual = source.slice(bounds.start, bounds.end);
  const expected = template.replace(PLACEHOLDER, target.subtitleExtensions);

  if (actual === expected) continue;
  changed++;
  if (check) {
    const line = firstDifferenceLine(actual, expected);
    console.error(`${target.file}: shared HLS parser is out of sync${line ? ` at generated line ${line}` : ''}`);
    continue;
  }

  const updated = source.slice(0, bounds.start) + expected + source.slice(bounds.end);
  fs.writeFileSync(filePath, updated);
  console.log(`updated ${target.file}`);
}

if (check && changed) process.exit(1);
if (check) console.log(`shared HLS parser is synchronized across ${TARGETS.length} userscripts`);
if (write && !changed) console.log('shared HLS parser already synchronized');
