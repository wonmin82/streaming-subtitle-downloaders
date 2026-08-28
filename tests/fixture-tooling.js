'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { FixtureValidationError } = require('../tools/fixture-lib/schema');
const { FixtureSecurityError, inspectCapture, verifyAll, verifyCaptureObject, verifyFixture } = require('../tools/fixture-lib/verifier');
const { importCaptureObject } = require('../tools/fixture-lib/importer');

const ROOT = path.resolve(__dirname, '..');
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

function artifact(kind, format, text, extra = {}) {
  return { kind, format, ...extra, text, byteLength: Buffer.byteLength(text, 'utf8') };
}

function capture(overrides = {}) {
  const base = {
    schemaVersion: 1,
    captureToolVersion: '1.0.0',
    service: 'disney',
    scriptVersion: 'test',
    page: { host: 'www.disneyplus.com', path: '/play/TOKEN_1' },
    capture: {
      startedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 1000,
      truncated: false,
      limits: { events: 3000, artifacts: 200, bytes: 20971520 }
    },
    events: [
      { seq: 1, t: 0, type: 'session.start', session: 'SESSION_1', data: { reason: 'navigation' } },
      { seq: 2, t: 500, type: 'metadata.accepted', session: 'SESSION_1', data: { title: 'SHOW_001' } }
    ],
    snapshots: [
      { seq: 3, t: 600, kind: 'metadata', session: 'SESSION_1', data: { title: 'SHOW_001' } }
    ],
    artifacts: {
      ARTIFACT_1: artifact('metadata', 'json', '{"title":"SHOW_001"}\n', {
        url: 'https://disney.api.edge.bamgrid.com/TOKEN_1/metadata',
        metadata: { source: 'network', request: 'TOKEN_2' }
      })
    },
    observed: { filename: 'SHOW_001.S01E01' },
    sanitization: { version: 1, redactions: 2, warnings: [] }
  };
  return { ...base, ...overrides };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function temporaryRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtitle-fixtures-'));
  fs.mkdirSync(path.join(root, 'fixtures'));
  return { root, fixtures: path.join(root, 'fixtures') };
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

test('schema version 1 capture is inspectable without revealing values', () => {
  const summary = inspectCapture(capture());
  assert.strictEqual(summary.safeForImport, true);
  assert.strictEqual(summary.service, 'disney');
  assert.strictEqual(summary.eventTypes['metadata.accepted'], 1);
  assert.deepStrictEqual(summary.observedKeys, ['filename']);
  assert(!JSON.stringify(summary).includes('SHOW_001'), 'inspect output must not include captured values');
});

test('capture schema rejects unsupported versions and inconsistent artifact sizes', () => {
  assert.throws(() => verifyCaptureObject(capture({ schemaVersion: 2 })), FixtureValidationError);
  const wrongLength = capture();
  wrongLength.artifacts.ARTIFACT_1.byteLength++;
  assert.throws(() => verifyCaptureObject(wrongLength), /Invalid capture schema/);
});

test('guard rejects credentials and signed URLs without echoing their values', () => {
  const withCredential = capture();
  withCredential.events[0].data.authorization = 'Bearer abcdefghijklmnopqrstuvwxyz';
  assert.throws(() => verifyCaptureObject(withCredential), error => {
    assert(error instanceof FixtureSecurityError);
    assert(error.issues.some(issue => issue.code === 'secret-field'));
    assert(!JSON.stringify(error.issues).includes('abcdefghijklmnopqrstuvwxyz'));
    return true;
  });

  const withSignature = capture();
  withSignature.artifacts.ARTIFACT_1.url = 'https://cdn.example.test/file.json?signature=private-value';
  assert.throws(() => verifyCaptureObject(withSignature), error => {
    assert(error instanceof FixtureSecurityError);
    return error.issues.some(issue => issue.code === 'signed-url');
  });

  const withPathSignature = capture();
  withPathSignature.artifacts.ARTIFACT_1.url = 'https://cdn.example.test/dvt2=exp=1787691905~url=%2Fsub%2F~psid=8eb64ee7-e920-47ab-9146-e4a85769261a~aid=82387625-6cce-4166-81d8-6e23b21/file.json';
  assert.throws(() => verifyCaptureObject(withPathSignature), error => {
    assert(error instanceof FixtureSecurityError);
    return error.issues.some(issue => issue.code === 'signed-url');
  });

  const withHeader = capture();
  withHeader.events[0].data.rawHeader = 'Cookie: private-session-value';
  assert.throws(() => verifyCaptureObject(withHeader), error => {
    assert(error instanceof FixtureSecurityError);
    return error.issues.some(issue => issue.code === 'credential-header');
  });

  const opaquePath = capture();
  opaquePath.artifacts.ARTIFACT_1.url = 'https://cdn.example.test/0123456789abcdef0123456789abcdef/metadata.json';
  assert.throws(() => verifyCaptureObject(opaquePath), error => {
    return error instanceof FixtureSecurityError && error.issues.some(issue => issue.code === 'opaque-url-path');
  });

  const signedManifest = capture();
  signedManifest.artifacts.ARTIFACT_1 = artifact(
    'manifest',
    'hls',
    '#EXTM3U\nhttps://cdn.example.test/segment.vtt?hdnea=private-value\n'
  );
  assert.throws(() => verifyCaptureObject(signedManifest), error => {
    return error instanceof FixtureSecurityError && error.issues.some(issue => issue.code === 'signed-url');
  });

  const secretJson = capture();
  secretJson.artifacts.ARTIFACT_1 = artifact('metadata', 'json', '{"accessToken":"private-value"}\n');
  assert.throws(() => verifyCaptureObject(secretJson), error => {
    return error instanceof FixtureSecurityError && error.issues.some(issue => issue.code === 'secret-field');
  });

  const apiKey = capture();
  apiKey.events[0].data.apiKey = 'private-api-key';
  assert.throws(() => verifyCaptureObject(apiKey), error => {
    return error instanceof FixtureSecurityError && error.issues.some(issue => issue.code === 'secret-field');
  });

  const relativeSignedManifest = capture();
  relativeSignedManifest.artifacts.ARTIFACT_1 = artifact('manifest', 'hls', '#EXTM3U\nsegment.vtt?token=private-value\n');
  assert.throws(() => verifyCaptureObject(relativeSignedManifest), error => {
    return error instanceof FixtureSecurityError && error.issues.some(issue => issue.code === 'signed-url');
  });

  const relativePathSignedManifest = capture();
  relativePathSignedManifest.artifacts.ARTIFACT_1 = artifact(
    'manifest',
    'hls',
    '#EXTM3U\n/dvt2=exp=1787691905~url=%2Fsub%2F~psid=8eb64ee7-e920-47ab-9146-e4a85769261a~aid=82387625-6cce-4166-81d8-6e23b21/subtitle.m3u8\n'
  );
  assert.throws(() => verifyCaptureObject(relativePathSignedManifest), error => {
    return error instanceof FixtureSecurityError && error.issues.some(issue => issue.code === 'signed-url');
  });
});

test('guard rejects DRM artifacts and opaque binary data', () => {
  const drm = capture();
  drm.artifacts.ARTIFACT_1 = artifact('license', 'widevine', 'not-a-license');
  assert.throws(() => verifyCaptureObject(drm), error => error instanceof FixtureSecurityError && error.issues.some(issue => issue.code === 'drm-artifact'));

  const binary = capture();
  binary.events[0].data.payload = 'A'.repeat(300);
  assert.throws(() => verifyCaptureObject(binary), error => error instanceof FixtureSecurityError && error.issues.some(issue => issue.code === 'binary-blob'));

  const hlsKey = capture();
  hlsKey.artifacts.ARTIFACT_1 = artifact('manifest', 'hls', '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.test/key"\n');
  assert.throws(() => verifyCaptureObject(hlsKey), error => error instanceof FixtureSecurityError && error.issues.some(issue => issue.code === 'drm-manifest'));

  const dashProtection = capture();
  dashProtection.artifacts.ARTIFACT_1 = artifact('manifest', 'mpd', '<MPD><ContentProtection><cenc:pssh>opaque</cenc:pssh></ContentProtection></MPD>');
  assert.throws(() => verifyCaptureObject(dashProtection), error => error instanceof FixtureSecurityError && error.issues.some(issue => issue.code === 'drm-manifest'));
});

test('subtitle guard accepts placeholders and rejects captured dialogue', () => {
  const sanitized = capture();
  sanitized.artifacts.ARTIFACT_1 = artifact(
    'subtitle-segment',
    'vtt',
    'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nCAPTION_001\n'
  );
  assert.doesNotThrow(() => verifyCaptureObject(sanitized));

  const subtitlePlaylist = capture();
  subtitlePlaylist.artifacts.ARTIFACT_1 = artifact(
    'subtitle-playlist',
    'm3u8',
    '#EXTM3U\n#EXTINF:2.0,\nhttps://cdn.example.test/subtitle-001.vtt\n'
  );
  assert.doesNotThrow(() => verifyCaptureObject(subtitlePlaylist), 'HLS subtitle playlists contain resource structure, not subtitle dialogue');

  const dialogue = clone(sanitized);
  dialogue.artifacts.ARTIFACT_1.text = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nThis is real dialogue.\n';
  dialogue.artifacts.ARTIFACT_1.byteLength = Buffer.byteLength(dialogue.artifacts.ARTIFACT_1.text);
  assert.throws(() => verifyCaptureObject(dialogue), error => error instanceof FixtureSecurityError && error.issues.some(issue => issue.code === 'subtitle-text'));

  const synopsis = capture();
  synopsis.observed.synopsis = 'A complete synopsis must not be committed.';
  assert.throws(() => verifyCaptureObject(synopsis), error => error instanceof FixtureSecurityError && error.issues.some(issue => issue.code === 'copyright-text-field'));

  const description = capture();
  description.observed.description = 'A description must be replaced before commit.';
  assert.throws(() => verifyCaptureObject(description), error => error instanceof FixtureSecurityError && error.issues.some(issue => issue.code === 'copyright-text-field'));

  const body = capture();
  body.observed.body = 'A response body must be reduced before commit.';
  assert.throws(() => verifyCaptureObject(body), error => error instanceof FixtureSecurityError && error.issues.some(issue => issue.code === 'copyright-text-field'));
});

test('WebVTT subtitle playlists cannot bypass dialogue verification', () => {
  const sanitized = capture();
  sanitized.artifacts.ARTIFACT_1 = artifact(
    'subtitle-playlist',
    'webvtt',
    'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nCAPTION_001\n'
  );
  assert.doesNotThrow(() => verifyCaptureObject(sanitized));

  const dialogue = clone(sanitized);
  dialogue.artifacts.ARTIFACT_1.text = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nThis is real dialogue.\n';
  dialogue.artifacts.ARTIFACT_1.byteLength = Buffer.byteLength(dialogue.artifacts.ARTIFACT_1.text);
  assert.throws(
    () => verifyCaptureObject(dialogue),
    error => error instanceof FixtureSecurityError && error.issues.some(issue => issue.code === 'subtitle-text')
  );
});

test('guard rejects account and profile data', () => {
  for (const unsafe of [
    { profileName: 'PRIVATE_PROFILE' },
    { fullName: 'PRIVATE_NAME' },
    { accountId: 123456789 },
    { subscriberId: 'abc123' },
    { profiles: { child: { name: 'PRIVATE_CHILD' } } }
  ]) {
    const value = capture();
    Object.assign(value.observed, unsafe);
    assert.throws(() => verifyCaptureObject(value), error => {
      return error instanceof FixtureSecurityError && error.issues.some(issue => issue.code === 'personal-data-field');
    });
  }
});

test('import creates an unreviewed, split, non-overwriting repository fixture', () => {
  const temp = temporaryRoot();
  try {
    const result = importCaptureObject(capture(), { name: 'episode-transition', fixtureRoot: temp.fixtures });
    assert.strictEqual(result.artifactCount, 1);
    assert(fs.existsSync(path.join(result.target, 'scenario.json')));
    assert(fs.existsSync(path.join(result.target, 'input', 'artifact-001.json')));
    const scenario = JSON.parse(fs.readFileSync(path.join(result.target, 'scenario.json'), 'utf8'));
    const expected = JSON.parse(fs.readFileSync(path.join(result.target, 'expected.json'), 'utf8'));
    assert(!('text' in scenario.artifacts.ARTIFACT_1), 'artifact text must be split into input/');
    assert.strictEqual(scenario.artifacts.ARTIFACT_1.input, 'input/artifact-001.json');
    assert.deepStrictEqual(scenario.artifacts.ARTIFACT_1.metadata, { source: 'network', request: 'TOKEN_2' });
    assert.deepStrictEqual(expected, { schemaVersion: 1, reviewed: false, assertions: {} });
    assert.throws(() => importCaptureObject(capture(), { name: 'episode-transition', fixtureRoot: temp.fixtures }), /Refusing to overwrite/);
    assert.throws(() => importCaptureObject(capture(), { name: '../escape', fixtureRoot: temp.fixtures }), /lowercase slug/);
    const crlfCapture = capture();
    crlfCapture.artifacts.ARTIFACT_1.text = '{\r\n  "title": "SHOW_001"\r\n}\r\n';
    crlfCapture.artifacts.ARTIFACT_1.byteLength = Buffer.byteLength(crlfCapture.artifacts.ARTIFACT_1.text, 'utf8');
    const crlfResult = importCaptureObject(crlfCapture, { name: 'crlf-input', fixtureRoot: temp.fixtures });
    const crlfScenario = JSON.parse(fs.readFileSync(path.join(crlfResult.target, 'scenario.json'), 'utf8'));
    const normalizedInput = fs.readFileSync(path.join(crlfResult.target, 'input', 'artifact-001.json'), 'utf8');
    assert(!normalizedInput.includes('\r'));
    assert.strictEqual(crlfScenario.artifacts.ARTIFACT_1.byteLength, Buffer.byteLength(normalizedInput, 'utf8'));
    const truncated = capture();
    truncated.capture.truncated = true;
    assert.throws(() => importCaptureObject(truncated, { name: 'truncated', fixtureRoot: temp.fixtures }), /Truncated captures/);
    assert.throws(() => verifyFixture(result.target, { fixtureRoot: temp.fixtures }), /have not been reviewed/);
  } finally {
    fs.rmSync(temp.root, { recursive: true, force: true });
  }
});

test('reviewed imports verify offline and verify-all discovers them', () => {
  const temp = temporaryRoot();
  try {
    const result = importCaptureObject(capture(), { name: 'reviewed-case', fixtureRoot: temp.fixtures });
    writeJson(path.join(result.target, 'expected.json'), {
      schemaVersion: 1,
      reviewed: true,
      assertions: { filename: 'SHOW_001.S01E01' }
    });
    const summary = verifyFixture(result.target, { fixtureRoot: temp.fixtures });
    assert.strictEqual(summary.reviewed, true);
    assert.deepStrictEqual(verifyAll(temp.fixtures).map(item => `${item.service}/${item.name}`), ['disney/reviewed-case']);
  } finally {
    fs.rmSync(temp.root, { recursive: true, force: true });
  }
});

test('artifact-free imports retain an input directory when committed', () => {
  const temp = temporaryRoot();
  try {
    const withoutArtifacts = capture({ artifacts: {} });
    const result = importCaptureObject(withoutArtifacts, { name: 'event-only', fixtureRoot: temp.fixtures });
    assert(fs.existsSync(path.join(result.target, 'input', '.gitkeep')));
    writeJson(path.join(result.target, 'expected.json'), { schemaVersion: 1, reviewed: true, assertions: {} });
    assert.doesNotThrow(() => verifyFixture(result.target, { fixtureRoot: temp.fixtures }));
  } finally {
    fs.rmSync(temp.root, { recursive: true, force: true });
  }
});

test('repository verification rejects input traversal and unreferenced files', () => {
  const temp = temporaryRoot();
  try {
    const result = importCaptureObject(capture(), { name: 'unsafe-path', fixtureRoot: temp.fixtures });
    writeJson(path.join(result.target, 'expected.json'), { schemaVersion: 1, reviewed: true, assertions: {} });
    const scenarioPath = path.join(result.target, 'scenario.json');
    const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
    scenario.artifacts.ARTIFACT_1.input = '../outside.json';
    writeJson(scenarioPath, scenario);
    assert.throws(() => verifyFixture(result.target, { fixtureRoot: temp.fixtures }), error => {
      return error instanceof FixtureValidationError && error.issues.some(issue => /safe flat path/.test(issue.message));
    });

    scenario.artifacts.ARTIFACT_1.input = 'input/artifact-001.json';
    writeJson(scenarioPath, scenario);
    fs.writeFileSync(path.join(result.target, 'input', 'unreferenced.txt'), 'unused');
    assert.throws(() => verifyFixture(result.target, { fixtureRoot: temp.fixtures }), /not referenced/);
  } finally {
    fs.rmSync(temp.root, { recursive: true, force: true });
  }
});

test('committed synthetic fixtures and public CLI commands verify successfully', () => {
  const fixture = path.join(ROOT, 'fixtures', 'disney', 'synthetic-metadata');
  const playbackFixture = path.join(ROOT, 'fixtures', 'disney', 'playback-response-episode');
  assert.doesNotThrow(() => verifyFixture(fixture));
  assert.doesNotThrow(() => verifyFixture(playbackFixture));
  const verifyOutput = childProcess.execFileSync(process.execPath, ['tools/fixture.js', 'verify', 'fixtures/disney/synthetic-metadata'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  assert(verifyOutput.includes('safe, valid, and reviewed'));
  const allOutput = childProcess.execFileSync(process.execPath, ['tools/fixture.js', 'verify-all'], { cwd: ROOT, encoding: 'utf8' });
  assert.match(allOutput, /verified \d+ reviewed repository fixtures?/);
});

test('capture-facing CLI reports structure but never captured values', () => {
  const temp = temporaryRoot();
  try {
    const capturePath = path.join(temp.root, 'capture.fixture.json');
    writeJson(capturePath, capture());
    const inspectOutput = childProcess.execFileSync(process.execPath, ['tools/fixture.js', 'inspect', capturePath], {
      cwd: ROOT,
      encoding: 'utf8'
    });
    assert(inspectOutput.includes('"safeForImport": true'));
    assert(!inspectOutput.includes('SHOW_001'));
    const verifyOutput = childProcess.execFileSync(process.execPath, ['tools/fixture.js', 'verify-capture', capturePath], {
      cwd: ROOT,
      encoding: 'utf8'
    });
    assert(verifyOutput.includes('capture is safe and valid'));

    const unsafe = capture();
    unsafe.events[0].data.token = 'do-not-print-this-secret';
    writeJson(capturePath, unsafe);
    const failed = childProcess.spawnSync(process.execPath, ['tools/fixture.js', 'inspect', capturePath], {
      cwd: ROOT,
      encoding: 'utf8'
    });
    assert.strictEqual(failed.status, 1);
    assert(!`${failed.stdout}${failed.stderr}`.includes('do-not-print-this-secret'));

    const truncated = capture();
    truncated.capture.truncated = true;
    writeJson(capturePath, truncated);
    const truncatedInspect = childProcess.spawnSync(process.execPath, ['tools/fixture.js', 'inspect', capturePath], {
      cwd: ROOT,
      encoding: 'utf8'
    });
    assert.strictEqual(truncatedInspect.status, 1);
    assert(truncatedInspect.stdout.includes('"safeForImport": false'));
    const truncatedVerify = childProcess.spawnSync(process.execPath, ['tools/fixture.js', 'verify-capture', capturePath], {
      cwd: ROOT,
      encoding: 'utf8'
    });
    assert.strictEqual(truncatedVerify.status, 1);
    assert(truncatedVerify.stderr.includes('truncated and cannot be imported'));

    fs.writeFileSync(capturePath, '{"secret":"DO_NOT_ECHO", broken}');
    const invalidJson = childProcess.spawnSync(process.execPath, ['tools/fixture.js', 'inspect', capturePath], {
      cwd: ROOT,
      encoding: 'utf8'
    });
    assert.strictEqual(invalidJson.status, 1);
    assert(!`${invalidJson.stdout}${invalidJson.stderr}`.includes('DO_NOT_ECHO'));
  } finally {
    fs.rmSync(temp.root, { recursive: true, force: true });
  }
});

test('shared browser capture output imports through the repository schema', () => {
  const source = fs.readFileSync(path.join(ROOT, 'shared', 'fixture-capture.template.js'), 'utf8');
  const sandbox = { URL, Blob, Date, JSON, Object, Array, String, Number, Math, RegExp, isFinite };
  vm.createContext(sandbox);
  vm.runInContext(`${source}\nthis.createFixtureCapture = createFixtureCapture;`, sandbox);
  let now = 1000;
  const browserCapture = sandbox.createFixtureCapture({
    service: 'disney',
    scriptVersion: 'integration',
    page: { host: 'www.disneyplus.com', path: '/play/12345678901234567890' },
    now: () => now
  });
  assert.strictEqual(browserCapture.start(), true);
  browserCapture.event('metadata.accepted', { title: 'SHOW_001' }, { session: 'real-session' });
  browserCapture.artifact('metadata', '{"title":"SHOW_001"}', {
    format: 'json',
    url: 'https://disney.api.edge.bamgrid.com/12345678901234567890/metadata',
    source: 'network'
  });
  now = 1500;
  browserCapture.stop({ filename: 'SHOW_001.S01E01' });
  const output = clone(browserCapture.exportObject());
  assert.doesNotThrow(() => verifyCaptureObject(output));

  const temp = temporaryRoot();
  try {
    const imported = importCaptureObject(output, { name: 'capture-integration', fixtureRoot: temp.fixtures });
    const scenario = JSON.parse(fs.readFileSync(path.join(imported.target, 'scenario.json'), 'utf8'));
    assert.strictEqual(scenario.artifacts.ARTIFACT_1.metadata.source, 'network');
  } finally {
    fs.rmSync(temp.root, { recursive: true, force: true });
  }
});

console.log(`fixture tooling tests passed: ${passed}`);
