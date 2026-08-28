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
  const context = {
    console,
    captureAppleSnapshot: () => false,
    fixtureMetadataState: () => ({}),
    ...extras
  };
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

  test(`${service}: runtime dependency versions stay aligned`, () => {
    assert.deepStrictEqual(source.match(/^\/\/ @require\s+\S+$/gm), [
      '// @require    https://cdn.jsdelivr.net/npm/jszip@3.7.1/dist/jszip.min.js',
      '// @require    https://cdn.jsdelivr.net/npm/file-saver@2.0.5/dist/FileSaver.min.js'
    ]);
  });

  test(`${service}: output filename and download progress remain visible in the menu`, () => {
    requireText(source, 'Output file:', 'output filename menu row');
    requireText(source, 'Progress:', 'download progress menu row');
    assert(/createElement\(['"]progress['"]\)|<progress\b/.test(source), 'native progress element missing');
    assert(/progressCompleted|downloadUiState/.test(source), 'progress state missing');
  });
}

for (const service of ['apple', 'disney', 'coupang']) {
  const source = sources[service];
  test(`${service}: filename preview omits language and extension suffixes`, () => {
    const preview = functionDeclaration(source, 'previewSelectedFilename');
    const ctx = evaluateFunctions(preview, { safeBaseFilename: () => 'Show.Title.S01E02' });
    assert.strictEqual(ctx.previewSelectedFilename('ko'), 'Show.Title.S01E02');
    assert(!preview.includes('safeTrackName'), 'preview must not include a language suffix');
    assert(!/\.vtt|\.zip/.test(preview), 'preview must not include an extension');
    requireText(source, 'state.outputFilename = operation.baseFilename;', 'active-download base filename display');
  });

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
    'function restartPlaybackSessionForMetadataChange() { state.mediaTitle = ""; state.mediaTitlePriority = 0; state.seasonNumber = null; state.episodeNumber = null; state.episodeTag = ""; }',
    functionDeclarations(source, [
      'activePlaybackContainer', 'activePlaybackTitle', 'activePlaybackInfoText',
      'normalizedMediaTitleForComparison', 'mediaTitlesMatch', 'playbackMetadataChanged',
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

test('apple: related-content metadata cannot replace the active episode', () => {
  const source = sources.apple;
  const urlContext = evaluateFunctions(functionDeclaration(source, 'shouldInspectMetadataUrl'), {
    normalizeUrl: value => value
  });
  assert.strictEqual(urlContext.shouldInspectMetadataUrl('https://tv.apple.com/api/uts/v3/shelves/player-tabs/PlayerTabUpNext'), false);
  assert.strictEqual(urlContext.shouldInspectMetadataUrl('https://tv.apple.com/api/uts/v3/canvases/channels/example'), false);
  assert.strictEqual(urlContext.shouldInspectMetadataUrl('https://tv.apple.com/api/uts/v3/shows/show-id'), false, 'show aggregate metadata must stay excluded');
  assert.strictEqual(urlContext.shouldInspectMetadataUrl('https://tv.apple.com/api/uts/v3/shows/show-id/episodes?limit=20'), false, 'episode-list metadata must stay excluded');
  assert.strictEqual(urlContext.shouldInspectMetadataUrl('https://tv.apple.com/api/uts/v3/episodes/episode-id?caller=web'), true, 'the active episode endpoint must remain eligible');
  assert.strictEqual(urlContext.shouldInspectMetadataUrl('https://tv.apple.com/api/uts/v3/contents/play-metadata/vod'), true);

  const conflictContext = evaluateFunctions(functionDeclaration(source, 'metadataConflictsWithActivePlayback'), {
    activePlaybackInfoText: () => 'Season 1 Episode 1',
    activePlaybackTitle: () => 'Show Title',
    seasonEpisodeTag: () => 'S01E01',
    formatSeasonEpisode: (season, episode) => `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`,
    mediaTitlesMatch: (left, right) => left === right
  });
  assert.strictEqual(conflictContext.metadataConflictsWithActivePlayback({
    title: 'Show Title', seasonNumber: 1, episodeNumber: 2
  }), true, 'Up Next metadata must not replace the active episode');
  assert.strictEqual(conflictContext.metadataConflictsWithActivePlayback({
    title: 'Show Title', seasonNumber: 1, episodeNumber: 1
  }), false, 'metadata for the active episode should remain eligible');
  requireText(functionDeclaration(source, 'inspectMetadataResponse'), 'metadataConflictsWithActivePlayback(metadata)', 'active playback metadata guard');
});

for (const service of ['apple', 'disney']) {
  test(`${service}: playback metadata changes start a clean UI session`, () => {
    const source = sources[service];
    const changed = functionDeclaration(source, 'playbackMetadataChanged');
    const ctx = evaluateFunctions(changed, {
      state: { mediaTitle: 'Show Title', episodeTag: 'S01E01' },
      mediaTitlesMatch(left, right) { return left === right; }
    });
    assert.strictEqual(ctx.playbackMetadataChanged('Show Title', 'S01E01'), false);
    assert.strictEqual(ctx.playbackMetadataChanged('Show Title', 'S01E02'), true, 'episode transition must start a new session');
    assert.strictEqual(ctx.playbackMetadataChanged('Other Title', 'S01E01'), true, 'title transition must start a new session');

    const restart = functionDeclaration(source, 'restartPlaybackSessionForMetadataChange');
    requireText(restart, 'beginPlaybackSession(3000);', 'bounded transition lookback');
    requireText(restart, 'resetSubtitleTracks();', 'track and progress reset');
    requireText(restart, 'resetMediaMetadata();', 'metadata reset');
    const resetTracks = functionDeclaration(source, 'resetSubtitleTracks');
    requireText(resetTracks, 'state.progressCompleted = 0;', 'completed progress reset');
    requireText(resetTracks, 'state.progressTotal = 0;', 'total progress reset');
    requireText(resetTracks, "state.progressLabel = 'Idle';", 'progress label reset');
  });
}

test('disney: active player metadata is scoped and Korean episode labels are parsed', () => {
  const source = sources.disney;
  requireText(source, "var playbackKey = playbackPage ? location.href.split('#')[0] : '';", 'full playback URL session key');
  requireText(source, '[data-testid="disney-web-player-wrapper"]', 'current Disney player wrapper');
  requireText(source, "'video[aria-label]'", 'player video title fallback');
  const refresh = functionDeclaration(source, 'refreshMediaMetadataFromDom');
  requireText(refresh, 'activePlaybackContainer()', 'active playback container');
  requireText(refresh, 'activePlaybackInfoText(container)', 'scoped playback text');
  requireText(refresh, "!container ? playbackInfoText() : ''", 'whole-page fallback guard');

  const parser = functionDeclarations(source, ['seasonEpisodeTag', 'formatSeasonEpisode', 'padNumber']);
  const ctx = evaluateFunctions(parser, { playbackInfoText() { return ''; } });
  assert.strictEqual(ctx.seasonEpisodeTag('시즌 3: 2회, 챕터 18: 만달로어 광산'), 'S03E02');
});

test('disney: current episode metadata comes from the title overlay Shadow DOM', () => {
  const source = sources.disney;
  const observed = [];
  const titleRoot = { innerText: '만달로리안\n시즌 3: 2회 챕터 18: 만달로어 광산' };
  const titleBug = { shadowRoot: titleRoot };
  const controlsRoot = {
    querySelector(selector) {
      assert.strictEqual(selector, 'title-bug');
      return titleBug;
    }
  };
  const document = {
    querySelector(selector) {
      assert.strictEqual(selector, 'main-app-controls-overlay');
      return { shadowRoot: controlsRoot };
    }
  };
  function FakeMutationObserver(callback) {
    this.callback = callback;
    this.disconnect = () => {};
    this.observe = (target, options) => observed.push({ target, options });
  }
  const block = functionDeclarations(source, [
    'disconnectShadowObserver', 'shadowMutationObserver', 'scheduleShadowMetadataRefresh',
    'firstShadowPlaybackTitle', 'shadowPlaybackMetadata', 'connectShadowTitleObserver',
    'observeShadowPlaybackMetadata', 'seasonEpisodeTag', 'formatSeasonEpisode', 'padNumber'
  ]);
  const ctx = evaluateFunctions(block, {
    state: {
      playbackSessionId: 'current', shadowControlsRoot: null, shadowControlsObserver: null,
      shadowTitleRoot: null, shadowTitleObserver: null, shadowMetadataUiTimer: null
    },
    targetWindow: { MutationObserver: FakeMutationObserver },
    window: {},
    document,
    activePlaybackContainer() { return {}; },
    activePlaybackTitle() { return '만달로리안'; },
    displayTitle() { return 'DisneyPlus'; },
    playbackInfoText() { return ''; },
    cleanDisplayTitle(value) { return String(value || '').trim() || 'DisneyPlus'; }
  });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.observeShadowPlaybackMetadata())), {
    title: '만달로리안',
    episodeTag: 'S03E02'
  });
  assert.strictEqual(observed.length, 2, 'controls and title ShadowRoots must both be observed');
  assert.strictEqual(observed[0].target, controlsRoot);
  assert.strictEqual(observed[1].target, titleRoot);
  assert.strictEqual(observed[1].options.characterData, true, 'title text mutations must be observed');

  const observer = functionDeclaration(source, 'observeShadowPlaybackMetadata');
  requireText(observer, "document.querySelector('main-app-controls-overlay')", 'current controls overlay');
  const connector = functionDeclaration(source, 'connectShadowTitleObserver');
  requireText(connector, "querySelector('title-bug')", 'current title overlay');
  assert(!observer.includes('pivot-tray'), 'next-episode tray must not supply current metadata');
  assert(!connector.includes('pivot-tray'), 'next-episode tray must not be observed');
  requireText(functionDeclaration(source, 'resetShadowMetadataObservers'), 'state.shadowTitleRoot = null;', 'playback-change metadata reset');
  requireText(functionDeclaration(source, 'refreshMediaMetadataFromDom'), 'observeShadowPlaybackMetadata()', 'Shadow DOM metadata refresh');
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
  requireText(source, 'return [title, seriesTitle, stop];', 'episode and batch archive titles');
  requireText(source, 'const [title] = await _download(_zip);', 'single-episode archive title');
  requireText(source, '[, title, stop] = await _download(zip);', 'batch archive series title');
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
  requireText(source, 'DOM_MOVIE_STABILITY_MS = 1500', 'movie metadata stability window');
  requireText(source, "Couldn't find the episode number", 'incomplete show metadata guard');
});

test('netflix: filename preview cannot create an unbounded DOM observer loop', () => {
  const source = sources.netflix;
  requireText(source, 'const PLAYBACK_METADATA_SYNC_DELAY_MS = 250;', 'bounded metadata refresh interval');
  requireText(source, 'const isDownloaderMenuMutation = (mutation, menu) =>', 'downloader menu mutation filter');
  requireText(source, 'if(!isWatchPage())\n    return null;', 'non-playback metadata guard');
  requireText(source, 'if(filenameNode && filenameNode.textContent !== filenameText)', 'idempotent filename update');
  requireText(source, 'if(progressText && progressText.textContent !== progressLabel)', 'idempotent progress update');

  const observerStart = source.indexOf('const observer = new MutationObserver');
  const observerEnd = source.indexOf('\nlet observerStarted', observerStart);
  assert(observerStart >= 0 && observerEnd > observerStart, 'Netflix DOM observer block missing');
  const observer = source.slice(observerStart, observerEnd);
  requireText(observer, 'schedulePlaybackMetadataSync(menu);', 'throttled metadata refresh');
  requireText(observer, 'mutations.filter(mutation => !isDownloaderMenuMutation(mutation, menu))', 'menu mutation exclusion');
  assert(!observer.includes('syncPlaybackMetadataState(menu);'), 'DOM observer must not synchronously rescan metadata');
});

test('netflix: filename preview follows playback and omits the archive extension', () => {
  const source = sources.netflix;
  const previewStart = source.indexOf('const predictedOutputFilename = () =>');
  const previewEnd = source.indexOf('\nconst applyDownloadUi =', previewStart);
  assert(previewStart >= 0 && previewEnd > previewStart, 'Netflix filename preview block missing');
  const preview = source.slice(previewStart, previewEnd);
  assert(!preview.includes("+ '.zip'"), 'Netflix preview must not include the ZIP extension');
  assert(!source.includes('keepResultFilename'), 'completed downloads must not pin a stale preview filename');
  requireText(source, 'const playbackMetadataChanged = (cached, dom, cachedIsDomDerived) =>', 'playback-change detector');
});

test('netflix: playback changes reset completed progress', () => {
  const source = sources.netflix;
  const start = source.indexOf('const playbackUiMetadataChanged =');
  const end = source.indexOf('\nconst syncPlaybackMetadataState =', start);
  assert(start >= 0 && end > start, 'Netflix playback UI reset helpers missing');
  const block = [
    'const normalizedPlaybackTitle = value => String(value || "").toLowerCase();',
    'const positiveInteger = value => { const number = parseInt(value, 10); return number > 0 ? number : null; };',
    'const downloadUiState = {active: false, filename: "Old.Title", completed: 7, total: 7, label: "Complete"};',
    source.slice(start, end),
    'this.episodeChanged = playbackUiMetadataChanged({type: "show", title: "Show", season: 1, episode: 1}, {type: "show", title: "Show", season: 1, episode: 2});',
    'resetDownloadUiForPlaybackChange();',
    'this.resetState = downloadUiState;'
  ].join('\n');
  const ctx = evaluateFunctions(block);
  assert.strictEqual(ctx.episodeChanged, true);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.resetState)), {
    active: false,
    filename: '',
    completed: 0,
    total: 0,
    label: 'Idle'
  });
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
  const modernHeading = { textContent: '이 사랑 통역 되나요?' };
  const modernTitleContainer = {
    textContent: '이 사랑 통역 되나요?5화5화',
    querySelector(selector) {
      return selector === 'h1, h2, h3, h4, h5, h6' ? modernHeading : null;
    }
  };
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
      if(selector === '[data-uia="evidence-overlay"]' && document.overlayVisible) return overlay;
      if(selector === '[data-uia="video-title"]' && document.modernVisible) return modernTitleContainer;
      return null;
    }
  };
  const document = {
    overlayVisible: true,
    modernVisible: false,
    titleNode,
    seasonNode,
    episodeNode,
    querySelector(selector) {
      return selector === '[data-uia="watch-video"]' ? player : null;
    }
  };
  const start = sources.netflix.indexOf('const getVideoId =');
  const end = sources.netflix.indexOf('\nconst isUsableFormatCandidate =', start);
  assert(start >= 0 && end > start, 'Netflix title helpers missing');
  const block = [
    'const titleCache = {}; const idOverrides = {}; const domDerivedTitleIds = {}; const downloadUiState = {active: false, filename: "", completed: 0, total: 0, label: "Idle"}; let lastPlaybackUiMetadata = null; let epTitleInFilename = true; const isWatchPage = () => true;',
    sources.netflix.slice(start, end),
    'titleCache["81697779"] = {type: "show", title: "이 사랑 통역 되나요?", season: 1, episode: 5, subtitle: "5화: 5화", hiddenNumber: true};',
    'this.limitedSeriesFilename = getTitleFromCache()[0];',
    'titleCache["81697779"] = {type: "show", title: "EBS 다큐프라임 - 주식의 시대", season: 1, episode: 1, subtitle: "1화: 1부. 우리는 왜 투자에 실패하는가", hiddenNumber: true};',
    'this.documentaryFilename = getTitleFromCache()[0];',
    'delete titleCache["81697779"];',
    'this.domFallbackFilename = getTitleFromCache()[0];',
    'document.titleNode.textContent = "EBS 다큐프라임 - 주식의 시대";',
    'document.seasonNode.textContent = "EBS 다큐프라임 - 주식의 시대";',
    'document.episodeNode.textContent = "1부 우리는 왜 투자에 실패하는가: 1화";',
    'delete titleCache["81697779"];',
    'const menu = {classList: {series: false, add(value) { if(value === "series") this.series = true; }, remove(value) { if(value === "series") this.series = false; }}};',
    'this.syncedDomTitle = syncPlaybackMetadataState(menu);',
    'this.syncedMenuIsSeries = menu.classList.series;',
    'document.overlayVisible = false;',
    'this.persistedDomFilename = getTitleFromCache()[0];',
    'epTitleInFilename = false;',
    'this.defaultDomFilename = getTitleFromCache()[0];',
    'epTitleInFilename = true;',
    'document.modernVisible = true;',
    'delete titleCache["81697779"];',
    'this.modernLimitedFilename = getTitleFromCache()[0];',
    'modernHeading.textContent = "EBS 다큐프라임 - 주식의 시대";',
    'modernTitleContainer.textContent = "EBS 다큐프라임 - 주식의 시대1화1부 우리는 왜 투자에 실패하는가";',
    'delete titleCache["81697779"];',
    'this.modernDocumentaryFilename = getTitleFromCache()[0];',
    'document.modernVisible = false;',
    'document.overlayVisible = true;',
    'document.titleNode.textContent = "이 사랑 통역 되나요?";',
    'document.seasonNode.textContent = "리미티드 시리즈";',
    'document.episodeNode.textContent = "6화: 마지막 화";',
    'titleCache["81697779"] = {type: "show", title: "이 사랑 통역 되나요?", season: 1, episode: 5, subtitle: "5화: 5화"};',
    'this.nextEpisodeFilename = getTitleFromCache()[0];',
    'document.titleNode.textContent = "F1 더 무비";',
    'document.seasonNode.textContent = "";',
    'document.episodeNode.textContent = "";',
    'titleCache["81697779"] = {type: "movie", title: "테드 래소"};',
    'this.nextMovieFilename = getTitleFromCache()[0];'
  ].join('\n');
  const ctx = evaluateFunctions(block, {
    document,
    modernHeading,
    modernTitleContainer,
    window: { location: { pathname: '/watch/81697779' } },
    unsafeWindow: {},
    alert() { throw new Error('DOM metadata fallback should avoid the alert'); }
  });
  assert.strictEqual(ctx.limitedSeriesFilename, '이.사랑.통역.되나요.S01E05');
  assert.strictEqual(ctx.documentaryFilename, 'EBS.다큐프라임.-.주식의.시대.S01E01.1부.우리는.왜.투자에.실패하는가');
  assert.strictEqual(ctx.domFallbackFilename, '이.사랑.통역.되나요.S01E05');
  assert.strictEqual(ctx.syncedDomTitle.episode, 1);
  assert.strictEqual(ctx.syncedDomTitle.subtitle, '1부 우리는 왜 투자에 실패하는가');
  assert.strictEqual(ctx.syncedMenuIsSeries, true);
  assert.strictEqual(ctx.persistedDomFilename, 'EBS.다큐프라임.-.주식의.시대.S01E01.1부.우리는.왜.투자에.실패하는가');
  assert.strictEqual(ctx.defaultDomFilename, 'EBS.다큐프라임.-.주식의.시대.S01E01');
  assert.strictEqual(ctx.modernLimitedFilename, '이.사랑.통역.되나요.S01E05');
  assert.strictEqual(ctx.modernDocumentaryFilename, 'EBS.다큐프라임.-.주식의.시대.S01E01.1부.우리는.왜.투자에.실패하는가');
  assert.strictEqual(ctx.nextEpisodeFilename, '이.사랑.통역.되나요.S01E06.마지막.화');
  assert.strictEqual(ctx.nextMovieFilename, 'F1.더.무비');
});

