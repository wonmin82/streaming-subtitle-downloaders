'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { verifyCaptureObject } = require('../tools/fixture-lib/verifier');

const ROOT = path.resolve(__dirname, '..');
const TEMPLATE_PATH = path.join(ROOT, 'shared', 'fixture-capture.template.js');
const SYNC_PATH = path.join(ROOT, 'tools', 'sync-fixture-capture.js');
const source = fs.readFileSync(TEMPLATE_PATH, 'utf8');
const sandbox = { URL, Blob, Date, JSON, Object, Array, String, Number, Math, RegExp, isFinite };
vm.createContext(sandbox);
vm.runInContext(`${source}\nthis.createFixtureCapture = createFixtureCapture;`, sandbox);
const createFixtureCapture = sandbox.createFixtureCapture;

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

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function harness(overrides = {}) {
  const clock = { value: 1000 };
  const capture = createFixtureCapture({
    service: 'disney',
    scriptVersion: '1.2.3',
    page: {
      host: 'www.disneyplus.com',
      path: '/play/550e8400-e29b-41d4-a716-446655440000'
    },
    now: () => clock.value,
    ...overrides
  });
  return { capture, clock };
}

test('capture is inert until explicitly started', () => {
  const { capture } = harness();
  assert.deepStrictEqual(plain(capture.status()), {
    state: 'idle',
    recording: false,
    eventCount: 0,
    artifactCount: 0,
    snapshotCount: 0,
    truncated: false,
    exportBlocked: false,
    lastError: ''
  });
  assert.strictEqual(capture.event('metadata.observed', { title: 'SHOW' }), false);
  assert.strictEqual(capture.snapshot('dom', { title: 'SHOW' }), false);
  assert.strictEqual(capture.artifact('manifest', '#EXTM3U', { format: 'hls' }), null);
  assert.strictEqual(capture.setObserved({ filename: 'SHOW' }), false);
  assert.strictEqual(capture.stop(), false);
  assert.strictEqual(capture.exportObject(), null);
});

test('state transitions and schema version 1 remain deterministic', () => {
  const { capture, clock } = harness();
  assert.strictEqual(capture.start({ reason: 'manual' }), true);
  assert.strictEqual(capture.start(), false, 'starting an active capture must be a no-op');
  clock.value = 1125;
  assert.strictEqual(capture.event('metadata.accepted', { title: 'SHOW_001' }, { session: 'real-session-a' }), true);
  assert.strictEqual(capture.snapshot('metadata', { title: 'SHOW_001' }, { session: 'real-session-a' }), true);
  assert.strictEqual(capture.setObserved({ filename: 'SHOW_001.S03E02' }), true);
  clock.value = 1500;
  assert.strictEqual(capture.stop({ filename: 'SHOW_001.S03E02' }), true);
  assert.strictEqual(capture.stop(), false);

  const output = capture.exportObject();
  assert(output);
  assert.strictEqual(output.schemaVersion, 1);
  assert.strictEqual(output.captureToolVersion, '1.0.0');
  assert.strictEqual(output.service, 'disney');
  assert.strictEqual(output.scriptVersion, '1.2.3');
  assert.strictEqual(output.capture.durationMs, 500);
  assert.strictEqual(output.capture.limits.maxDepth, 12);
  assert.strictEqual(output.page.host, 'www.disneyplus.com');
  assert.strictEqual(output.page.path, '/play/TOKEN_1');
  assert.strictEqual(output.events[0].type, 'capture.start');
  assert.strictEqual(output.events[1].session, 'SESSION_1');
  assert.strictEqual(output.snapshots[0].session, 'SESSION_1');
  assert.strictEqual(output.events.at(-1).type, 'capture.stop');
  assert.deepStrictEqual(plain(output.observed), { filename: 'SHOW_001.S03E02' });

  assert.strictEqual(capture.clear(), true);
  assert.strictEqual(capture.status().state, 'idle');
  assert.strictEqual(capture.exportObject(), null);
});

