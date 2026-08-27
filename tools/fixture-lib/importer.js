'use strict';

const fs = require('fs');
const path = require('path');
const { DEFAULT_FIXTURE_ROOT, isInside, verifyCaptureFile, verifyCaptureObject } = require('./verifier');

const FORMAT_EXTENSIONS = {
  hls: 'm3u8', m3u8: 'm3u8', dash: 'mpd', mpd: 'mpd', json: 'json',
  vtt: 'vtt', webvtt: 'vtt', srt: 'srt', ttml: 'ttml', dfxp: 'ttml', imsc: 'ttml',
  xml: 'xml', html: 'html', text: 'txt', txt: 'txt'
};

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function safeName(name) {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
    throw new Error('Fixture name must be a 1-64 character lowercase slug using only a-z, 0-9, and hyphens');
  }
  return name;
}

function artifactExtension(artifact) {
  return FORMAT_EXTENSIONS[String(artifact.format || '').toLowerCase()] || 'txt';
}

function normalizeLf(value) {
  return String(value).replace(/\r\n?|\u2028|\u2029/g, '\n');
}

function buildImportFiles(capture, name) {
  const artifacts = {};
  const inputs = [];
  const sortedArtifacts = Object.entries(capture.artifacts).sort(([left], [right]) => {
    const leftNumber = Number(left.replace('ARTIFACT_', ''));
    const rightNumber = Number(right.replace('ARTIFACT_', ''));
    return leftNumber - rightNumber;
  });
  sortedArtifacts.forEach(([id, artifact], index) => {
    const filename = `artifact-${String(index + 1).padStart(3, '0')}.${artifactExtension(artifact)}`;
    const text = normalizeLf(artifact.text);
    artifacts[id] = {
      kind: artifact.kind,
      format: artifact.format,
      ...(artifact.url === undefined ? {} : { url: artifact.url }),
      ...(artifact.metadata === undefined ? {} : { metadata: artifact.metadata }),
      byteLength: Buffer.byteLength(text, 'utf8'),
      input: `input/${filename}`
    };
    inputs.push({ filename, text });
  });

  return {
    scenario: {
      schemaVersion: 1,
      name,
      service: capture.service,
      source: {
        captureToolVersion: capture.captureToolVersion,
        scriptVersion: capture.scriptVersion,
        sanitization: capture.sanitization
      },
      page: capture.page,
      capture: capture.capture,
      events: capture.events,
      snapshots: capture.snapshots || [],
      artifacts
    },
    observed: {
      schemaVersion: 1,
      result: capture.observed
    },
    expected: {
      schemaVersion: 1,
      reviewed: false,
      assertions: {}
    },
    inputs
  };
}

function importCaptureObject(capture, options) {
  verifyCaptureObject(capture);
  const name = safeName(options && options.name);
  const fixtureRoot = path.resolve((options && options.fixtureRoot) || DEFAULT_FIXTURE_ROOT);
  if (capture.capture.truncated) throw new Error('Truncated captures cannot be imported as repository fixtures');
  if (!fs.existsSync(fixtureRoot)) fs.mkdirSync(fixtureRoot, { recursive: true });
  if (!fs.statSync(fixtureRoot).isDirectory()) throw new Error(`Fixture root is not a directory: ${fixtureRoot}`);
  if (fs.lstatSync(fixtureRoot).isSymbolicLink()) throw new Error('Fixture root must not be a symbolic link');

  const serviceDir = path.join(fixtureRoot, capture.service);
  fs.mkdirSync(serviceDir, { recursive: true });
  if (fs.lstatSync(serviceDir).isSymbolicLink() || !isInside(fs.realpathSync(fixtureRoot), fs.realpathSync(serviceDir))) {
    throw new Error('Service fixture directory must stay inside the fixture root');
  }
  const target = path.join(serviceDir, name);
  try {
    fs.lstatSync(target);
    throw new Error(`Refusing to overwrite existing fixture: ${target}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const files = buildImportFiles(capture, name);
  const staging = fs.mkdtempSync(path.join(serviceDir, '.fixture-import-'));
  try {
    const inputDir = path.join(staging, 'input');
    fs.mkdirSync(inputDir);
    fs.writeFileSync(path.join(staging, 'scenario.json'), jsonText(files.scenario), { flag: 'wx' });
    fs.writeFileSync(path.join(staging, 'observed.json'), jsonText(files.observed), { flag: 'wx' });
    fs.writeFileSync(path.join(staging, 'expected.json'), jsonText(files.expected), { flag: 'wx' });
    for (const input of files.inputs) fs.writeFileSync(path.join(inputDir, input.filename), input.text, { flag: 'wx' });
    if (!files.inputs.length) fs.writeFileSync(path.join(inputDir, '.gitkeep'), '', { flag: 'wx' });
    fs.renameSync(staging, target);
    return { target, service: capture.service, name, artifactCount: files.inputs.length };
  } catch (error) {
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function importCaptureFile(file, options) {
  return importCaptureObject(verifyCaptureFile(file), options);
}

module.exports = {
  buildImportFiles,
  importCaptureFile,
  importCaptureObject,
  safeName
};
