'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'scripts', 'disney-plus-subtitles-downloader.user.js'), 'utf8');
let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok ${passed} - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function functionDeclaration(name) {
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0, `${name} not found`);
  const next = source.indexOf('\n    function ', start + 1);
  return source.slice(start, next >= 0 ? next : source.length);
}

function evaluate(code, extras = {}) {
  const context = { ...extras };
  vm.createContext(context);
  vm.runInContext(code, context);
  return context;
}

test('developer mode consumes a fresh one-shot arm from the top-level tab', () => {
  const key = 'ssd:fixture-capture:disney:armed-until';
  const values = new Map([[key, '121000']]);
  const storage = {
    getItem: name => values.has(name) ? values.get(name) : null,
    setItem: (name, value) => values.set(name, value),
    removeItem: name => values.delete(name)
  };
  const topWindow = { sessionStorage: storage };
  topWindow.top = topWindow;
  const code = functionDeclaration('consumeFixtureCaptureArm');
  let context = evaluate(code, {
    window: topWindow,
    FIXTURE_CAPTURE_ARM_KEY: key,
    FIXTURE_CAPTURE_ARM_TTL_MS: 120000,
    Date: { now: () => 1000 },
    isFinite
  });
  assert.strictEqual(context.consumeFixtureCaptureArm(), true);
  assert.strictEqual(values.has(key), false, 'the arm must be deleted as soon as it is consumed');
  assert.strictEqual(context.consumeFixtureCaptureArm(), false, 'the arm must be one-shot');

  values.set(key, '999');
  assert.strictEqual(context.consumeFixtureCaptureArm(), false, 'expired arms must fail closed');
  assert.strictEqual(values.has(key), false, 'expired arms must also be deleted');

  values.set(key, '121000');
  const childWindow = { top: {}, sessionStorage: storage };
  context = evaluate(code, {
    window: childWindow,
    FIXTURE_CAPTURE_ARM_KEY: key,
    FIXTURE_CAPTURE_ARM_TTL_MS: 120000,
    Date: { now: () => 1000 },
    isFinite
  });
  assert.strictEqual(context.consumeFixtureCaptureArm(), false);
  assert.strictEqual(values.has(key), true, 'a child frame must not consume the tab arm');
  assert(!code.includes('location.hash'));
  assert(!source.includes('ssd-fixture'));
  assert(source.includes('var fixtureCapture = fixtureCaptureEnabled ? createFixtureCapture('), 'capture factory must not run without an arm');
});

test('arming records no capture data and reloads only the current top-level tab', () => {
  const values = new Map();
  const storage = { setItem: (name, value) => values.set(name, value) };
  const topWindow = { sessionStorage: storage };
  topWindow.top = topWindow;
  let reloads = 0;
  const context = evaluate(functionDeclaration('armFixtureCaptureAndReload'), {
    window: topWindow,
    location: { reload: () => { reloads++; } },
    FIXTURE_CAPTURE_ARM_KEY: 'fixture-key',
    FIXTURE_CAPTURE_ARM_TTL_MS: 120000,
    Date: { now: () => 1000 },
    debuglog: () => {}
  });
  assert.strictEqual(context.armFixtureCaptureAndReload(), true);
  assert.strictEqual(values.get('fixture-key'), '121000');
  assert.strictEqual(reloads, 1);
  assert.deepStrictEqual([...values.keys()], ['fixture-key']);
});