test('URL and query sanitization preserves debugging structure without credentials', () => {
  const { capture } = harness();
  capture.start();
  capture.event('resource.observed', {
    url: 'https://user:password@cdn.example.test/sub/550e8400-e29b-41d4-a716-446655440000.vtt?lang=ko&token=super-secret&sig=abc#fragment'
  });
  capture.event('resource.observed', {
    url: 'https://cdn.example.test/sub/550e8400-e29b-41d4-a716-446655440000.vtt?lang=ko&token=different-secret'
  });
  capture.stop();
  const output = capture.exportObject();
  const first = output.events[1].data.url;
  const second = output.events[2].data.url;
  assert.strictEqual(first, 'https://cdn.example.test/sub/TOKEN_1.vtt?lang=ko&token=REDACTED&sig=REDACTED');
  assert.strictEqual(second, 'https://cdn.example.test/sub/TOKEN_1.vtt?lang=ko&token=REDACTED');
  assert(!JSON.stringify(output).includes('password'));
  assert(!JSON.stringify(output).includes('super-secret'));
  assert(!JSON.stringify(output).includes('fragment'));
});

test('path-embedded CDN signatures are replaced as complete path segments', () => {
  const { capture } = harness();
  const signedSegment = 'dvt2=exp=1787691905~url=%2Fps01%2Fdisney%2Fasset%2F~psid=8eb64ee7-e920-47ab-9146-e4a85769261a~aid=82387625-6cce-4166-81d8-6e23b21';
  capture.start();
  capture.event('resource.observed', {
    url: `https://cdn.example.test/${signedSegment}/ps01/disney/subtitle.m3u8`
  });
  capture.stop();
  const output = capture.exportObject();
  assert(output);
  const url = output.events[1].data.url;
  assert.match(url, /^https:\/\/cdn\.example\.test\/TOKEN_[1-9]\d*\/ps01\/disney\/subtitle\.m3u8$/);
  assert(!JSON.stringify(output).includes('dvt2='));
  assert(!JSON.stringify(output).includes('~psid='));
  assert(!JSON.stringify(output).includes('~aid='));
  assert(!JSON.stringify(output).includes('8eb64ee7-e920-47ab-9146-e4a85769261a'));
});

test('JSON sanitization redacts secrets and copyright-bearing text', () => {
  const { capture } = harness();
  capture.start();
  const id = capture.artifact('metadata', JSON.stringify({
    title: 'SHOW_001',
    content_id: '12345678901234567890',
    access_token: 'ordinary-token-value',
    synopsis: 'This is copyrighted descriptive text.',
    profileName: 'PRIVATE_PROFILE',
    firstName: 'PRIVATE_FIRST',
    fullName: 'PRIVATE_FULL',
    lastName: 'PRIVATE_LAST',
    profileId: '12345',
    accountId: 123456789,
    subscriberId: 'abc123',
    userId: 'wonmin82',
    userid: 'compact-user-id',
    deviceid: 'compact-device-id',
    username: { minimumLength: 3, maximumLength: 30 },
    profiles: { child: { name: 'PRIVATE_CHILD' } },
    nested: { manifestUrl: 'https://cdn.example.test/a.m3u8?policy=secret' }
  }), { format: 'json' });
  capture.stop();
  const output = capture.exportObject();
  const parsed = JSON.parse(output.artifacts[id].text);
  assert.strictEqual(parsed.title, 'SHOW_001');
  assert.strictEqual(parsed.content_id, 'TOKEN_2');
  assert.strictEqual(parsed.access_token, 'REDACTED');
  assert.strictEqual(parsed.synopsis, 'TEXT_1');
  assert.strictEqual(parsed.profileName, 'REDACTED');
  assert.strictEqual(parsed.firstName, 'REDACTED');
  assert.strictEqual(parsed.fullName, 'REDACTED');
  assert.strictEqual(parsed.lastName, 'REDACTED');
  assert(/^TOKEN_\d+$/.test(parsed.profileId));
  assert(/^TOKEN_\d+$/.test(parsed.accountId));
  assert(/^TOKEN_\d+$/.test(parsed.subscriberId));
  assert(/^TOKEN_\d+$/.test(parsed.userId));
  assert(/^TOKEN_\d+$/.test(parsed.userid));
  assert(/^TOKEN_\d+$/.test(parsed.deviceid));
  assert.strictEqual(parsed.username, 'REDACTED');
  assert.strictEqual(parsed.profiles, 'REDACTED');
  assert.strictEqual(parsed.nested.manifestUrl, 'https://cdn.example.test/a.m3u8?policy=REDACTED');
  assert(!JSON.stringify(output).includes('PRIVATE_'));
  assert(output.sanitization.redactions >= 3);
});