test('coupang: async metadata resolves before the operation filename is frozen', () => {
  const source = sources.coupang;
  const begin = functionDeclaration(source, 'beginDownloadOperation');
  const build = functionDeclaration(source, 'buildSubtitleFile');
  assert(!begin.includes('safeBaseFilename()'), 'click-time filename capture reintroduces the metadata race');
  requireText(source, 'function ensureOperationBaseFilename(operation)', 'operation metadata barrier');
  requireText(build, 'ensureOperationBaseFilename(operation)', 'download metadata barrier usage');
  requireText(source, 'state.outputFilename = operation.baseFilename;', 'resolved base filename update');
  requireText(functionDeclaration(source, 'ensureMediaMetadata'), "state.metadataFailedKey = '';", 'explicit-download metadata retry');
});

test('disney: current playback metadata is scoped and incomplete episode filenames stay blocked', () => {
  const source = sources.disney;
  const ctx = evaluateFunctions(functionDeclarations(source, [
    'cleanDisplayTitle', 'normalizedMediaTitleForComparison', 'mediaTitlesMatch'
  ]));
  assert.strictEqual(ctx.cleanDisplayTitle('무파사: 라이온 킹 | 디즈니+'), '무파사: 라이온 킹');
  assert.strictEqual(ctx.mediaTitlesMatch('무파사: 라이온 킹', '무파사 라이온 킹'), true);
  assert.strictEqual(ctx.mediaTitlesMatch('무파사: 라이온 킹', '다른 시리즈'), false);
  requireText(source, 'if (hasEpisodeMetadata && !metadata.title)', 'unscoped episode metadata guard');
  requireText(source, 'rememberPlaybackResponseMetadata(metadata, sessionId, url)', 'trusted playback response metadata retention');
  requireText(source, "captureDisney('metadata.pending'", 'pending episode metadata capture');
  requireText(functionDeclaration(source, 'safeBaseFilename'), 'if (!isPlaybackMetadataReady()) return', 'incomplete filename guard');
  requireText(functionDeclaration(source, 'updateUi'), 'state.wait || !metadataReady', 'metadata-ready download gate');
  requireText(source, 'upnext|explore|recommend', 'related-content metadata exclusion');
  requireText(source, '!mediaTitlesMatch(title, state.episodeMetadataTitle)', 'cross-title episode metadata guard');
  const getTrack = functionDeclaration(source, 'getTrackVtt');
  requireText(getTrack, 'return runSequential(segments', 'sequential Disney segment download');
  assert(!getTrack.includes('Promise.all(segments.map'), 'Disney segments must not be parallelized');
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
