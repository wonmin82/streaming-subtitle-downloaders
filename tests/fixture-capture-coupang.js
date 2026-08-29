'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'scripts', 'coupang-play-subtitles-downloader.user.js'), 'utf8');
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
  const key = 'ssd:fixture-capture:coupang:armed-until';
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
  assert.strictEqual(values.has(key), false);
  assert.strictEqual(context.consumeFixtureCaptureArm(), false);

  values.set(key, '999');
  assert.strictEqual(context.consumeFixtureCaptureArm(), false);
  assert.strictEqual(values.has(key), false);

  values.set(key, '121000');
  context = evaluate(code, {
    window: { top: {}, sessionStorage: storage },
    FIXTURE_CAPTURE_ARM_KEY: key,
    FIXTURE_CAPTURE_ARM_TTL_MS: 120000,
    Date: { now: () => 1000 },
    isFinite
  });
  assert.strictEqual(context.consumeFixtureCaptureArm(), false);
  assert.strictEqual(values.has(key), true, 'a child frame must not consume the tab arm');
  assert(source.includes('var fixtureCapture = fixtureCaptureEnabled ? createFixtureCapture('));
});

test('arming records no capture data and reloads only the current top-level tab', () => {
  const values = new Map();
  const topWindow = { sessionStorage: { setItem: (name, value) => values.set(name, value) } };
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
});