test('default depth preserves bounded adapter projections without truncating the capture', () => {
  const { capture } = harness();
  let nested = { value: 'STRING_1' };
  for (let depth = 0; depth < 10; depth++) nested = { next: nested };
  capture.start();
  const id = capture.artifact('metadata-structure', JSON.stringify({ data: nested }), { format: 'json' });
  capture.stop();
  const output = capture.exportObject();
  assert(id);
  assert.strictEqual(output.capture.truncated, false);
  assert(!output.artifacts[id].text.includes('[MAX_DEPTH]'));
});

test('HLS sanitizer keeps manifest structure and scrubs signed resource URLs', () => {
  const { capture } = harness();
  capture.start();
  const id = capture.artifact('manifest', [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="https://license.example.test/key?token=secret"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,URI="https://cdn.example.test/master/12345678901234567890.m3u8?token=secret",LANGUAGE="ko"',
    '#EXTINF:2.0,',
    'https://cdn.example.test/sub/550e8400-e29b-41d4-a716-446655440000.vtt?sig=secret',
    'https://cdn.example.test/dvt2=exp=1787691905~url=%2Fsub%2F~psid=8eb64ee7-e920-47ab-9146-e4a85769261a~aid=82387625-6cce-4166-81d8-6e23b21/subtitle.m3u8',
    'segment.vtt?token=relative-secret'
  ].join('\n'), {
    format: 'hls',
    url: 'https://cdn.example.test/master.m3u8?policy=secret'
  });
  capture.stop();
  const artifact = capture.exportObject().artifacts[id];
  assert(artifact.text.includes('#EXTM3U'));
  assert(artifact.text.includes('#EXTINF:2.0,'));
  assert(artifact.text.includes('#EXT-X-KEY:REDACTED'));
  assert(!artifact.text.includes('license.example.test'));
  assert(artifact.text.includes('TOKEN_'));
  assert(artifact.text.includes('token=REDACTED'));
  assert(artifact.text.includes('sig=REDACTED'));
  assert(!artifact.text.includes('dvt2='));
  assert(!artifact.text.includes('~psid='));
  assert(!artifact.text.includes('relative-secret'));
  assert.strictEqual(artifact.url, 'https://cdn.example.test/master.m3u8?policy=REDACTED');
  assert(!artifact.text.includes('secret'));
});

test('WebVTT sanitizer preserves timing, cue markup, style, and region but not dialogue', () => {
  const { capture } = harness();
  capture.start();
  const id = capture.artifact('subtitle', [
    'WEBVTT - Episode title',
    '',
    'STYLE',
    '::cue { color: lime; }',
    '',
    'REGION',
    'id:bottom',
    '',
    'real-cue-id',
    '00:00:01.000 --> 00:00:03.000 line:80%',
    '<v Real Person><c.yellow>Actual subtitle dialogue</c>',
    '',
    'NOTE private note',
    'NOTE another private note',
    'more private note'
  ].join('\n'), { format: 'webvtt' });
  capture.stop();
  const exported = capture.exportObject();
  const text = exported.artifacts[id].text;
  assert(text.startsWith('WEBVTT'));
  assert(text.includes('STYLE'));
  assert(text.includes('::cue { color: lime; }'));
  assert(text.includes('REGION'));
  assert(text.includes('00:00:01.000 --> 00:00:03.000 line:80%'));
  assert(text.includes('<v SPEAKER>'));
  assert(text.includes('CAPTION_'));
  assert(text.includes('NOTE TEXT_'));
  assert.strictEqual((text.match(/^NOTE /gm) || []).length, 1);
  assert(!text.includes('Episode title'));
  assert(!text.includes('Real Person'));
  assert(!text.includes('Actual subtitle dialogue'));
  assert(!text.includes('private note'));
  assert.doesNotThrow(() => verifyCaptureObject(exported));
});