test('fixture exports derive their version from userscript metadata', () => {
  const code = functionDeclaration('currentUserscriptVersion');
  let context = evaluate(code, { GM_info: { script: { version: '9.8.7' } } });
  assert.strictEqual(context.currentUserscriptVersion(), '9.8.7');

  context = evaluate(code);
  assert.strictEqual(context.currentUserscriptVersion(), 'unknown');
  assert(source.includes('// @grant      GM_info'));
  assert(source.includes('scriptVersion: currentUserscriptVersion()'));
  assert(!/scriptVersion:\s*['"]\d/.test(source), 'fixture capture must not duplicate the userscript version');
});

test('developer commands stay in Tampermonkey and out of the page menu', () => {
  const topWindow = {};
  topWindow.top = topWindow;
  const inactiveLabels = [];
  let inactiveHandler = null;
  let arms = 0;
  let starts = 0;
  let context = evaluate(functionDeclaration('installFixtureCaptureCommands'), {
    window: topWindow,
    fixtureCapture: null,
    GM_registerMenuCommand: (label, handler) => { inactiveLabels.push(label); inactiveHandler = handler; },
    armFixtureCaptureAndReload: () => { arms++; },
    startFixtureCapture: () => { starts++; },
    debuglog: () => {}
  });
  context.installFixtureCaptureCommands();
  assert.strictEqual(starts, 0);
  assert.strictEqual(arms, 0);
  assert.deepStrictEqual(inactiveLabels, ['[Fixture] Start capture and reload this tab']);
  inactiveHandler();
  assert.strictEqual(arms, 1);

  const labels = [];
  starts = 0;
  context = evaluate(functionDeclaration('installFixtureCaptureCommands'), {
    window: topWindow,
    fixtureCapture: {},
    GM_registerMenuCommand: label => labels.push(label),
    startFixtureCapture: () => { starts++; },
    printFixtureCaptureStatus: () => {},
    exportFixtureCapture: () => {}
  });
  context.installFixtureCaptureCommands();
  assert.strictEqual(starts, 1, 'capture should start before normal playback hooks');
  assert.deepStrictEqual(labels, [
    '[Fixture] Start/restart capture',
    '[Fixture] Stop and export',
    '[Fixture] Export snapshot',
    '[Fixture] Clear capture',
    '[Fixture] Print status'
  ]);
  assert(!functionDeclaration('installStyles').includes('[Fixture]'));
  assert(!functionDeclaration('ensureWidget').includes('[Fixture]'));

  const childLabels = [];
  context = evaluate(functionDeclaration('installFixtureCaptureCommands'), {
    window: { top: {} },
    fixtureCapture: null,
    GM_registerMenuCommand: label => childLabels.push(label),
    startFixtureCapture: () => { throw new Error('child frame must stay inactive'); },
    debuglog: () => {}
  });
  context.installFixtureCaptureCommands();
  assert.deepStrictEqual(childLabels, []);
});

test('disabled adapter wrappers do not evaluate lazy payloads', () => {
  let payloadCalls = 0;
  let eventCalls = 0;
  const context = evaluate(functionDeclaration('captureDisney'), {
    fixtureCaptureRecording: false,
    fixtureCapture: {
      event: () => { eventCalls++; return true; }
    }
  });
  const factory = () => { payloadCalls++; return { value: 1 }; };
  assert.strictEqual(context.captureDisney('metadata.observed', 'raw-session', factory), false);
  assert.strictEqual(payloadCalls, 0);
  assert.strictEqual(eventCalls, 0);

  context.fixtureCaptureRecording = true;
  assert.strictEqual(context.captureDisney('metadata.observed', 'raw-session', factory), true);
  assert.strictEqual(payloadCalls, 1);
  assert.strictEqual(eventCalls, 1);
});

test('identical metadata structures reuse one artifact without evaluating later metadata', () => {
  let artifactCalls = 0;
  let metadataCalls = 0;
  const context = evaluate(functionDeclaration('captureDisneyArtifact'), {
    fixtureCaptureRecording: true,
    fixtureMetadataArtifactCache: [],
    fixtureCapture: {
      artifact: () => `ARTIFACT_${++artifactCalls}`
    }
  });
  const first = context.captureDisneyArtifact('metadata-structure', '{"data":"STRING_1"}', () => {
    metadataCalls++;
    return { format: 'json', url: 'https://example.test/first' };
  });
  const duplicate = context.captureDisneyArtifact('metadata-structure', '{"data":"STRING_1"}', () => {
    metadataCalls++;
    return { format: 'json', url: 'https://example.test/duplicate' };
  });
  const different = context.captureDisneyArtifact('metadata-structure', '{"data":"STRING_2"}', () => {
    metadataCalls++;
    return { format: 'json', url: 'https://example.test/different' };
  });
  assert.strictEqual(first, 'ARTIFACT_1');
  assert.strictEqual(duplicate, first);
  assert.strictEqual(different, 'ARTIFACT_2');
  assert.strictEqual(artifactCalls, 2);
  assert.strictEqual(metadataCalls, 2);
  assert.strictEqual(context.fixtureMetadataArtifactCache.length, 2);
});

test('capture helpers add no page DOM, network, storage, observer, or timer path', () => {
  const helperNames = [
    'startFixtureCapture',
    'fixtureObservedState', 'exportFixtureCapture', 'printFixtureCaptureStatus',
    'captureDisney', 'captureDisneyArtifact', 'captureDisneySnapshot',
    'fixtureTrackSummary', 'fixtureMetadataState', 'fixtureMetadataProjection', 'fixtureErrorCode'
  ];
  const helpers = helperNames.map(functionDeclaration).join('\n');
  assert(!/document\.|createElement|GM_xmlhttpRequest|XMLHttpRequest|\bfetch\s*\(|GM_(?:get|set|delete)Value|MutationObserver|setTimeout|setInterval/.test(helpers));
});

test('activation uses only a short-lived session arm and a tab reload', () => {
  const helpers = [
    'consumeFixtureCaptureArm', 'armFixtureCaptureAndReload', 'installFixtureCaptureCommands'
  ].map(functionDeclaration).join('\n');
  assert(helpers.includes('sessionStorage'));
  assert(helpers.includes('location.reload()'));
  assert(!/document\.|createElement|GM_xmlhttpRequest|XMLHttpRequest|\bfetch\s*\(|GM_(?:get|set|delete)Value|MutationObserver|setTimeout|setInterval/.test(helpers));
});

test('metadata artifacts are structure-only projections without profile data', () => {
  const code = [
    'fixtureMetadataProjection', 'seasonEpisodeTag', 'formatSeasonEpisode', 'padNumber'
  ].map(functionDeclaration).join('\n');
  const context = evaluate(code, { fixtureCaptureRecording: true, isFinite });
  const projection = context.fixtureMetadataProjection(JSON.stringify({
    profile: { name: 'PRIVATE_PROFILE', profileId: 987654321 },
    profileName: 'PRIVATE_PROFILE_NAME',
    firstName: 'PRIVATE_FIRST',
    lastName: 'PRIVATE_LAST',
    accountId: 123456789,
    subscriberId: 456789123,
    token: 'PRIVATE_TOKEN',
    email: 'private@example.test',
    description: 'PRIVATE_SYNOPSIS',
    data: {
      program: {
        contentType: 'episode',
        series: { title: 'PRIVATE_SHOW_TITLE' },
        season: { sequenceNumber: 3 },
        episode: { sequenceNumber: 2, label: 'Season 3 Episode 2' }
      }
    }
  }));
  assert(projection);
  assert(!projection.includes('PRIVATE_PROFILE'));
  assert(!projection.includes('PRIVATE_FIRST'));
  assert(!projection.includes('PRIVATE_LAST'));
  assert(!projection.includes('PRIVATE_TOKEN'));
  assert(!projection.includes('private@example.test'));
  assert(!projection.includes('PRIVATE_SYNOPSIS'));
  assert(!projection.includes('PRIVATE_SHOW_TITLE'));
  assert(!projection.includes('987654321'));
  assert(!projection.includes('123456789'));
  assert(!projection.includes('456789123'));
  assert(projection.includes('SHOW_001'));
  assert(projection.includes('S03E02'));
  assert(projection.includes('"contentType": "episode"'));
  assert(projection.includes('"sequenceNumber": 3'));
  assert(projection.includes('"sequenceNumber": 2'));

  const siteConfigOnly = context.fixtureMetadataProjection(JSON.stringify({
    data: {
      getSiteConfig: {
        compliance: { ageBands: { ADULT: { CREATE: { username: { minimumLength: 3 } } } } }
      }
    },
    extensions: { operation: 'PRIVATE_OPERATION_METADATA' }
  }));
  assert.strictEqual(siteConfigOnly, '', 'known non-playback site configuration must not become an artifact');

  const mixedProjection = context.fixtureMetadataProjection(JSON.stringify({
    data: {
      getSiteConfig: { username: { minimumLength: 3 } },
      program: {
        series: { title: 'PRIVATE_SHOW_TITLE' },
        season: { sequenceNumber: 3 },
        episode: { sequenceNumber: 2 }
      }
    }
  }));
  assert(mixedProjection.includes('SHOW_001'));
  assert(!mixedProjection.includes('getSiteConfig'));
  assert(!mixedProjection.includes('username'));

  const trackingProjection = context.fixtureMetadataProjection(JSON.stringify({
    tracking: { conviva: { userid: 'PRIVATE_COMPACT_USER_ID', deviceid: 'PRIVATE_COMPACT_DEVICE_ID' } }
  }));
  assert(trackingProjection.includes('"userid": "TOKEN_001"'));
  assert(trackingProjection.includes('"deviceid": "TOKEN_001"'));
  assert(!trackingProjection.includes('PRIVATE_COMPACT'));
});

test('metadata response handling never sends the raw response to artifact capture', () => {
  const code = [
    'inspectMetadataResponse', 'fixtureMetadataProjection',
    'seasonEpisodeTag', 'formatSeasonEpisode', 'padNumber'
  ].map(functionDeclaration).join('\n');
  let artifactText = '';
  let remembered = false;
  const context = evaluate(code, {
    fixtureCaptureRecording: true,
    isFinite,
    isPlaybackSessionCurrent: () => true,
    shouldInspectMetadataUrl: () => true,
    extractMetadataFromText: () => ({ title: 'SHOW_001', seasonNumber: 3, episodeNumber: 2, structuredResponse: true }),
    captureDisneyArtifact: (kind, text) => { artifactText = text; return 'ARTIFACT_1'; },
    captureDisney: () => true,
    isTrustedDisneyPlaybackMetadataUrl: () => true,
    rememberPlaybackResponseMetadata: () => { remembered = true; return true; },
    updateUi: () => {},
    debuglog: () => {}
  });
  const raw = JSON.stringify({
    profileName: 'PRIVATE_PROFILE',
    accountId: 123456789,
    data: { program: { series: { title: 'PRIVATE_SHOW_TITLE' } } }
  });
  context.inspectMetadataResponse('https://example.test/playerExperience', raw, 'session');
  assert(remembered);
  assert(artifactText);
  assert.notStrictEqual(artifactText, raw);
  assert(!artifactText.includes('PRIVATE_PROFILE'));
  assert(!artifactText.includes('123456789'));
  assert(!artifactText.includes('PRIVATE_SHOW_TITLE'));
});

test('metadata extraction preserves only the playback kind needed for readiness decisions', () => {
  const code = [
    'extractMetadataFromText', 'collectMetadataFromJson',
    'seasonEpisodeTag', 'formatSeasonEpisode', 'padNumber'
  ].map(functionDeclaration).join('\n');
  const context = evaluate(code);
  assert.strictEqual(context.extractMetadataFromText(JSON.stringify({ playbackRights: { contentType: 'episode' } })).mediaKind, 'episode');
  assert.strictEqual(context.extractMetadataFromText(JSON.stringify({ playbackRights: { contentType: 'movie' } })).mediaKind, 'movie');
});

test('unrecognized manifest responses are reported without storing their bodies', () => {
  const manifestLoader = functionDeclaration('queueManifest');
  const trackLoader = functionDeclaration('getTrackVtt');
  assert(manifestLoader.includes("var artifactId = directWebVtt || hlsManifest ? captureDisneyArtifact("));
  assert(trackLoader.includes("var playlistArtifactId = directWebVtt || hlsPlaylist ? captureDisneyArtifact("));
  assert(manifestLoader.includes("'unrecognized-response'"));
  assert(trackLoader.includes("'unrecognized-response'"));
});

test('capture reuses the existing filename calculation result', () => {
  const filename = functionDeclaration('safeBaseFilename');
  assert.strictEqual((filename.match(/refreshMediaMetadataFromDom\(\)/g) || []).length, 1, 'existing metadata refresh call count changed');
  assert(filename.includes("captureDisneySnapshot('filename.resolved'"));
  const helpers = [
    'captureDisney', 'captureDisneyArtifact', 'captureDisneySnapshot',
    'fixtureObservedState', 'fixtureMetadataState'
  ].map(functionDeclaration).join('\n');
  assert(!helpers.includes('safeBaseFilename('), 'capture helpers must not trigger filename calculation');
});

test('metadata readiness prevents stale or incomplete metadata from becoming a filename', () => {
  let refreshed = 0;
  const context = evaluate(functionDeclaration('safeBaseFilename'), {
    state: {
      mediaTitle: '',
      mediaKind: 'unknown',
      episodeTag: '',
      episodeMetadataTitle: ''
    },
    refreshMediaMetadataFromDom: () => { refreshed++; },
    isPlaybackMetadataReady: () => false,
    mediaTitlesMatch: () => true,
    debuglog: () => {},
    captureDisney: () => true,
    captureDisneySnapshot: () => true,
    formatMediaBaseFilename: () => 'STALE_TITLE.S01E04'
  });
  assert.strictEqual(context.safeBaseFilename(), '');
  assert.strictEqual(refreshed, 1, 'the metadata observer must still be refreshed while unresolved');

  const ui = functionDeclaration('updateUi');
  assert(ui.includes('playbackMetadataWaitStatus()'));
  assert(ui.includes('state.wait || !metadataReady || state.langs.length === 0'));
  assert(source.includes('beginPlaybackMetadataSettling();'));
  assert(source.includes('var PLAYBACK_METADATA_SETTLE_MS = 3000;'));
});

test('episode metadata for a different title never falls back to a title-only filename', () => {
  let formatted = false;
  const context = evaluate(functionDeclaration('safeBaseFilename'), {
    state: {
      playbackSessionId: 'session',
      mediaTitle: '현재 프로그램',
      mediaKind: 'episode',
      episodeTag: 'S01E03',
      episodeMetadataTitle: '이전 프로그램'
    },
    refreshMediaMetadataFromDom: () => {},
    isPlaybackMetadataReady: () => true,
    mediaTitlesMatch: () => false,
    debuglog: () => {},
    captureDisney: () => true,
    captureDisneySnapshot: () => true,
    formatMediaBaseFilename: () => { formatted = true; return '현재 프로그램'; }
  });
  assert.strictEqual(context.safeBaseFilename(), '');
  assert.strictEqual(formatted, false);
});

test('trusted playback responses retain episode tags until an active title is available', () => {
  const events = [];
  let resolvedState = null;
  const context = evaluate(functionDeclaration('rememberPlaybackResponseMetadata'), {
    state: {
      playbackSessionId: 'session',
      playbackMetadataResponseSeen: false,
      mediaKind: 'unknown',
      pendingEpisodeTag: '',
      metadataReady: false,
      mediaTitle: '',
      episodeTag: ''
    },
    isPlaybackSessionCurrent: session => session === 'session',
    isTrustedDisneyPlaybackMetadataUrl: () => true,
    episodeTagFromMetadata: metadata => metadata.episodeTag || '',
    isPlaybackMetadataReady: () => false,
    captureDisney: type => { events.push(type); return true; },
    resolvePendingPlaybackMetadata: () => {
      resolvedState = {
        mediaKind: context.state.mediaKind,
        pendingEpisodeTag: context.state.pendingEpisodeTag,
        responseSeen: context.state.playbackMetadataResponseSeen
      };
      return false;
    }
  });
  context.rememberPlaybackResponseMetadata({ episodeTag: 'S01E03' }, 'session', 'https://example.test/playback');
  assert.deepStrictEqual(resolvedState, {
    mediaKind: 'episode', pendingEpisodeTag: 'S01E03', responseSeen: true
  });
  assert(events.includes('metadata.pending'));
});

test('trusted title-only playback responses classify movies but stale sessions do nothing', () => {
  const events = [];
  let resolutionSession = '';
  const context = evaluate(functionDeclaration('rememberPlaybackResponseMetadata'), {
    state: {
      playbackSessionId: 'current',
      playbackMetadataResponseSeen: false,
      mediaKind: 'unknown',
      pendingEpisodeTag: '',
      metadataReady: false,
      mediaTitle: '',
      episodeTag: ''
    },
    isPlaybackSessionCurrent: session => session === 'current',
    isTrustedDisneyPlaybackMetadataUrl: () => true,
    episodeTagFromMetadata: () => '',
    isPlaybackMetadataReady: () => false,
    captureDisney: type => { events.push(type); return true; },
    resolvePendingPlaybackMetadata: (source, session) => { resolutionSession = session; return false; }
  });
  assert.strictEqual(context.rememberPlaybackResponseMetadata({}, 'stale', 'https://example.test/playback'), false);
  assert.strictEqual(context.state.playbackMetadataResponseSeen, false);
  context.rememberPlaybackResponseMetadata({}, 'current', 'https://example.test/playback');
  assert.strictEqual(context.state.mediaKind, 'movie');
  assert.strictEqual(context.state.playbackMetadataResponseSeen, true);
  assert.strictEqual(resolutionSession, 'current');
  assert(events.includes('metadata.classified'));
});

test('explicit episodic playback metadata stays unresolved until its episode tag arrives', () => {
  const context = evaluate(functionDeclaration('rememberPlaybackResponseMetadata'), {
    state: {
      playbackSessionId: 'session',
      playbackMetadataResponseSeen: false,
      mediaKind: 'unknown',
      pendingEpisodeTag: '',
      metadataReady: false,
      mediaTitle: '',
      episodeTag: ''
    },
    isPlaybackSessionCurrent: session => session === 'session',
    isTrustedDisneyPlaybackMetadataUrl: () => true,
    episodeTagFromMetadata: () => '',
    isPlaybackMetadataReady: () => false,
    captureDisney: () => true,
    resolvePendingPlaybackMetadata: () => false
  });
  context.rememberPlaybackResponseMetadata({ mediaKind: 'episode' }, 'session', 'https://example.test/playback');
  assert.strictEqual(context.state.mediaKind, 'episode');
  assert.strictEqual(context.state.pendingEpisodeTag, '');
  assert.strictEqual(context.state.metadataReady, false);
});

test('a new trusted episode response starts a clean session before accepting its tag', () => {
  let restarted = 0;
  let resolvedSession = '';
  let context;
  context = evaluate(functionDeclaration('rememberPlaybackResponseMetadata'), {
    state: {
      playbackSessionId: 'old-session',
      playbackMetadataResponseSeen: true,
      mediaKind: 'episode',
      pendingEpisodeTag: 'S01E04',
      metadataReady: true,
      mediaTitle: '아이언하트',
      episodeTag: 'S01E04'
    },
    isPlaybackSessionCurrent: session => session === context.state.playbackSessionId,
    isTrustedDisneyPlaybackMetadataUrl: () => true,
    episodeTagFromMetadata: metadata => metadata.episodeTag || '',
    isPlaybackMetadataReady: () => true,
    fixtureMetadataState: () => ({}),
    captureDisney: () => true,
    restartPlaybackSessionForMetadataChange: () => {
      restarted++;
      context.state.playbackSessionId = 'new-session';
      context.state.mediaKind = 'unknown';
      context.state.metadataReady = false;
      context.state.pendingEpisodeTag = '';
      context.state.episodeTag = '';
      return 'new-session';
    },
    resolvePendingPlaybackMetadata: (source, session) => { resolvedSession = session; return false; }
  });
  context.rememberPlaybackResponseMetadata({ episodeTag: 'S01E05' }, 'old-session', 'https://example.test/playback');
  assert.strictEqual(restarted, 1);
  assert.strictEqual(context.state.pendingEpisodeTag, 'S01E05');
  assert.strictEqual(context.state.mediaKind, 'episode');
  assert.strictEqual(resolvedSession, 'new-session');
});

test('pending playback metadata combines the current title without a visible title overlay', () => {
  const accepted = [];
  let settling = true;
  let activeTitle = '아이언하트';
  const context = evaluate(functionDeclaration('resolvePendingPlaybackMetadata'), {
    state: {
      playbackSessionId: 'session',
      mediaKind: 'episode',
      pendingEpisodeTag: 'S01E03',
      playbackMetadataResponseSeen: true
    },
    isPlaybackSessionCurrent: session => session === 'session',
    isPlaybackMetadataSettling: () => settling,
    activePlaybackContainer: () => ({ current: true }),
    activePlaybackTitle: () => activeTitle,
    acceptPlaybackMetadata: (metadata, kind, source, session) => {
      accepted.push({ metadata, kind, source, session });
      return true;
    }
  });
  assert.strictEqual(context.resolvePendingPlaybackMetadata('active-player+playback-response', 'session'), false);
  assert.strictEqual(accepted.length, 0, 'stale active-player metadata must stay blocked during navigation settling');
  settling = false;
  assert.strictEqual(context.resolvePendingPlaybackMetadata('active-player+playback-response', 'session'), true);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(accepted[0])), {
    metadata: { title: '아이언하트', episodeTag: 'S01E03' },
    kind: 'episode',
    source: 'active-player+playback-response',
    session: 'session'
  });

  accepted.length = 0;
  context.state.mediaKind = 'movie';
  context.state.pendingEpisodeTag = '';
  activeTitle = '무파사: 라이온 킹';
  assert.strictEqual(context.resolvePendingPlaybackMetadata('active-player+playback-response', 'session'), true);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(accepted[0])), {
    metadata: { title: '무파사: 라이온 킹' },
    kind: 'movie',
    source: 'active-player+playback-response',
    session: 'session'
  });
});

