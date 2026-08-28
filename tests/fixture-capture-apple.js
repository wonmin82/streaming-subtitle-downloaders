'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'scripts', 'apple-tv-plus-subtitles-downloader.user.js'), 'utf8');
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

test('developer mode consumes a fresh one-shot Apple tab arm', () => {
  const key = 'ssd:fixture-capture:apple:armed-until';
  const values = new Map([[key, '121000']]);
  const storage = {
    getItem: name => values.has(name) ? values.get(name) : null,
    setItem: (name, value) => values.set(name, value),
    removeItem: name => values.delete(name)
  };
  const topWindow = { sessionStorage: storage };
  topWindow.top = topWindow;
  let context = evaluate(functionDeclaration('consumeFixtureCaptureArm'), {
    window: topWindow,
    FIXTURE_CAPTURE_ARM_KEY: key,
    FIXTURE_CAPTURE_ARM_TTL_MS: 120000,
    Date: { now: () => 1000 },
    isFinite
  });
  assert.strictEqual(context.consumeFixtureCaptureArm(), true);
  assert.strictEqual(values.has(key), false);
  assert.strictEqual(context.consumeFixtureCaptureArm(), false);

  values.set(key, '121000');
  context = evaluate(functionDeclaration('consumeFixtureCaptureArm'), {
    window: { top: {}, sessionStorage: storage },
    FIXTURE_CAPTURE_ARM_KEY: key,
    FIXTURE_CAPTURE_ARM_TTL_MS: 120000,
    Date: { now: () => 1000 },
    isFinite
  });
  assert.strictEqual(context.consumeFixtureCaptureArm(), false);
  assert.strictEqual(values.has(key), true, 'a child frame must not consume the top-level arm');
  assert(!source.includes('ssd-fixture'));
  assert(source.includes('var fixtureCapture = fixtureCaptureEnabled ? createFixtureCapture('));
});

test('Apple capture version comes from userscript metadata', () => {
  const code = functionDeclaration('currentUserscriptVersion');
  let context = evaluate(code, { GM_info: { script: { version: '9.8.7' } } });
  assert.strictEqual(context.currentUserscriptVersion(), '9.8.7');
  context = evaluate(code);
  assert.strictEqual(context.currentUserscriptVersion(), 'unknown');
  assert(source.includes('// @grant      GM_info'));
  assert(source.includes('// @grant      GM_registerMenuCommand'));
  assert(source.includes('// @grant      GM_unregisterMenuCommand'));
  assert(source.includes("service: 'apple'"));
  assert(!/scriptVersion:\s*['"]\d/.test(source));
});

test('developer commands stay in Tampermonkey and only the top frame', () => {
  const topWindow = {};
  topWindow.top = topWindow;
  const commands = new Map();
  let commandSequence = 0;
  let arms = 0;
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
    armFixtureCaptureAndReload: () => { arms++; },
    startFixtureCapture: () => { starts++; },
    debuglog: () => {}
  });
  context.installFixtureCaptureCommands();
  assert.deepStrictEqual([...commands.values()].map(command => command.label), ['[Fixture] Start capture and reload this tab']);
  assert.strictEqual(starts, 0);
  [...commands.values()][0].handler();
  assert.strictEqual(arms, 1);

  commands.clear();
  commandSequence = 0;
  context = evaluate(functionDeclaration('installFixtureCaptureCommands'), {
    window: topWindow,
    fixtureCapture: {},
    fixtureCaptureRecording: false,
    fixtureCaptureMenuCommandIds: [],
    GM_registerMenuCommand: (label, handler) => {
      const id = ++commandSequence;
      commands.set(id, { label, handler });
      return id;
    },
    GM_unregisterMenuCommand: id => commands.delete(id),
    startFixtureCapture: () => true,
    printFixtureCaptureStatus: () => {},
    exportFixtureCapture: () => {}
  });
  context.startFixtureCapture = () => {
    starts++;
    context.fixtureCaptureRecording = true;
    return true;
  };
  context.installFixtureCaptureCommands();
  assert.strictEqual(starts, 1);
  assert.deepStrictEqual([...commands.values()].map(command => command.label), [
    '[Fixture] Start/restart capture',
    '[Fixture] Stop and export',
    '[Fixture] Export snapshot',
    '[Fixture] Clear capture',
    '[Fixture] Print status'
  ]);

  const childLabels = [];
  context = evaluate(functionDeclaration('installFixtureCaptureCommands'), {
    window: { top: {} },
    fixtureCapture: null,
    fixtureCaptureRecording: false,
    fixtureCaptureMenuCommandIds: [],
    GM_registerMenuCommand: label => childLabels.push(label),
    GM_unregisterMenuCommand: () => {}
  });
  context.installFixtureCaptureCommands();
  assert.deepStrictEqual(childLabels, []);
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
      stop: () => {},
      setObserved: () => {},
      exportBlob: () => null,
      clear: () => {}
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
  const stopCommand = [...commands.values()].find(command => command.label === '[Fixture] Stop and export');
  assert(stopCommand, 'active stop command must be registered');
  stopCommand.handler();
  assert.strictEqual(context.fixtureCaptureRecording, false);
  assert.deepStrictEqual([...commands.values()].map(command => command.label), [
    '[Fixture] Start capture and reload this tab'
  ]);
});