test('XML sanitizer preserves TTML structure and attributes but replaces text nodes', () => {
  const { capture } = harness();
  capture.start();
  const id = capture.artifact('subtitle', [
    '<?xml version="1.0"?>',
    '<tt xmlns="http://www.w3.org/ns/ttml">',
    '<body><div><p begin="00:00:01.000" end="00:00:03.000" xml:id="12345678901234567890">Actual dialogue <span style="s1">continues</span></p></div></body>',
    '</tt>'
  ].join(''), { format: 'ttml' });
  capture.stop();
  const text = capture.exportObject().artifacts[id].text;
  assert(text.includes('<tt xmlns="http://www.w3.org/ns/ttml">'));
  assert(text.includes('begin="00:00:01.000"'));
  assert(text.includes('end="00:00:03.000"'));
  assert(text.includes('xml:id="TOKEN_'));
  assert(text.includes('<span style="s1">'));
  assert(text.includes('CAPTION_'));
  assert(!text.includes('Actual dialogue'));
  assert(!text.includes('continues'));
});

test('session and token aliases are stable within one capture and reset on restart', () => {
  const { capture } = harness();
  capture.start();
  capture.event('session.start', { sessionId: 'session-a', contentId: '12345678901234567890' }, { session: 'session-a' });
  capture.event('track.added', { sessionId: 'session-a', contentId: '12345678901234567890' }, { session: 'session-a' });
  capture.stop();
  let output = capture.exportObject();
  assert.strictEqual(output.events[1].session, 'SESSION_1');
  assert.strictEqual(output.events[1].data.sessionId, 'SESSION_1');
  assert.strictEqual(output.events[2].data.sessionId, 'SESSION_1');
  assert.strictEqual(output.events[1].data.contentId, 'TOKEN_2');
  assert.strictEqual(output.events[2].data.contentId, 'TOKEN_2');

  capture.start();
  capture.event('session.start', { sessionId: 'session-b' }, { session: 'session-b' });
  capture.stop();
  output = capture.exportObject();
  assert.strictEqual(output.events[1].session, 'SESSION_1');
  assert.strictEqual(output.events[1].data.sessionId, 'SESSION_1');
});

test('event, artifact, string, and total capture limits are bounded', () => {
  const { capture } = harness({
    limits: {
      maxEvents: 2,
      maxArtifacts: 1,
      maxArtifactBytes: 128,
      maxCaptureBytes: 2048,
      maxStringBytes: 64
    }
  });
  assert.strictEqual(capture.start(), true);
  assert.strictEqual(capture.event('one', { value: 'long value '.repeat(50) }), true);
  assert.strictEqual(capture.event('two', {}), false);
  const id = capture.artifact('subtitle', `WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n${'dialogue '.repeat(100)}`, { format: 'vtt' });
  assert(id);
  assert.strictEqual(capture.artifact('manifest', '#EXTM3U', { format: 'hls' }), null);
  capture.stop();
  const output = capture.exportObject();
  assert(output);
  assert.strictEqual(output.events.length, 2);
  assert.strictEqual(Object.keys(output.artifacts).length, 1);
  assert(output.artifacts[id].byteLength <= 128);
  assert.strictEqual(output.capture.truncated, true);
  assert(output.sanitization.warnings.some(value => value === 'limit:maxEvents'));
  assert(output.sanitization.warnings.some(value => value === 'limit:maxArtifacts'));
  assert(output.sanitization.warnings.some(value => value === 'limit:maxArtifactBytes'));
  assert(Buffer.byteLength(JSON.stringify(output)) <= 2048);
});

