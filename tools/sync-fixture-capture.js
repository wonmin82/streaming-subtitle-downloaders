'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TEMPLATE_PATH = path.join(ROOT, 'shared', 'fixture-capture.template.js');
const START_MARKER = '    // BEGIN SHARED FIXTURE CAPTURE CORE';
const END_MARKER = '    // END SHARED FIXTURE CAPTURE CORE';
const TARGETS = [
  'scripts/disney-plus-subtitles-downloader.user.js'
];

const args = new Set(process.argv.slice(2));
const check = args.has('--check');
const write = args.has('--write');
if (check === write || args.size !== 1) {
  console.error('Usage: node tools/sync-fixture-capture.js --check|--write');
  process.exit(2);
}

function normalizeLf(value) {
  return String(value).replace(/\r\n?/g, '\n');
}

const template = normalizeLf(fs.readFileSync(TEMPLATE_PATH, 'utf8')).replace(/\n+$/, '');
if (!/^    function createFixtureCapture\(options\) \{/m.test(template)) {
  throw new Error('Shared fixture capture template must define createFixtureCapture(options).');
}
if (template.includes(START_MARKER) || template.includes(END_MARKER)) {
  throw new Error('Shared fixture capture template must not contain its userscript insertion markers.');
}

function countOccurrences(source, needle) {
  return source.split(needle).length - 1;
}

function generatedBounds(source, file) {
  const startCount = countOccurrences(source, START_MARKER);
  const endCount = countOccurrences(source, END_MARKER);
  if (startCount !== 1 || endCount !== 1) {
    throw new Error(
      `${file}: expected exactly one fixture capture marker pair. Add these lines at the intended top-level userscript insertion point:\n` +
      `${START_MARKER}\n${END_MARKER}`
    );
  }
  const start = source.indexOf(START_MARKER);
  const end = source.indexOf(END_MARKER);
  if (end <= start) throw new Error(`${file}: fixture capture end marker must follow its start marker.`);
  const contentStart = start + START_MARKER.length;
  return { start: contentStart, end };
}

function firstDifferenceLine(actual, expected) {
  const actualLines = actual.split('\n');
  const expectedLines = expected.split('\n');
  const count = Math.max(actualLines.length, expectedLines.length);
  for (let index = 0; index < count; index++) {
    if (actualLines[index] !== expectedLines[index]) return index + 1;
  }
  return 0;
}

let changed = 0;
for (const file of TARGETS) {
  const filePath = path.join(ROOT, file);
  const original = fs.readFileSync(filePath, 'utf8');
  const usesCrLf = /\r\n/.test(original);
  const source = normalizeLf(original);
  const bounds = generatedBounds(source, file);
  const actual = source.slice(bounds.start, bounds.end);
  const expected = `\n${template}\n`;

  if (actual === expected) continue;
  changed++;
  if (check) {
    const line = firstDifferenceLine(actual, expected);
    console.error(`${file}: shared fixture capture core is out of sync${line ? ` at generated line ${line}` : ''}`);
    continue;
  }

  let updated = source.slice(0, bounds.start) + expected + source.slice(bounds.end);
  if (usesCrLf) updated = updated.replace(/\n/g, '\r\n');
  fs.writeFileSync(filePath, updated);
  console.log(`updated ${file}`);
}

if (check && changed) process.exit(1);
if (check) console.log(`shared fixture capture core is synchronized across ${TARGETS.length} userscript`);
if (write && !changed) console.log('shared fixture capture core already synchronized');
