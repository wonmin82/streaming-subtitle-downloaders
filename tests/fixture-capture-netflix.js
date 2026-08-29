'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'scripts', 'netflix-subtitles-downloader.user.js'), 'utf8');
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
  const next = source.indexOf('\nfunction ', start + 1);
  const nextConst = source.indexOf('\nconst ', start + 1);
  const candidates = [next, nextConst].filter(index => index >= 0);
  const end = candidates.length ? Math.min(...candidates) : source.length;
  return source.slice(start, end);
}

function sharedCaptureCoreDeclaration() {
  const start = source.indexOf('    function createFixtureCapture(');
  const end = source.indexOf('\n    // END SHARED FIXTURE CAPTURE CORE', start);
  assert(start >= 0 && end > start, 'shared fixture capture core not found');
  return source.slice(start, end);
}

function evaluate(code, extras = {}) {
  const context = {...extras};
  vm.createContext(context);
  vm.runInContext(code, context);
  return context;
}

test('developer mode consumes a fresh one-shot Netflix tab arm', () => {
  const key = 'ssd:fixture-capture:netflix:armed-until';
  const values = new Map([[key, '121000']]);
  const storage = {
    getItem: name => values.has(name) ? values.get(name) : null,
    removeItem: name => values.delete(name)
  };
  const topWindow = {sessionStorage: storage};
  topWindow.top = topWindow;
  let context = evaluate(functionDeclaration('consumeFixtureCaptureArm'), {
    window: topWindow,
    FIXTURE_CAPTURE_ARM_KEY: key,
    FIXTURE_CAPTURE_ARM_TTL_MS: 120000,
    Date: {now: () => 1000},
    Number
  });
  assert.strictEqual(context.consumeFixtureCaptureArm(), true);
  assert.strictEqual(values.has(key), false);
  assert.strictEqual(context.consumeFixtureCaptureArm(), false);

  values.set(key, '121000');
  context = evaluate(functionDeclaration('consumeFixtureCaptureArm'), {
    window: {top: {}, sessionStorage: storage},
    FIXTURE_CAPTURE_ARM_KEY: key,
    FIXTURE_CAPTURE_ARM_TTL_MS: 120000,
    Date: {now: () => 1000},
    Number
  });
  assert.strictEqual(context.consumeFixtureCaptureArm(), false);
  assert.strictEqual(values.has(key), true);
  assert(source.includes("service: 'netflix'"));
});

test('arming reloads only the current top-level tab', () => {
  const values = new Map();
  const topWindow = {sessionStorage: {setItem: (name, value) => values.set(name, value)}};
  topWindow.top = topWindow;
  let reloads = 0;
  const context = evaluate(functionDeclaration('armFixtureCaptureAndReload'), {
    window: topWindow,
    location: {reload: () => { reloads++; }},
    FIXTURE_CAPTURE_ARM_KEY: 'fixture-key',
    FIXTURE_CAPTURE_ARM_TTL_MS: 120000,
    Date: {now: () => 1000}
  });
  assert.strictEqual(context.armFixtureCaptureAndReload(), true);
  assert.strictEqual(values.get('fixture-key'), '121000');
  assert.strictEqual(reloads, 1);
});