test('disabled Apple adapter wrappers never evaluate lazy payloads', () => {
  let payloadCalls = 0;
  let eventCalls = 0;
  const context = evaluate(functionDeclaration('captureApple'), {
    fixtureCaptureRecording: false,
    fixtureCapture: { event: () => { eventCalls++; return true; } }
  });
  const factory = () => { payloadCalls++; return { value: 1 }; };
  assert.strictEqual(context.captureApple('metadata.observed', 'raw-session', factory), false);
  assert.strictEqual(payloadCalls, 0);
  assert.strictEqual(eventCalls, 0);
  context.fixtureCaptureRecording = true;
  assert.strictEqual(context.captureApple('metadata.observed', 'raw-session', factory), true);
  assert.strictEqual(payloadCalls, 1);
  assert.strictEqual(eventCalls, 1);
});

test('identical Apple metadata projections reuse one artifact', () => {
  let artifactCalls = 0;
  let metadataCalls = 0;
  const context = evaluate(functionDeclaration('captureAppleArtifact'), {
    fixtureCaptureRecording: true,
    fixtureMetadataArtifactCache: [],
    fixtureCapture: { artifact: () => `ARTIFACT_${++artifactCalls}` }
  });
  const first = context.captureAppleArtifact('metadata-structure', '{"data":"STRING_1"}', () => {
    metadataCalls++;
    return { format: 'json' };
  });
  const duplicate = context.captureAppleArtifact('metadata-structure', '{"data":"STRING_1"}', () => {
    metadataCalls++;
    return { format: 'json' };
  });
  assert.strictEqual(first, 'ARTIFACT_1');
  assert.strictEqual(duplicate, first);
  assert.strictEqual(artifactCalls, 1);
  assert.strictEqual(metadataCalls, 1);
});