test('fixture exports derive their version from userscript metadata', () => {
  const code = functionDeclaration('currentUserscriptVersion');
  let context = evaluate(code, { GM_info: { script: { version: '9.8.7' } } });
  assert.strictEqual(context.currentUserscriptVersion(), '9.8.7');
  context = evaluate(code);
  assert.strictEqual(context.currentUserscriptVersion(), 'unknown');
  assert(source.includes('// @grant      GM_info'));
  assert(source.includes('// @grant      GM_unregisterMenuCommand'));
  assert(source.includes('scriptVersion: currentUserscriptVersion()'));
  assert(!/scriptVersion:\s*['"]\d/.test(source));
});

test('developer commands stay in Tampermonkey and out of the page menu', () => {
  const topWindow = {};
  topWindow.top = topWindow;
  const commands = new Map();
  let commandSequence = 0;
  let starts = 0;
  let context = evaluate(functionDeclaration('installFixtureCaptureCommands'), {
    window: topWindow,
    fixtureCapture: null,
    fixtureCaptureRecording: false,
    fixtureCaptureMenuCommandIds: [],
    GM_registerMenuCommand: (label, handler) => {
      const id = ++commandSequence;
      commands.set(id, { label, handler });
      return id;
    },
    GM_unregisterMenuCommand: id => commands.delete(id),
    armFixtureCaptureAndReload: () => true,
    startFixtureCapture: () => { starts++; },
    debuglog: () => {}
  });
  context.installFixtureCaptureCommands();
  assert.strictEqual(starts, 0);
  assert.deepStrictEqual([...commands.values()].map(command => command.label), [
    '[Fixture] Start capture and reload this tab'
  ]);

  commands.clear();
  commandSequence = 0;
  context = evaluate(functionDeclaration('installFixtureCaptureCommands'), {
    window: topWindow,
    fixtureCapture: {},
    fixtureCaptureRecording: true,
    fixtureCaptureMenuCommandIds: [],
    GM_registerMenuCommand: (label, handler) => {
      const id = ++commandSequence;
      commands.set(id, { label, handler });
      return id;
    },
    GM_unregisterMenuCommand: id => commands.delete(id),
    startFixtureCapture: () => true,
    printFixtureCaptureStatus: () => {},
    exportFixtureCapture: () => {},
    armFixtureCaptureAndReload: () => true,
    debuglog: () => {}
  });
  context.installFixtureCaptureCommands(true);
  assert.deepStrictEqual([...commands.values()].map(command => command.label), [
    '[Fixture] Start/restart capture',
    '[Fixture] Stop and export',
    '[Fixture] Export snapshot',
    '[Fixture] Clear capture',
    '[Fixture] Print status'
  ]);
  assert(!functionDeclaration('installStyles').includes('[Fixture]'));
  assert(!functionDeclaration('ensureWidget').includes('[Fixture]'));
});

test('stop and export replaces active commands with the start-and-reload command', () => {
  const topWindow = {};
  topWindow.top = topWindow;
  const commands = new Map();
  let commandSequence = 0;
  const code = [
    functionDeclaration('installFixtureCaptureCommands'),
    functionDeclaration('exportFixtureCapture')
  ].join('\n');
  const context = evaluate(code, {
    window: topWindow,
    fixtureCaptureRecording: true,
    fixtureCaptureMenuCommandIds: [],
    fixtureSnapshotValues: {},
    fixtureMetadataArtifactCache: [],
    fixtureCapture: {
      stop: () => {}, setObserved: () => {}, exportBlob: () => null, clear: () => {}
    },
    GM_registerMenuCommand: (label, handler) => {
      const id = ++commandSequence;
      commands.set(id, { label, handler });
      return id;
    },
    GM_unregisterMenuCommand: id => commands.delete(id),
    startFixtureCapture: () => true,
    armFixtureCaptureAndReload: () => true,
    fixtureObservedState: () => ({}),
    printFixtureCaptureStatus: () => {},
    debuglog: () => {}
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

test('disabled adapter wrappers do not evaluate lazy payloads', () => {
  let payloadCalls = 0;
  let eventCalls = 0;
  const context = evaluate(functionDeclaration('captureCoupang'), {
    fixtureCaptureRecording: false,
    fixtureCapture: { event: () => { eventCalls++; return true; } }
  });
  const payload = () => { payloadCalls++; return { value: 1 }; };
  assert.strictEqual(context.captureCoupang('metadata.accepted', 'SESSION_RAW', payload), false);
  assert.strictEqual(payloadCalls, 0);
  assert.strictEqual(eventCalls, 0);
  context.fixtureCaptureRecording = true;
  assert.strictEqual(context.captureCoupang('metadata.accepted', 'SESSION_RAW', payload), true);
  assert.strictEqual(payloadCalls, 1);
  assert.strictEqual(eventCalls, 1);
});

test('identical metadata projections reuse one artifact', () => {
  let artifactCalls = 0;
  let metadataCalls = 0;
  const context = evaluate(functionDeclaration('captureCoupangArtifact'), {
    fixtureCaptureRecording: true,
    fixtureMetadataArtifactCache: [],
    fixtureCapture: { artifact: () => `ARTIFACT_${++artifactCalls}` }
  });
  const first = context.captureCoupangArtifact('metadata-structure', '{"data":"STRING_1"}', () => {
    metadataCalls++;
    return { format: 'json' };
  });
  const duplicate = context.captureCoupangArtifact('metadata-structure', '{"data":"STRING_1"}', () => {
    metadataCalls++;
    return { format: 'json' };
  });
  assert.strictEqual(first, 'ARTIFACT_1');
  assert.strictEqual(duplicate, first);
  assert.strictEqual(artifactCalls, 1);
  assert.strictEqual(metadataCalls, 1);
});

test('capture helpers add no page, request, persistent storage, observer, or timer path', () => {
  const helperNames = [
    'startFixtureCapture', 'fixtureObservedState', 'exportFixtureCapture', 'printFixtureCaptureStatus',
    'captureCoupang', 'captureCoupangResource', 'captureCoupangArtifact', 'captureCoupangSnapshot', 'fixtureTrackSummary',
    'fixtureMetadataState', 'fixtureResourceKind', 'fixtureMetadataProjection',
    'fixtureManifestText', 'fixtureErrorCode'
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

test('metadata projections retain parser signals and remove private values', () => {
  const context = evaluate(functionDeclaration('fixtureMetadataProjection'), {
    fixtureCaptureRecording: true,
    seasonEpisodeTag: value => /^S\d{2}E\d{2}$/.test(value) ? value : '',
    isFinite
  });
  const projection = context.fixtureMetadataProjection(JSON.stringify({
    profile: { name: 'PRIVATE_PROFILE', email: 'private@example.test' },
    accessToken: 'PRIVATE_TOKEN',
    data: {
      parent: { title: 'PRIVATE_SHOW' },
      season: 2,
      episode: 4,
      language: 'ko'
    }
  }));
  assert(projection.includes('SHOW_001'));
  assert(projection.includes('"season": 2'));
  assert(projection.includes('"episode": 4'));
  assert(projection.includes('"language": "ko"'));
  assert(!projection.includes('PRIVATE_PROFILE'));
  assert(!projection.includes('private@example.test'));
  assert(!projection.includes('PRIVATE_TOKEN'));
  assert(!projection.includes('PRIVATE_SHOW'));
});

test('repository metadata requests capture only their projected body', () => {
  const raw = '{"profile":{"email":"private@example.test"},"data":{"title":"PRIVATE_TITLE"}}';
  const projected = '{"data":{"title":"TITLE_001"}}';
  let artifactText = '';
  let eventData = null;
  const context = evaluate(functionDeclaration('getJson'), {
    state: { playbackSessionId: 'SESSION_1' },
    getText: () => ({ then: callback => callback(raw) }),
    fixtureMetadataProjection: text => {
      assert.strictEqual(text, raw);
      return projected;
    },
    captureCoupangArtifact: (kind, text, metadataFactory) => {
      assert.strictEqual(kind, 'metadata-structure');
      artifactText = text;
      metadataFactory();
      return 'ARTIFACT_1';
    },
    captureCoupang: (type, session, payloadFactory) => {
      assert.strictEqual(type, 'metadata.request-completed');
      assert.strictEqual(session, 'SESSION_1');
      eventData = payloadFactory();
      return true;
    }
  });
  const parsed = context.getJson('https://www.coupangplay.com/api-discover/v1/discover/titles/TOKEN_1');
  assert.strictEqual(parsed.data.title, 'PRIVATE_TITLE');
  assert.strictEqual(artifactText, projected);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(eventData)), {
    url: 'https://www.coupangplay.com/api-discover/v1/discover/titles/TOKEN_1',
    artifact: 'ARTIFACT_1'
  });
});

test('resource classification distinguishes manifests, subtitles, metadata, and media', () => {
  const context = evaluate(functionDeclaration('fixtureResourceKind'), {
    isManifestUrl: value => /\.(?:m3u8|mpd)(?:\?|$)/.test(value),
    isSubtitleUrl: value => /\.vtt(?:\?|$)/.test(value)
  });
  assert.strictEqual(context.fixtureResourceKind('https://cdn.test/master.m3u8'), 'hls-manifest');
  assert.strictEqual(context.fixtureResourceKind('https://cdn.test/manifest.mpd'), 'dash-manifest');
  assert.strictEqual(context.fixtureResourceKind('https://cdn.test/ko.vtt'), 'subtitle');
  assert.strictEqual(context.fixtureResourceKind('https://www.coupangplay.com/api-discover/v1/title'), 'metadata');
  assert.strictEqual(context.fixtureResourceKind('https://cdn.test/chunk.m4s'), 'media');
  assert.strictEqual(context.fixtureResourceKind('https://www.coupangplay.com/api-playback/v1/license'), 'ignored');
});

test('resource capture excludes DRM, media, and unrelated requests before sanitization', () => {
  const events = [];
  const code = [
    functionDeclaration('captureCoupangResource'),
    functionDeclaration('fixtureResourceKind')
  ].join('\n');
  const context = evaluate(code, {
    fixtureCaptureRecording: true,
    fixtureCapture: {},
    isManifestUrl: value => /\.(?:m3u8|mpd)(?:\?|$)/.test(value),
    isSubtitleUrl: value => /\.vtt(?:\?|$)/.test(value),
    captureCoupang: (type, session, payloadFactory) => {
      events.push({ type, session, data: payloadFactory() });
      return true;
    }
  });
  assert.strictEqual(context.captureCoupangResource('https://cdn.test/master.m3u8', 'fetch', 'SESSION_1'), true);
  assert.strictEqual(context.captureCoupangResource('https://www.coupangplay.com/api-playback/v1/license', 'fetch', 'SESSION_1'), false);
  assert.strictEqual(context.captureCoupangResource('https://cdn.test/chunk.m4s', 'performance', 'SESSION_1'), false);
  assert.strictEqual(context.captureCoupangResource('https://telemetry.test/events', 'fetch', 'SESSION_1'), false);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(events)), [{
    type: 'resource.observed',
    session: 'SESSION_1',
    data: { url: 'https://cdn.test/master.m3u8', source: 'fetch', kind: 'hls-manifest' }
  }]);
});

test('fixture status logging exposes safe export failure codes as text', () => {
  const messages = [];
  const context = evaluate(functionDeclaration('printFixtureCaptureStatus'), {
    fixtureCapture: {
      status: () => ({
        state: 'stopped', recording: false, eventCount: 4,
        artifactCount: 1, snapshotCount: 1, truncated: false,
        exportBlocked: true, lastError: 'export-blocked-sensitive-data'
      })
    },
    console: { info: message => messages.push(message) },
    LOG_PREFIX: '[Fixture test]'
  });
  context.printFixtureCaptureStatus();
  assert.strictEqual(messages.length, 1);
  assert(messages[0].includes('"exportBlocked":true'));
  assert(messages[0].includes('"lastError":"export-blocked-sensitive-data"'));
});

test('successful fixture export passes the JSON blob to the existing file saver', () => {
  const saved = [];
  const blob = { type: 'application/json;charset=utf-8' };
  const context = evaluate(functionDeclaration('exportFixtureCapture'), {
    fixtureCaptureRecording: false,
    fixtureCapture: { exportBlob: pretty => pretty === true ? blob : null },
    saveAs: (value, filename) => saved.push({ value, filename }),
    printFixtureCaptureStatus: () => {},
    debuglog: () => {},
    Date: class extends Date {
      constructor() { super('2026-08-29T00:00:00.000Z'); }
    }
  });
  context.exportFixtureCapture(false);
  assert.deepStrictEqual(saved, [{
    value: blob,
    filename: 'coupang-2026-08-29T00-00-00-000Z.fixture.local.json'
  }]);
});

test('metadata changes produce accepted events and deduplicated snapshots', () => {
  const events = [];
  const snapshots = [];
  const context = evaluate(functionDeclaration('mergeMediaMetadata'), {
    state: {
      playbackSessionId: 'SESSION_1', mediaTitle: '', mediaTitlePriority: 0,
      seasonNumber: null, episodeNumber: null, episodeTag: '', episodeTitle: '', episodeConfirmed: false
    },
    fixtureCaptureRecording: true,
    fixtureCapture: {},
    fixtureMetadataState: () => ({
      title: context.state.mediaTitle,
      seasonNumber: context.state.seasonNumber,
      episodeNumber: context.state.episodeNumber,
      episodeTag: context.state.episodeTag,
      episodeConfirmed: context.state.episodeConfirmed
    }),
    cleanDisplayTitle: value => String(value || '').trim(),
    formatSeasonEpisodeTag: (season, episode) => season && episode ? `S0${season}E0${episode}` : '',
    captureCoupang: (type, session, payloadFactory) => events.push({ type, session, data: payloadFactory() }),
    captureCoupangSnapshot: (kind, session, payloadFactory) => snapshots.push({ kind, session, data: payloadFactory() })
  });
  context.mergeMediaMetadata({
    title: 'SHOW_001', seasonNumber: 1, episodeNumber: 3,
    episodeTitle: 'EPISODE_001', episodeConfirmed: true
  }, 2);
  assert.strictEqual(context.state.mediaTitle, 'SHOW_001');
  assert.strictEqual(context.state.episodeTag, 'S01E03');
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].type, 'metadata.accepted');
  assert.strictEqual(snapshots.length, 1);
  assert.strictEqual(snapshots[0].kind, 'metadata');
});

test('metadata discovery events do not expose raw request identifiers', () => {
  const discovery = functionDeclaration('scheduleDiscoverMetadata');
  assert(!/return\s*\{\s*requestKey\s*:/.test(discovery));
  assert(discovery.includes('hasParentId: !!identifiers.parentId'));
});

test('filename decisions reuse the production filename result', () => {
  const snapshots = [];
  const context = evaluate(functionDeclaration('safeBaseFilename'), {
    state: {
      playbackSessionId: 'SESSION_1', mediaTitle: 'SHOW_001',
      seasonNumber: 1, episodeNumber: 3, episodeTitle: '', episodeConfirmed: true
    },
    mediaMetadataFromDom: () => ({}),
    mergeMediaMetadata: () => {},
    displayTitle: () => 'FALLBACK',
    formatSeasonEpisodeTag: () => 'S01E03',
    uniqueFilenameParts: parts => parts.filter(Boolean),
    sanitizeFilename: value => value,
    fixtureMetadataState: () => ({ title: 'SHOW_001', episodeTag: 'S01E03' }),
    captureCoupangSnapshot: (kind, session, payloadFactory) => snapshots.push({ kind, session, data: payloadFactory() })
  });
  assert.strictEqual(context.safeBaseFilename(), 'SHOW_001.S01E03');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(snapshots)), [{
    kind: 'filename.preview',
    session: 'SESSION_1',
    data: { filename: 'SHOW_001.S01E03', metadata: { title: 'SHOW_001', episodeTag: 'S01E03' } }
  }]);
});

test('pilot records session, resource, metadata, manifest, track, filename, and download decisions', () => {
  for (const event of [
    'session.started', 'resource.observed', 'metadata.response-observed',
    'metadata.accepted', 'metadata.discovery-started', 'metadata.discovery-finished',
    'manifest.parsed', 'track.added', 'track.merged', 'filename.resolved',
    'download.started', 'download.track-source', 'download.finished'
  ]) {
    assert(source.includes(`'${event}'`), `${event} capture point missing`);
  }
  assert(source.includes('// @grant      GM_registerMenuCommand'));
  assert(/^\/\/ @version\s+1\.0\.27$/m.test(source));
});

console.log(`Coupang Play fixture capture adapter tests passed: ${passed}`);