test('only the current Disney playback endpoint can classify title-only playback as a movie', () => {
  const context = evaluate(functionDeclaration('isTrustedDisneyPlaybackMetadataUrl'), {
    normalizeUrl: value => value,
    URL
  });
  assert.strictEqual(context.isTrustedDisneyPlaybackMetadataUrl(
    'https://disney.playback.edge.bamgrid.com/v7/playback/ctr-regular'
  ), true);
  assert.strictEqual(context.isTrustedDisneyPlaybackMetadataUrl(
    'https://disney.api.edge.bamgrid.com/v1/explore/recommendations'
  ), false);
  assert.strictEqual(context.isTrustedDisneyPlaybackMetadataUrl(
    'https://example.test/v7/playback/ctr-regular'
  ), false);
});

test('pilot records session, metadata, manifest, track, filename, and download decisions', () => {
  for (const event of [
    'session.start', 'metadata.observed', 'metadata.accepted', 'metadata.changed',
    'metadata.pending', 'metadata.resolved', 'metadata.unresolved',
    'manifest.parsed', 'track.added', 'filename.resolved', 'download.start',
    'download.complete', 'download.failed'
  ]) {
    assert(source.includes(`'${event}'`), `${event} capture point missing`);
  }
  assert(source.includes('// @grant      GM_registerMenuCommand'));
  assert(/^\/\/ @version\s+\S+$/m.test(source), 'userscript version metadata missing');
});

console.log(`Disney+ fixture capture adapter tests passed: ${passed}`);