test('Apple metadata artifacts preserve parser signals but remove private values', () => {
  const code = [
    'fixtureMetadataProjection', 'seasonEpisodeTag', 'formatSeasonEpisode', 'padNumber'
  ].map(functionDeclaration).join('\n');
  const context = evaluate(code, { fixtureCaptureRecording: true, isFinite });
  const projection = context.fixtureMetadataProjection(JSON.stringify({
    profile: { name: 'PRIVATE_PROFILE', profileId: 987654321 },
    accountId: 123456789,
    token: 'PRIVATE_TOKEN',
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
  assert(projection.includes('SHOW_001'));
  assert(projection.includes('S03E02'));
  assert(projection.includes('"sequenceNumber": 3'));
  assert(projection.includes('"sequenceNumber": 2'));
  assert(!projection.includes('PRIVATE_PROFILE'));
  assert(!projection.includes('PRIVATE_TOKEN'));
  assert(!projection.includes('PRIVATE_SYNOPSIS'));
  assert(!projection.includes('PRIVATE_SHOW_TITLE'));
  assert(!projection.includes('987654321'));
  assert(!projection.includes('123456789'));
});

test('metadata response capture passes only a projected body to artifacts', () => {
  const code = [
    'inspectMetadataResponse', 'fixtureMetadataProjection',
    'seasonEpisodeTag', 'formatSeasonEpisode', 'padNumber'
  ].map(functionDeclaration).join('\n');
  let artifactText = '';
  const context = evaluate(code, {
    fixtureCaptureRecording: true,
    isFinite,
    shouldInspectMetadataUrl: () => true,
    rememberSessionObservation: () => false,
    resolveObservationSession: session => session,
    isPlaybackSessionCurrent: () => true,
    extractMetadataFromText: () => ({ title: 'SHOW_001', seasonNumber: 3, episodeNumber: 2 }),
    metadataConflictsWithActivePlayback: () => false,
    captureAppleArtifact: (kind, text) => { artifactText = text; return 'ARTIFACT_1'; },
    captureApple: () => true,
    updateMediaMetadata: () => {},
    fixtureMetadataState: () => ({ ready: true })
  });
  const raw = JSON.stringify({
    profileName: 'PRIVATE_PROFILE',
    accountId: 123456789,
    data: { program: { series: { title: 'PRIVATE_SHOW_TITLE' } } }
  });
  context.inspectMetadataResponse('https://example.test/playback', raw, 'session', 1);
  assert(artifactText);
  assert.notStrictEqual(artifactText, raw);
  assert(!artifactText.includes('PRIVATE_PROFILE'));
  assert(!artifactText.includes('123456789'));
  assert(!artifactText.includes('PRIVATE_SHOW_TITLE'));
});

test('Apple resource capture distinguishes manifests, subtitles, media, and metadata', () => {
  const context = evaluate(functionDeclaration('fixtureResourceKind'));
  assert.strictEqual(context.fixtureResourceKind('https://example.test/master.m3u8'), 'manifest');
  assert.strictEqual(context.fixtureResourceKind('https://example.test/subtitles.webvtt'), 'subtitle');
  assert.strictEqual(context.fixtureResourceKind('https://example.test/video/segment.m4s'), 'media');
  assert.strictEqual(context.fixtureResourceKind('https://tv.apple.com/api/uts/v3/canvases/channels/example'), 'metadata');
  assert.strictEqual(context.fixtureResourceKind('https://example.test/unknown'), 'other');
});

test('Apple capture records only track merges that change the summarized track', () => {
  let captured = 0;
  const context = evaluate(functionDeclaration('mergeTrack'), {
    state: { playbackSessionId: 'apple:test' },
    fixtureCaptureRecording: true,
    fixtureCapture: {},
    fixtureTrackSummary: track => ({
      name: track.NAME || '',
      language: track.LANGUAGE || '',
      source: track.source || '',
      activePlayback: !!track.activePlayback,
      segmentCount: track.segments ? track.segments.length : 0
    }),
    captureApple: () => { captured++; return true; },
    trackSourceScore: () => 1,
    isShortPreviewTrack: () => false,
    isBetterTrackName: () => false,
    debuglog: () => {}
  });
  const existing = {
    NAME: 'Korean', LANGUAGE: 'ko', FORCED: 'NO', URI: 'https://example.test/ko.m3u8',
    source: 'master', activePlayback: false, segments: null
  };
  const duplicate = { ...existing };
  context.mergeTrack(existing, duplicate);
  assert.strictEqual(captured, 0, 'a no-op merge must not consume the capture event budget');

  context.mergeTrack(existing, { ...duplicate, activePlayback: true });
  assert.strictEqual(captured, 1, 'a meaningful track upgrade should be captured');
  context.mergeTrack(existing, { ...duplicate, activePlayback: true });
  assert.strictEqual(captured, 1, 'repeating the same upgrade must not create another event');
});

test('large Apple manifests are reduced before entering the bounded capture core', () => {
  const context = evaluate(functionDeclaration('fixtureManifestProjection'), {
    fixtureCaptureRecording: true,
    looksLikeSubtitlePlaylist: () => true
  });
  const lines = ['#EXTM3U'];
  for (let index = 0; index < 800; index++) {
    lines.push(`#EXTINF:2.0,${index}`);
    lines.push(`https://cdn.example.test/subtitle-${index}.vtt?token=PRIVATE_${index}`);
  }
  const sourceManifest = lines.join('\n');
  const projection = context.fixtureManifestProjection('https://cdn.example.test/subtitle.m3u8', sourceManifest);
  assert.strictEqual(projection.relevant, true);
  assert.strictEqual(projection.projected, true);
  assert.strictEqual(projection.originalLineCount, lines.length);
  assert(projection.projectedLineCount <= 501);
  assert(projection.text.length < 750000);
  assert(projection.text.includes('SSD_FIXTURE_PROJECTION_OMITTED'));

  context.fixtureCaptureRecording = false;
  assert.strictEqual(context.fixtureManifestProjection('https://cdn.example.test/subtitle.m3u8', sourceManifest).text, '');
  assert(functionDeclaration('queueManifest').includes('fixtureCaptureRecording && hlsManifest'));
  assert(functionDeclaration('getTrackVtt').includes('fixtureCaptureRecording && hlsPlaylist'));
});

test('capture helpers add no page, request, persistent storage, observer, or timer path', () => {
  const helperNames = [
    'startFixtureCapture', 'fixtureObservedState', 'exportFixtureCapture', 'printFixtureCaptureStatus',
    'captureApple', 'captureAppleArtifact', 'captureAppleSnapshot', 'fixtureTrackSummary',
    'fixtureMetadataState', 'fixtureMetadataProjection', 'fixtureManifestProjection', 'fixtureResourceKind',
    'fixtureErrorCode'
  ];
  const helpers = helperNames.map(functionDeclaration).join('\n');
  assert(!/document\.|createElement|GM_xmlhttpRequest|XMLHttpRequest|\bfetch\s*\(|GM_(?:get|set|delete)Value|MutationObserver|setTimeout|setInterval/.test(helpers));
});

test('Apple instrumentation covers replay-relevant decisions without raw unrecognized bodies', () => {
  const manifestLoader = functionDeclaration('queueManifest');
  const trackLoader = functionDeclaration('getTrackVtt');
  const filename = functionDeclaration('safeBaseFilename');
  assert(manifestLoader.includes("captureAppleArtifact('manifest'"));
  assert(manifestLoader.includes("'unrecognized-response'"));
  assert(trackLoader.includes("captureAppleArtifact('subtitle-playlist'"));
  assert(trackLoader.includes("'unrecognized-response'"));
  assert(filename.includes("captureAppleSnapshot('filename.resolved'"));
  assert(functionDeclaration('addTrack').includes("captureApple('track.added'"));
  assert(functionDeclaration('parseManifest').includes("captureApple('manifest.parsed'"));
  assert(functionDeclaration('buildSubtitleFile').includes("captureAppleArtifact('subtitle-output'"));
});

console.log(`Apple TV+ fixture capture adapter tests passed: ${passed}`);
