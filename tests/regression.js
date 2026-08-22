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

  test(`${service}: LL-HLS partial segments cover only the unfinished live edge`, () => {
    const block = functionDeclarations(source, [
      'extractHlsSegmentEntries', 'parseAttrList', 'absoluteUrl',
      'parseHlsByteRange', 'isSafeHlsByteInteger', 'resolveHlsByteRange'
    ]);
    const ctx = evaluateFunctions(block, { URL });
    const playlist = [
      '#EXTM3U',
      '#EXT-X-MAP:URI="init.vtt"',
      '#EXT-X-PART:DURATION=0.5,URI="seg1.vtt",BYTERANGE="10@0"',
      '#EXT-X-PART:DURATION=0.5,URI="seg1.vtt",BYTERANGE="12"',
      '#EXTINF:1.0,',
      'seg1.vtt',
      '#EXT-X-PART:DURATION=0.5,URI="seg2.vtt",BYTERANGE="8@0"',
      '#EXT-X-PART:DURATION=0.5,URI="seg2.vtt",BYTERANGE="9"',
      '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="seg2.vtt",BYTERANGE-START=17'
    ].join('\n');
    const entries = ctx.extractHlsSegmentEntries(playlist, 'https://example.test/subs/live.m3u8');
    assert.strictEqual(entries.length, 3, 'completed parent must replace its PARTs while live-edge PARTs remain');
    assert.strictEqual(entries[0].url, 'https://example.test/subs/seg1.vtt');
    assert.strictEqual(entries[0].partial, undefined, 'completed parent must not be marked partial');
    assert.strictEqual(entries[1].partial, true);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(entries[1].byterange)), { offset: 0, length: 8 });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(entries[2].byterange)), { offset: 8, length: 9 });
    assert(entries.every(entry => entry.map && entry.map.url === 'https://example.test/subs/init.vtt'), 'map must apply to parent and PART entries');
    assert(!entries.some(entry => /PRELOAD/.test(entry.url)), 'preload hints must not be fetched');

    const gapPlaylist = [
      '#EXTM3U',
      '#EXT-X-PART:DURATION=0.5,URI="seg3.vtt",BYTERANGE="5@0",GAP=YES',
      '#EXT-X-PART:DURATION=0.5,URI="seg3.vtt",BYTERANGE="7"'
    ].join('\n');
    const gapEntries = ctx.extractHlsSegmentEntries(gapPlaylist, 'https://example.test/subs/live.m3u8');
    assert.strictEqual(gapEntries.length, 1, 'GAP part must not be fetched');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(gapEntries[0].byterange)), { offset: 5, length: 7 }, 'GAP range must still advance implicit offset');

    const invalidImplicit = [
      '#EXTM3U',
      '#EXT-X-PART:DURATION=0.5,URI="seg4.vtt",BYTERANGE="5@0"',
      '#EXTINF:0.5,',
      'seg4.vtt',
      '#EXT-X-PART:DURATION=0.5,URI="seg5.vtt",BYTERANGE="7"'
    ].join('\n');
    assert.throws(() => ctx.extractHlsSegmentEntries(invalidImplicit, 'https://example.test/subs/live.m3u8'), /Implicit EXT-X-BYTERANGE offset/);
    assert.throws(() => ctx.extractHlsSegmentEntries('#EXTM3U\n#EXT-X-PART:URI="missing-duration.vtt"', 'https://example.test/live.m3u8'), /duration/);
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

