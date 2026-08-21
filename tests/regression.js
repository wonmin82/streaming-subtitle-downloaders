'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT_PATHS = {
  apple: 'scripts/apple-tv-plus-subtitles-downloader.user.js',
  disney: 'scripts/disney-plus-subtitles-downloader.user.js',
  coupang: 'scripts/coupang-play-subtitles-downloader.user.js',
  netflix: 'scripts/netflix-subtitles-downloader.user.js'
};
const sources = Object.fromEntries(Object.entries(SCRIPT_PATHS).map(([key, rel]) => [key, fs.readFileSync(path.join(ROOT, rel), 'utf8')]));

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok ${passed} - ${name}`);
  } catch (err) {
    console.error(`not ok - ${name}`);
    throw err;
  }
}

function requireText(source, text, label) {
  assert(source.includes(text), `${label || text} missing`);
}

function functionDeclaration(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0, `${name} not found`);
  const next = source.indexOf('\n    function ', start + 1);
  return source.slice(start, next >= 0 ? next : source.length);
}

function functionDeclarations(source, names) {
  return names.map(name => functionDeclaration(source, name)).join('\n');
}

function evaluateFunctions(code, extras = {}) {
  const context = { console, ...extras };
  vm.createContext(context);
  vm.runInContext(code, context);
  return context;
}

for (const [service, source] of Object.entries(sources)) {
  test(`${service}: userscript metadata remains intact`, () => {
    requireText(source, '// ==UserScript==', 'userscript header');
    requireText(source, '// @version', 'version metadata');
    requireText(source, '// @downloadURL', 'download URL metadata');
    requireText(source, '// @updateURL', 'update URL metadata');
  });
}

for (const service of ['apple', 'disney', 'coupang']) {
  const source = sources[service];
  test(`${service}: HLS byte-range semantics`, () => {
    const block = functionDeclarations(source, ['parseHlsByteRange', 'isSafeHlsByteInteger', 'resolveHlsByteRange']);
    const ctx = evaluateFunctions(block);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.parseHlsByteRange('100@20', false))), { length: 100, offset: 20 });
    assert.strictEqual(ctx.parseHlsByteRange('100', true), null, 'EXT-X-MAP must require explicit offset');
    const first = ctx.resolveHlsByteRange(ctx.parseHlsByteRange('10@5', false), 'https://x/sub.vtt', null);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(first)), { offset: 5, length: 10 });
    const second = ctx.resolveHlsByteRange(ctx.parseHlsByteRange('7', false), 'https://x/sub.vtt', { url: 'https://x/sub.vtt', byterange: first });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(second)), { offset: 15, length: 7 });
    assert.throws(() => ctx.resolveHlsByteRange(ctx.parseHlsByteRange('7', false), 'https://x/other.vtt', { url: 'https://x/sub.vtt', byterange: first }), /same URI/);
    assert.strictEqual(ctx.parseHlsByteRange('9007199254740992@0', false), null);
  });

  test(`${service}: WebVTT HLS metadata path remains present`, () => {
    requireText(source, 'X-TIMESTAMP-MAP', 'timestamp-map handling');
    assert(/STYLE/.test(source), 'STYLE metadata handling missing');
    assert(/REGION/.test(source), 'REGION metadata handling missing');
    requireText(source, 'parseHlsTimestampMap', 'timestamp-map parser');
  });

  test(`${service}: retry policy remains bounded and status-aware`, () => {
    requireText(source, 'RETRY_BASE_DELAY_MS', 'retry base delay');
    requireText(source, 'RETRY_MAX_DELAY_MS', 'retry max delay');
    assert(/408/.test(source) && /429/.test(source), 'retryable HTTP status handling missing');
  });
}

test('coupang: DASH Number/Time template token semantics', () => {
  const source = sources.coupang;
  const block = functionDeclarations(source, ['dashReplaceNumericToken', 'dashFormatTemplate', 'dashTemplateHasAddressingToken']);
  const ctx = evaluateFunctions(block);
  assert.strictEqual(ctx.dashTemplateHasAddressingToken('sub-$Number$.vtt'), true);
  assert.strictEqual(ctx.dashTemplateHasAddressingToken('sub-$Time%05d$.vtt'), true);
  assert.strictEqual(ctx.dashTemplateHasAddressingToken('literal-$$Number$$.vtt'), false, 'escaped token must not count as addressing');
  assert.strictEqual(ctx.dashFormatTemplate('sub-$Number%04d$-$Time$.vtt', 'r', '100', 7, 25), 'sub-0007-25.vtt');
  assert.strictEqual(ctx.dashFormatTemplate('literal-$$Number$$-$Number$.vtt', 'r', '100', 3, 0), 'literal-$Number$-3.vtt');
  assert.strictEqual(ctx.dashFormatTemplate('sub-$Unknown$.vtt', 'r', '100', 3, 0), '');
});

test('coupang: TTML fidelity features stay wired together', () => {
  const source = sources.coupang;
  for (const fn of [
    'ttmlParagraphCueIntervals', 'ttmlResolveTiming', 'ttmlComputedPresentationStyleAtTime',
    'ttmlRegionPresentationStyleAtTime', 'ttmlPositionOrigin', 'ttmlLengthToPercentage',
    'ttmlWebVttVertical', 'ttmlVttDocument'
  ]) requireText(source, `function ${fn}(`, fn);
  requireText(source, "'fontSize', 'textCombine', 'textOrientation'", 'TTML presentation properties');
  requireText(source, 'text-combine-upright: all', 'TTML text-combine WebVTT style');
  requireText(source, 'ttmlCueSettings(node, doc, timingContext, sampleTime, styleMap)', 'interval-aware layout settings');
  requireText(source, 'MAX_TTML_CUE_BOUNDARIES', 'TTML boundary cap');
});

test('coupang: TTML malformed inputs retain fail-closed guards', () => {
  const source = sources.coupang;
  requireText(source, 'ttmlHasParserError', 'XML parser error check');
  requireText(source, "if (!context) return '';", 'invalid timing context guard');
  requireText(source, 'if (boundaries.length > MAX_TTML_CUE_BOUNDARIES) return [];', 'boundary overflow guard');
});

for (const service of ['apple', 'coupang']) {
  const source = sources[service];
  test(`${service}: cross-frame session hardening remains present`, () => {
    requireText(source, 'MAX_SESSION_CLIENTS = 32', 'session-client cap');
    requireText(source, 'isDescendantFrameSource', 'descendant-frame check');
    requireText(source, 'playbackSessionId', 'session identity');
    assert(/sessionId/.test(source) && /event\.origin/.test(source), 'session/origin validation missing');
  });
}

test('netflix: modern subtitle format fallbacks remain available', () => {
  const source = sources.netflix;
  requireText(source, "const DFXP = 'dfxp-ls-sdh';", 'DFXP format');
  requireText(source, "const IMSC1_1 = 'imsc1.1';", 'IMSC 1.1 format');
  requireText(source, 'track.ttDownloadables || track.downloadables || {}', 'downloadables compatibility');
  requireText(source, 'downloadables.downloadUrls', 'legacy downloadable URL shape');
  requireText(source, 'downloadables.urls', 'new downloadable URL shape');
  requireText(source, 'SUB_CACHE_WAIT_TIMEOUT_MS', 'bounded cache wait');
});

test('netflix: preferred-format fallback includes WebVTT, IMSC, DFXP and simple XML', () => {
  const source = sources.netflix;
  requireText(source, 'ALL_FORMATS = [IMSC1_1, DFXP, WEBVTT, SIMPLE]', 'all subtitle formats');
  requireText(source, 'ALL_FORMATS_prefer_vtt = [WEBVTT, IMSC1_1, DFXP, SIMPLE]', 'WebVTT preference order');
  requireText(source, 'const pickFormat = formats =>', 'format selector');
});

test('netflix: download fallback skips unusable candidates and failed mirrors', () => {
  const source = sources.netflix;
  requireText(source, "const DOWNLOAD_TIMEOUT = 'NETFLIX_SUBTITLE_DOWNLOADER_DOWNLOAD_TIMEOUT';", 'distinct download timeout');
  requireText(source, 'const isUsableFormatCandidate = candidate =>', 'usable format guard');
  requireText(source, 'isUsableFormatCandidate(formats[format])', 'format fallback guard');
  requireText(source, 'result.ok !== true', 'HTTP status validation');
  requireText(source, 'subtitle fetch failed, trying another URL', 'network mirror fallback');
  requireText(source, 'subtitle fetch timed out, trying another URL', 'timeout mirror fallback');
  requireText(source, 'subtitle response could not be read, trying another URL', 'body-read mirror fallback');
});

console.log(`# ${passed} regression groups passed`);