test('fixture exports derive their version from userscript metadata', () => {
  let context = evaluate(functionDeclaration('currentUserscriptVersion'), {
    GM_info: {script: {version: '9.8.7'}}
  });
  assert.strictEqual(context.currentUserscriptVersion(), '9.8.7');
  context = evaluate(functionDeclaration('currentUserscriptVersion'));
  assert.strictEqual(context.currentUserscriptVersion(), 'unknown');
  assert(source.includes('// @grant      GM_info'));
  assert(source.includes('// @grant      GM_registerMenuCommand'));
  assert(source.includes('// @grant      GM_unregisterMenuCommand'));
  assert(source.includes('scriptVersion: currentUserscriptVersion()'));
  assert(!/scriptVersion:\s*['"]\d/.test(source));
});

test('developer commands stay in Tampermonkey and out of the Netflix page menu', () => {
  const topWindow = {};
  topWindow.top = topWindow;
  const commands = new Map();
  let sequence = 0;
  const context = evaluate(functionDeclaration('installFixtureCaptureCommands'), {
    window: topWindow,
    fixtureCapture: {},
    fixtureCaptureRecording: true,
    fixtureCaptureMenuCommandIds: [],
    GM_registerMenuCommand: (label, handler) => {
      const id = ++sequence;
      commands.set(id, {label, handler});
      return id;
    },
    GM_unregisterMenuCommand: id => commands.delete(id),
    startFixtureCapture: () => true,
    printFixtureCaptureStatus: () => {},
    exportFixtureCapture: () => {},
    armFixtureCaptureAndReload: () => true
  });
  context.installFixtureCaptureCommands(true);
  assert.deepStrictEqual([...commands.values()].map(command => command.label), [
    '[Fixture] Start/restart capture',
    '[Fixture] Stop and export',
    '[Fixture] Export snapshot',
    '[Fixture] Clear capture',
    '[Fixture] Print status'
  ]);
  const menuStart = source.indexOf('const DOWNLOAD_MENU =');
  const menuEnd = source.indexOf('const SCRIPT_CSS =', menuStart);
  assert(!source.slice(menuStart, menuEnd).includes('[Fixture]'));
});

test('stop and export restores the single start-and-reload command', () => {
  const topWindow = {};
  topWindow.top = topWindow;
  const commands = new Map();
  let sequence = 0;
  const code = [
    functionDeclaration('installFixtureCaptureCommands'),
    functionDeclaration('exportFixtureCapture'),
    functionDeclaration('fixtureSafeCaptureValue'),
    functionDeclaration('fixtureCriticalString')
  ].join('\n');
  const context = evaluate(code, {
    window: topWindow,
    fixtureCaptureRecording: true,
    fixtureCaptureMenuCommandIds: [],
    fixtureCapture: {
      stop: () => {},
      exportBlob: () => null,
      status: () => ({state: 'stopped'})
    },
    fixtureObservedState: () => ({}),
    GM_registerMenuCommand: (label, handler) => {
      const id = ++sequence;
      commands.set(id, {label, handler});
      return id;
    },
    GM_unregisterMenuCommand: id => commands.delete(id),
    startFixtureCapture: () => true,
    armFixtureCaptureAndReload: () => true,
    printFixtureCaptureStatus: () => {},
    saveAs: () => {},
    console: {info() {}}
  });
  context.installFixtureCaptureCommands(true);
  const stop = [...commands.values()].find(command => command.label === '[Fixture] Stop and export');
  assert(stop);
  stop.handler();
  assert.strictEqual(context.fixtureCaptureRecording, false);
  assert.deepStrictEqual([...commands.values()].map(command => command.label), [
    '[Fixture] Start capture and reload this tab'
  ]);
});

test('disabled adapter wrappers never evaluate lazy payloads', () => {
  let payloadCalls = 0;
  let eventCalls = 0;
  const code = [
    functionDeclaration('captureNetflix'),
    functionDeclaration('fixtureSafeCaptureValue'),
    functionDeclaration('fixtureCriticalString')
  ].join('\n');
  const context = evaluate(code, {
    fixtureCaptureRecording: false,
    fixtureCapture: {event: () => { eventCalls++; return true; }},
    syncFixturePlaybackSession: () => 'SESSION_1'
  });
  assert.strictEqual(context.captureNetflix('metadata.accepted', () => {
    payloadCalls++;
    return {value: 1};
  }), false);
  assert.strictEqual(payloadCalls, 0);
  assert.strictEqual(eventCalls, 0);
});

test('capture helpers add no page, request, persistent storage, observer, or timer path', () => {
  const helperNames = [
    'startFixtureCapture', 'fixtureObservedState', 'exportFixtureCapture', 'printFixtureCaptureStatus',
    'captureNetflix', 'captureNetflixSnapshot', 'captureNetflixArtifact', 'fixtureSafeCaptureValue',
    'fixtureCriticalString', 'fixtureArtifactHasCriticalRisk', 'fixtureConfigurationState',
    'fixtureTitleSummary', 'fixtureTrackCatalogSummary', 'fixtureMetadataProjection',
    'fixtureSubtitleCatalogProjection', 'fixtureSubtitleArtifactFormat', 'fixtureErrorCode',
    'beginFixtureDownload', 'finishFixtureDownload'
  ];
  const helpers = helperNames.map(functionDeclaration).join('\n');
  assert(!/document\.|createElement|XMLHttpRequest|\bfetch\s*\(|MutationObserver|setTimeout|setInterval|GM_(?:get|set|delete)Value/.test(helpers));
});

test('activation uses only a short-lived session arm and tab reload', () => {
  const helpers = [
    'consumeFixtureCaptureArm', 'armFixtureCaptureAndReload', 'installFixtureCaptureCommands'
  ].map(functionDeclaration).join('\n');
  assert(helpers.includes('sessionStorage'));
  assert(helpers.includes('location.reload()'));
  assert(!/document\.|createElement|XMLHttpRequest|\bfetch\s*\(|MutationObserver|setTimeout|setInterval|GM_(?:get|set|delete)Value/.test(helpers));
});

test('metadata projection keeps parser signals and removes private values', () => {
  const context = evaluate([
    functionDeclaration('fixtureMetadataProjection'),
    functionDeclaration('positiveFixtureNumber')
  ].join('\n'), {
    fixtureCaptureRecording: true,
    Map
  });
  const projection = JSON.parse(context.fixtureMetadataProjection({
    profile: {email: 'private@example.test'},
    video: {
      type: 'show', title: 'PRIVATE_SHOW', id: 100, currentEpisode: 102,
      synopsis: 'PRIVATE_SYNOPSIS',
      seasons: [{seq: 1, episodes: [
        {seq: 1, id: 101, title: 'PRIVATE_EPISODE_1', hiddenEpisodeNumbers: false},
        {seq: 2, id: 102, title: 'PRIVATE_EPISODE_2', hiddenEpisodeNumbers: true}
      ]}]
    }
  }));
  assert.strictEqual(projection.video.title, 'SHOW_001');
  assert.strictEqual(projection.video.type, 'show');
  assert.strictEqual(projection.video.seasons[0].seq, 1);
  assert.strictEqual(projection.video.seasons[0].episodes[1].seq, 2);
  assert.strictEqual(projection.video.seasons[0].episodes[1].hiddenEpisodeNumbers, true);
  const text = JSON.stringify(projection);
  assert(!text.includes('PRIVATE_SHOW'));
  assert(!text.includes('PRIVATE_EPISODE'));
  assert(!text.includes('PRIVATE_SYNOPSIS'));
  assert(!text.includes('private@example.test'));
  assert.strictEqual(projection.video.currentEpisode, projection.video.seasons[0].episodes[1].id);
});

test('subtitle catalog projection preserves selection structure without signed URLs', () => {
  const context = evaluate(functionDeclaration('fixtureSubtitleCatalogProjection'), {
    fixtureCaptureRecording: true,
    ALL_FORMATS: ['imsc1.1', 'dfxp-ls-sdh', 'webvtt-lssdh-ios8', 'simplesdh']
  });
  const projection = JSON.parse(context.fixtureSubtitleCatalogProjection({
    movieId: 123,
    timedtexttracks: [{
      language: 'ko', rawTrackType: 'closedcaptions', trackVariant: 'sdh', isForcedNarrative: false,
      ttDownloadables: {
        'webvtt-lssdh-ios8': {downloadUrls: {one: 'https://cdn.test/sub.vtt?token=PRIVATE'}},
        'imsc1.1': {urls: [{url: 'https://cdn.test/sub.xml?sig=PRIVATE'}]}
      }
    }]
  }));
  const text = JSON.stringify(projection);
  assert.strictEqual(projection.movieId, 'TOKEN_1');
  assert.strictEqual(projection.timedtexttracks[0].language, 'ko');
  assert.strictEqual(projection.timedtexttracks[0].rawTrackType, 'closedcaptions');
  assert(text.includes('URL_001'));
  assert(text.includes('URL_002'));
  assert(!text.includes('cdn.test'));
  assert(!text.includes('PRIVATE'));
});

test('projected metadata and subtitle structures export through the real shared core', () => {
  const code = [
    sharedCaptureCoreDeclaration(),
    functionDeclaration('fixtureMetadataProjection'),
    functionDeclaration('fixtureSubtitleCatalogProjection'),
    functionDeclaration('positiveFixtureNumber')
  ].join('\n');
  const context = evaluate(code, {
    URL,
    Blob,
    Map,
    fixtureCaptureRecording: true,
    ALL_FORMATS: ['imsc1.1', 'dfxp-ls-sdh', 'webvtt-lssdh-ios8', 'simplesdh']
  });
  const capture = context.createFixtureCapture({
    service: 'netflix', scriptVersion: 'test',
    page: {host: 'www.netflix.com', path: '/watch/TOKEN_1'}, Blob
  });
  assert.strictEqual(capture.start({reason: 'test'}), true);
  const metadata = context.fixtureMetadataProjection({video: {
    type: 'movie', title: 'PRIVATE_TITLE', id: 123, seasons: []
  }});
  const catalog = context.fixtureSubtitleCatalogProjection({movieId: 123, timedtexttracks: [{
    language: 'en', rawTrackType: 'subtitles',
    ttDownloadables: {'webvtt-lssdh-ios8': {downloadUrls: {one: 'https://signed.test/private'}}}
  }]});
  assert(capture.artifact('metadata-structure', metadata, {format: 'json'}));
  assert(capture.artifact('track-catalog', catalog, {format: 'json'}));
  capture.stop({status: 'complete'});
  assert(capture.exportObject());
  assert.strictEqual(capture.status().exportBlocked, false);
});

test('downloaded WebVTT and XML artifacts keep structure but not dialogue', () => {
  const context = evaluate(sharedCaptureCoreDeclaration(), {URL, Blob});
  const capture = context.createFixtureCapture({
    service: 'netflix', scriptVersion: 'test',
    page: {host: 'www.netflix.com', path: '/watch/TOKEN_1'}, Blob
  });
  capture.start({reason: 'test'});
  const vtt = capture.artifact('subtitle', 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nPRIVATE_DIALOGUE', {format: 'vtt'});
  const xml = capture.artifact('subtitle', '<tt><body><p begin="00:00:01.000" end="00:00:02.000">PRIVATE_XML</p></body></tt>', {format: 'xml'});
  assert(vtt);
  assert(xml);
  capture.stop({status: 'complete'});
  const exported = capture.exportObject();
  assert(exported);
  const text = JSON.stringify(exported);
  assert(!text.includes('PRIVATE_DIALOGUE'));
  assert(!text.includes('PRIVATE_XML'));
  assert(text.includes('CAPTION_'));
});

test('playback session changes never export the raw Netflix video id', () => {
  const events = [];
  const code = [
    functionDeclaration('fixtureCurrentVideoKey'),
    functionDeclaration('syncFixturePlaybackSession')
  ].join('\n');
  const location = {pathname: '/watch/123456789'};
  const context = evaluate(code, {
    location,
    fixtureCaptureRecording: true,
    fixtureCapture: {event: (type, data, options) => events.push({type, data, options})},
    fixtureVideoKey: '', fixtureSessionId: '', fixtureSessionSequence: 0,
    fixtureLastMetadata: null, fixtureLastTrackCatalog: [], fixtureLastFilename: '',
    fixtureSnapshotValues: {}
  });
  context.syncFixturePlaybackSession('test');
  location.pathname = '/watch/987654321';
  context.syncFixturePlaybackSession('navigation');
  const text = JSON.stringify(events);
  assert(!text.includes('123456789'));
  assert(!text.includes('987654321'));
  assert(events.some(event => event.type === 'session.invalidated'));
  assert.strictEqual(events.filter(event => event.type === 'session.started').length, 2);
});

test('Netflix page injection remains unaware of fixture capture state', () => {
  const start = source.indexOf('const injection =');
  const end = source.indexOf("window.addEventListener('netflix_sub_downloader_data'", start);
  assert(start >= 0 && end > start);
  const injection = source.slice(start, end);
  assert(!/fixtureCapture|captureNetflix|GM_registerMenuCommand/.test(injection));
});

test('instrumentation covers lifecycle, metadata, catalogs, filenames, downloads, and batch decisions', () => {
  [
    'session.started', 'session.invalidated', 'navigation.changed', 'playback.reset',
    'metadata.response-observed', 'metadata.accepted', 'subtitle.catalog-observed', 'tracks.updated',
    'filename.preview', 'filename.resolved', 'download.started', 'download.track-selected',
    'download.mirror-failed', 'subtitle.response-observed', 'archive.finished', 'download.finished',
    'download.ignored', 'batch.requested', 'batch.planned', 'batch.unavailable', 'batch.failed',
    'batch.navigation-scheduled'
  ].forEach(type => assert(source.includes(type), `${type} instrumentation missing`));
});

console.log(`Netflix fixture capture adapter tests passed: ${passed}`);