test('coupang: playback session timing helper remains callable', () => {
  const block = functionDeclaration(sources.coupang, 'performanceNow');
  const ctx = evaluateFunctions(block, {
    targetWindow: { performance: { now: () => 123.5 } },
    window: {}
  });
  assert.strictEqual(ctx.performanceNow(), 123.5);
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

test('apple: network title is not downgraded by generic DOM metadata', () => {
  const source = sources.apple;
  const block = [
    'var state = { mediaTitle: "", mediaTitlePriority: 0, seasonNumber: null, episodeNumber: null, episodeTag: "" };',
    functionDeclarations(source, [
      'isGenericMediaTitle', 'shouldReplaceMediaTitle', 'updateMediaMetadata',
      'cleanDisplayTitle', 'formatSeasonEpisode', 'padNumber'
    ])
  ].join('\n');
  const ctx = evaluateFunctions(block);
  ctx.updateMediaMetadata({ title: 'Severance' }, 3);
  ctx.updateMediaMetadata({ title: '\u200eApple TV' }, 1);
  assert.strictEqual(ctx.state.mediaTitle, 'Severance');
  assert.strictEqual(ctx.state.mediaTitlePriority, 3);
  ctx.updateMediaMetadata({ title: 'Apple TV' }, 4);
  assert.strictEqual(ctx.state.mediaTitle, 'Severance', 'generic titles must not replace a precise title at any priority');
  assert.strictEqual(ctx.state.mediaTitlePriority, 3);
});

test('apple: active playback title overrides stale homepage metadata', () => {
  const source = sources.apple;
  const playback = {
    label: 'F1 더 무비',
    titleNode: null,
    innerText: 'F1 더 무비 정보 계속 보기',
    textContent: 'F1 더 무비 정보 계속 보기',
    getAttribute(name) { return name === 'aria-label' ? this.label : ''; },
    querySelector(selector) {
      return selector === '[data-testid="player-metadata-title"]' ? this.titleNode : null;
    },
    querySelectorAll() { return []; }
  };
  const document = {
    title: '\u200eApple TV',
    body: { innerText: 'Ted Lasso 시즌 1 에피소드 1' },
    querySelector(selector) {
      if (selector === 'dialog[data-testid="playback-view"][open]') return playback;
      return null;
    },
    querySelectorAll() { return []; }
  };
  const block = [
    'var state = { mediaTitle: "Ted Lasso", mediaTitlePriority: 3, seasonNumber: 1, episodeNumber: 1, episodeTag: "S01E01" };',
    functionDeclarations(source, [
      'activePlaybackContainer', 'activePlaybackTitle', 'activePlaybackInfoText',
      'normalizedMediaTitleForComparison', 'mediaTitlesMatch',
      'isGenericMediaTitle', 'shouldReplaceMediaTitle', 'updateMediaMetadata',
      'refreshMediaMetadataFromDom', 'safeBaseFilename', 'displayTitle',
      'cleanDisplayTitle', 'seasonEpisodeTag', 'playbackInfoText', 'metaContent',
      'formatSeasonEpisode', 'padNumber', 'sanitizeFilename'
    ])
  ].join('\n');
  const ctx = evaluateFunctions(block, { document });
  assert.strictEqual(ctx.safeBaseFilename(), 'F1 더 무비');
  assert.strictEqual(ctx.state.mediaTitle, 'F1 더 무비');
  assert.strictEqual(ctx.state.mediaTitlePriority, 4);

  playback.label = '파일럿';
  playback.titleNode = { textContent: "'테드 래소' - Ted Lasso" };
  playback.innerText = "시즌 1, 에피소드 1 · 파일럿\n'테드 래소' - Ted Lasso\n정보\n계속 보기";
  playback.textContent = playback.innerText;
  ctx.state.mediaTitle = '파일럿';
  ctx.state.mediaTitlePriority = 3;
  ctx.state.seasonNumber = null;
  ctx.state.episodeNumber = null;
  ctx.state.episodeTag = '';
  assert.strictEqual(ctx.safeBaseFilename(), "'테드 래소' - Ted Lasso.S01E01");
  assert.strictEqual(ctx.state.mediaTitle, "'테드 래소' - Ted Lasso", 'player metadata title must outrank the episode aria-label');
  assert.strictEqual(ctx.state.episodeTag, 'S01E01', 'localized player metadata should supply season and episode numbers');
});

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

test('netflix: menu lifecycle does not depend on metadata readiness', () => {
  const source = sources.netflix;
  requireText(source, '// @run-at     document-start', 'early Netflix hook installation');
  requireText(source, 'const ensureMenu = () =>', 'standalone menu initializer');
  requireText(source, 'const menu = ensureMenu();', 'metadata-independent menu creation');
  requireText(source, "document.addEventListener('DOMContentLoaded', initializeDom, {once: true});", 'DOM-ready menu creation');
  requireText(source, 'injectPageHooks();', 'early page hook injection');
  const start = source.indexOf('const processMetadata = data =>');
  const end = source.indexOf('\nconst getVideoId =', start);
  assert(start >= 0 && end > start, 'processMetadata block missing');
  assert(!source.slice(start, end).includes("menu.style.display = 'none'"), 'metadata processing must not hide the menu');
});

test('netflix: active player DOM title fills a missing metadata cache entry', () => {
  const listeners = {};
  const parent = {
    appendChild(node) { node.isConnected = true; node.parentNode = this; },
    removeChild(node) { node.isConnected = false; node.parentNode = null; }
  };
  const titleNode = { textContent: ' 설국열차 ' };
  const player = {
    querySelector(selector) {
      return selector === '[data-uia="evidence-overlay"] h2' ? titleNode : null;
    }
  };
  const document = {
    body: null,
    head: null,
    documentElement: parent,
    location: { pathname: '/watch/70270364', href: 'https://www.netflix.com/watch/70270364' },
    createElement(tag) {
      return { tagName: String(tag).toUpperCase(), textContent: '', innerHTML: '', isConnected: false, style: {} };
    },
    addEventListener(type, handler) { listeners[type] = handler; },
    querySelector(selector) {
      return selector === '[data-uia="watch-video"]' ? player : null;
    }
  };
  const context = {
    console: { log() {}, warn() {}, debug() {}, error() {} },
    document,
    location: document.location,
    localStorage: { getItem() { return null; }, setItem() {} },
    sessionStorage: { getItem() { return null; }, setItem() {} },
    MutationObserver: function () { this.observe = function () {}; },
    setTimeout() {},
    clearTimeout() {},
    CustomEvent: function () {},
    Blob: function () {},
    FileReader: function () {},
    JSZip: function () {},
    saveAs() {},
    caches: {},
    alert() { throw new Error('title fallback should avoid the alert'); },
    URL,
    addEventListener() {},
    dispatchEvent() {}
  };
  context.window = context;
  context.unsafeWindow = context;
  vm.createContext(context);
  vm.runInContext(sources.netflix, context);
  const title = vm.runInContext('getTitleEntry()', context);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(title)), { type: 'movie', title: '설국열차' });
});