test('cyclic values, hostile getters, and unsupported artifacts never throw to callers', () => {
  const { capture } = harness();
  const cyclic = { title: 'SHOW' };
  cyclic.self = cyclic;
  const hostile = {};
  Object.defineProperty(hostile, 'value', {
    enumerable: true,
    get() { throw new Error('must not escape'); }
  });
  capture.start();
  assert.doesNotThrow(() => capture.event('cyclic', cyclic));
  assert.doesNotThrow(() => capture.snapshot('hostile', hostile));
  let id;
  assert.doesNotThrow(() => { id = capture.artifact('unknown', 'private unstructured content', { format: 'binary-ish' }); });
  capture.stop();
  const output = capture.exportObject();
  assert.strictEqual(output.events[1].data.self, '[CIRCULAR]');
  assert.strictEqual(output.snapshots[0].data.value, '[UNREADABLE]');
  assert.strictEqual(output.artifacts[id].text, '[REDACTED_ARTIFACT]');
});

test('high-risk secret detection blocks export after record-time redaction', () => {
  const { capture } = harness();
  capture.start();
  capture.event('unexpected.header', {
    note: '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----'
  });
  capture.stop();
  assert.strictEqual(capture.status().exportBlocked, true);
  assert.strictEqual(capture.exportObject(), null);
  assert.strictEqual(capture.exportBlob(), null);
  assert.strictEqual(capture.status().lastError, 'export-blocked-sensitive-data');
});

test('DRM material and prohibited raw browser artifacts cannot enter an export', () => {
  let result = harness();
  result.capture.start();
  const jsonId = result.capture.artifact('metadata', JSON.stringify({
    title: 'SHOW_001',
    pssh: 'opaque-drm-value',
    licenseResponse: 'opaque-license-value'
  }), { format: 'json' });
  const htmlId = result.capture.artifact('dom', '<html>private page</html>', { format: 'html' });
  result.capture.stop();
  let output = result.capture.exportObject();
  assert(output);
  assert.strictEqual(htmlId, null);
  const parsed = JSON.parse(output.artifacts[jsonId].text);
  assert.strictEqual(parsed.pssh, 'REDACTED');
  assert.strictEqual(parsed.licenseResponse, 'REDACTED');
  assert(!JSON.stringify(output).includes('opaque-drm-value'));
  assert(!JSON.stringify(output).includes('private page'));

  result = harness();
  result.capture.start();
  assert.strictEqual(result.capture.artifact('license', 'license body', { format: 'binary' }), null);
  result.capture.stop();
  assert.strictEqual(result.capture.exportObject(), null, 'an attempted DRM artifact must block the entire export');
  assert.strictEqual(result.capture.status().exportBlocked, true);
});

test('exportBlob emits a self-contained JSON blob and supports live snapshots', () => {
  const { capture, clock } = harness();
  capture.start();
  clock.value = 1250;
  const live = capture.exportObject();
  assert.strictEqual(live.capture.durationMs, 250);
  assert.strictEqual(capture.status().state, 'recording');
  const blob = capture.exportBlob();
  assert(blob instanceof Blob);
  assert.strictEqual(blob.type, 'application/json;charset=utf-8');
  assert(blob.size > 0);
});

test('core source has no browser network, storage, or DOM side effects', () => {
  assert(!/\bfetch\s*\(/.test(source));
  assert(!/\bXMLHttpRequest\b/.test(source));
  assert(!/\bGM_xmlhttpRequest\b/.test(source));
  assert(!/\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b/.test(source));
  assert(!/\bdocument\s*\.|\bwindow\s*\./.test(source));
});

test('sync tool documents an explicit marker-only insertion contract for each adapter', () => {
  const syncSource = fs.readFileSync(SYNC_PATH, 'utf8');
  assert(syncSource.includes("const START_MARKER = '    // BEGIN SHARED FIXTURE CAPTURE CORE';"));
  assert(syncSource.includes("const END_MARKER = '    // END SHARED FIXTURE CAPTURE CORE';"));
  assert(syncSource.includes("'scripts/apple-tv-plus-subtitles-downloader.user.js'"));
  assert(syncSource.includes("'scripts/disney-plus-subtitles-downloader.user.js'"));
  assert(syncSource.includes('expected exactly one fixture capture marker pair'));
});

console.log(`fixture capture core tests passed: ${passed}`);