test('netflix: show filenames always include season and episode without duplicate labels', () => {
  const titleNode = { textContent: '이 사랑 통역 되나요?' };
  const seasonNode = { textContent: '리미티드 시리즈' };
  const episodeNode = { textContent: '5화: 5화' };
  const overlay = {
    querySelector(selector) {
      if(selector === 'h2') return titleNode;
      if(selector === '[data-uia="evidence-overlay-season-title"]') return seasonNode;
      if(selector === '[data-uia="evidence-overlay-episode-title"]') return episodeNode;
      return null;
    }
  };
  const player = {
    querySelector(selector) {
      return selector === '[data-uia="evidence-overlay"]' ? overlay : null;
    }
  };
  const document = {
    querySelector(selector) {
      return selector === '[data-uia="watch-video"]' ? player : null;
    }
  };
  const start = sources.netflix.indexOf('const getVideoId =');
  const end = sources.netflix.indexOf('\nconst isUsableFormatCandidate =', start);
  assert(start >= 0 && end > start, 'Netflix title helpers missing');
  const block = [
    'const titleCache = {}; const idOverrides = {}; let epTitleInFilename = true;',
    sources.netflix.slice(start, end),
    'titleCache["81697779"] = {type: "show", title: "이 사랑 통역 되나요?", season: 1, episode: 5, subtitle: "5화: 5화", hiddenNumber: true};',
    'this.limitedSeriesFilename = getTitleFromCache()[0];',
    'titleCache["81697779"] = {type: "show", title: "EBS 다큐프라임 - 주식의 시대", season: 1, episode: 1, subtitle: "1화: 1부. 우리는 왜 투자에 실패하는가", hiddenNumber: true};',
    'this.documentaryFilename = getTitleFromCache()[0];',
    'delete titleCache["81697779"];',
    'this.domFallbackFilename = getTitleFromCache()[0];'
  ].join('\n');
  const ctx = evaluateFunctions(block, {
    document,
    window: { location: { pathname: '/watch/81697779' } },
    unsafeWindow: {},
    alert() { throw new Error('DOM metadata fallback should avoid the alert'); }
  });
  assert.strictEqual(ctx.limitedSeriesFilename, '이.사랑.통역.되나요.S01E05');
  assert.strictEqual(ctx.documentaryFilename, 'EBS.다큐프라임.-.주식의.시대.S01E01.1부.우리는.왜.투자에.실패하는가');
  assert.strictEqual(ctx.domFallbackFilename, '이.사랑.통역.되나요.S01E05');
});

test('netflix: document-start initialization tolerates a missing body', () => {
  const listeners = {};
  const parent = {
    appendChild(node) { node.isConnected = true; node.parentNode = this; },
    removeChild(node) { node.isConnected = false; node.parentNode = null; }
  };
  const document = {
    body: null,
    head: null,
    documentElement: parent,
    location: { pathname: '/watch/123', href: 'https://www.netflix.com/watch/123' },
    createElement(tag) {
      return { tagName: String(tag).toUpperCase(), textContent: '', innerHTML: '', isConnected: false, style: {} };
    },
    addEventListener(type, handler) { listeners[type] = handler; },
    querySelector() { return null; }
  };
  const context = {
    console: { log() {}, warn() {}, debug() {}, error() {} },
    document,
    location: document.location,
    localStorage: { getItem() { return null; }, setItem() {} },
    sessionStorage: { getItem() { return null; }, setItem() {} },
    MutationObserver: function () { this.observe = function () {}; },
    setTimeout() {},
    clearTimeout() {},
    CustomEvent: function () {},
    Blob: function () {},
    FileReader: function () {},
    JSZip: function () {},
    saveAs() {},
    caches: {},
    alert() {},
    URL,
    addEventListener() {},
    dispatchEvent() {}
  };
  context.window = context;
  context.unsafeWindow = context;
  vm.runInNewContext(sources.netflix, context);
  assert.strictEqual(typeof listeners.DOMContentLoaded, 'function');
});

console.log(`# ${passed} regression groups passed`);
