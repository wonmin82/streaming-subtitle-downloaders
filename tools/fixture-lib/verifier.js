'use strict';

const fs = require('fs');
const path = require('path');
const { FixtureValidationError, MAX_ARTIFACT_BYTES, SERVICES, isObject, validateCapture } = require('./schema');
const { securityIssues } = require('./guards');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_FIXTURE_ROOT = path.join(ROOT, 'fixtures');
const MAX_CAPTURE_FILE_BYTES = 25 * 1024 * 1024;

class FixtureSecurityError extends Error {
  constructor(message, issues) {
    super(message);
    this.name = 'FixtureSecurityError';
    this.issues = issues;
  }
}

function readJsonFile(file, maxBytes = MAX_CAPTURE_FILE_BYTES) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error(`${file}: not a regular file`);
  if (stat.size > maxBytes) throw new Error(`${file}: exceeds the ${maxBytes}-byte size limit`);
  const source = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${file}: invalid JSON`);
  }
}

function verifyCaptureObject(capture) {
  validateCapture(capture);
  const issues = securityIssues(capture);
  if (issues.length) throw new FixtureSecurityError('Capture failed the repository safety checks', issues);
  return capture;
}

function verifyCaptureFile(file) {
  return verifyCaptureObject(readJsonFile(path.resolve(file)));
}

function countBy(values, keyOf) {
  const counts = {};
  for (const value of values) {
    const key = keyOf(value);
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function inspectCapture(capture) {
  validateCapture(capture);
  const issues = securityIssues(capture);
  return {
    schemaVersion: capture.schemaVersion,
    service: capture.service,
    scriptVersion: capture.scriptVersion,
    captureToolVersion: capture.captureToolVersion,
    durationMs: capture.capture.durationMs,
    truncated: capture.capture.truncated,
    eventCount: capture.events.length,
    eventTypes: countBy(capture.events, event => event.type),
    snapshotCount: (capture.snapshots || []).length,
    snapshotKinds: countBy(capture.snapshots || [], snapshot => snapshot.kind),
    artifactCount: Object.keys(capture.artifacts).length,
    artifactKinds: countBy(Object.values(capture.artifacts), artifact => `${artifact.kind}/${artifact.format}`),
    observedKeys: Object.keys(capture.observed).sort(),
    redactions: capture.sanitization.redactions,
    warnings: capture.sanitization.warnings.length,
    safeForImport: capture.capture.truncated === false && issues.length === 0,
    guardIssues: issues.map(issue => ({ code: issue.code, path: issue.path, message: issue.message }))
  };
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertNoSymlink(file, label) {
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`${label}: symbolic links are not allowed`);
}

function safeFixtureDirectory(fixtureDir, fixtureRoot = DEFAULT_FIXTURE_ROOT) {
  const root = path.resolve(fixtureRoot);
  const candidate = path.resolve(fixtureDir);
  if (!isInside(root, candidate) || candidate === root) throw new Error('Fixture path must be a scenario directory below fixtures/<service>/');
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`Fixture root does not exist: ${root}`);
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) throw new Error(`Fixture directory does not exist: ${candidate}`);

  assertNoSymlink(root, 'fixture root');
  const relativeParts = path.relative(root, candidate).split(path.sep);
  let current = root;
  for (const part of relativeParts) {
    current = path.join(current, part);
    assertNoSymlink(current, current);
  }
  const realRoot = fs.realpathSync(root);
  const realCandidate = fs.realpathSync(candidate);
  if (!isInside(realRoot, realCandidate)) throw new Error('Fixture path resolves outside the fixture root');
  return { root, candidate };
}

function assertRepositoryJsonShape(scenario, observed, expected, fixtureDir) {
  const issues = [];
  const push = (field, message) => issues.push({ path: field, message });
  if (!isObject(scenario)) push('scenario.json', 'must contain an object');
  if (!isObject(observed)) push('observed.json', 'must contain an object');
  if (!isObject(expected)) push('expected.json', 'must contain an object');
  if (issues.length) throw new FixtureValidationError('Invalid repository fixture', issues);

  if (scenario.schemaVersion !== 1) push('scenario.json.schemaVersion', 'must equal 1');
  if (typeof scenario.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(scenario.name)) push('scenario.json.name', 'must be a lowercase slug');
  if (!SERVICES.has(scenario.service)) push('scenario.json.service', 'is not a supported service');
  if (!isObject(scenario.source)) push('scenario.json.source', 'must be an object');
  if (scenario.replay !== undefined) {
    if (!isObject(scenario.replay)) {
      push('scenario.json.replay', 'must be an object when present');
    } else {
      if (typeof scenario.replay.driver !== 'string' || !/^[a-z][a-z0-9-]{0,63}-v[1-9]\d*$/.test(scenario.replay.driver)) {
        push('scenario.json.replay.driver', 'must be a versioned lowercase driver name');
      }
      if (typeof scenario.replay.input !== 'string' || !/^ARTIFACT_[1-9]\d*$/.test(scenario.replay.input)) {
        push('scenario.json.replay.input', 'must reference an artifact ID');
      } else if (!isObject(scenario.artifacts) || !Object.prototype.hasOwnProperty.call(scenario.artifacts, scenario.replay.input)) {
        push('scenario.json.replay.input', 'must reference an artifact declared by scenario.json');
      }
    }
  }
  if (observed.schemaVersion !== 1 || !isObject(observed.result)) push('observed.json', 'must contain schemaVersion 1 and an object result');
  if (expected.schemaVersion !== 1 || typeof expected.reviewed !== 'boolean' || !isObject(expected.assertions)) {
    push('expected.json', 'must contain schemaVersion 1, a boolean reviewed field, and an assertions object');
  }

  const serviceDir = path.basename(path.dirname(fixtureDir));
  const fixtureName = path.basename(fixtureDir);
  if (scenario.service !== serviceDir) push('scenario.json.service', 'must match the parent service directory');
  if (scenario.name !== fixtureName) push('scenario.json.name', 'must match the fixture directory name');
  if (issues.length) throw new FixtureValidationError('Invalid repository fixture', issues);
}

function readFixtureInputs(inputDir, scenarioArtifacts) {
  if (!fs.existsSync(inputDir) || !fs.statSync(inputDir).isDirectory()) throw new Error('Fixture must contain an input directory');
  assertNoSymlink(inputDir, 'input directory');
  if (!isObject(scenarioArtifacts)) throw new FixtureValidationError('Invalid repository fixture', [{ path: 'scenario.json.artifacts', message: 'must be an object' }]);

  const referenced = new Set();
  const artifacts = {};
  for (const [id, artifact] of Object.entries(scenarioArtifacts)) {
    if (!isObject(artifact)) throw new FixtureValidationError('Invalid repository fixture', [{ path: `scenario.json.artifacts.${id}`, message: 'must be an object' }]);
    if (typeof artifact.input !== 'string' || !/^input\/[a-z0-9][a-z0-9._-]{0,127}$/.test(artifact.input)) {
      throw new FixtureValidationError('Invalid repository fixture', [{ path: `scenario.json.artifacts.${id}.input`, message: 'must be a safe flat path below input/' }]);
    }
    const file = path.resolve(path.dirname(inputDir), ...artifact.input.split('/'));
    if (!isInside(inputDir, file)) throw new Error(`${artifact.input}: resolves outside the input directory`);
    if (!fs.existsSync(file)) throw new Error(`${artifact.input}: referenced input file does not exist`);
    assertNoSymlink(file, artifact.input);
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error(`${artifact.input}: input must be a regular file`);
    if (stat.size > MAX_ARTIFACT_BYTES) throw new Error(`${artifact.input}: exceeds the ${MAX_ARTIFACT_BYTES}-byte artifact limit`);
    const text = fs.readFileSync(file, 'utf8');
    referenced.add(path.basename(file));
    artifacts[id] = { ...artifact, text };
    delete artifacts[id].input;
  }

  for (const entry of fs.readdirSync(inputDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`input/${entry.name}: only regular files are allowed`);
    if (entry.name === '.gitkeep' && referenced.size === 0 && fs.statSync(path.join(inputDir, entry.name)).size === 0) continue;
    if (!referenced.has(entry.name)) throw new Error(`input/${entry.name}: input file is not referenced by scenario.json`);
  }
  return artifacts;
}

function verifyFixture(fixtureDir, options = {}) {
  const fixtureRoot = options.fixtureRoot || DEFAULT_FIXTURE_ROOT;
  const requireReviewed = options.requireReviewed !== false;
  const safe = safeFixtureDirectory(fixtureDir, fixtureRoot);
  const allowedEntries = new Set(['scenario.json', 'observed.json', 'expected.json', 'input']);
  for (const entry of fs.readdirSync(safe.candidate, { withFileTypes: true })) {
    if (!allowedEntries.has(entry.name)) throw new Error(`${entry.name}: unexpected file in fixture directory`);
    if (entry.isSymbolicLink()) throw new Error(`${entry.name}: symbolic links are not allowed`);
  }
  const scenarioPath = path.join(safe.candidate, 'scenario.json');
  const observedPath = path.join(safe.candidate, 'observed.json');
  const expectedPath = path.join(safe.candidate, 'expected.json');
  for (const file of [scenarioPath, observedPath, expectedPath]) {
    if (!fs.existsSync(file)) throw new Error(`${path.basename(file)} is required`);
    assertNoSymlink(file, path.basename(file));
  }

  const scenario = readJsonFile(scenarioPath);
  const observed = readJsonFile(observedPath);
  const expected = readJsonFile(expectedPath);
  assertRepositoryJsonShape(scenario, observed, expected, safe.candidate);
  if (requireReviewed && expected.reviewed !== true) {
    throw new FixtureValidationError('Fixture expectations have not been reviewed', [{ path: 'expected.json.reviewed', message: 'must be true before committing the fixture' }]);
  }

  const artifacts = readFixtureInputs(path.join(safe.candidate, 'input'), scenario.artifacts);
  const captureShape = {
    schemaVersion: scenario.schemaVersion,
    captureToolVersion: scenario.source.captureToolVersion,
    service: scenario.service,
    scriptVersion: scenario.source.scriptVersion,
    page: scenario.page,
    capture: scenario.capture,
    events: scenario.events,
    snapshots: scenario.snapshots || [],
    artifacts,
    observed: observed.result,
    sanitization: scenario.source.sanitization
  };
  validateCapture(captureShape);
  if (captureShape.capture.truncated) {
    throw new FixtureValidationError('Truncated captures cannot be repository regression fixtures', [{ path: 'scenario.json.capture.truncated', message: 'must be false' }]);
  }

  const issues = securityIssues({ scenario, observed, expected }, { artifacts });
  if (issues.length) throw new FixtureSecurityError('Repository fixture failed the safety checks', issues);

  return {
    service: scenario.service,
    name: scenario.name,
    reviewed: expected.reviewed,
    eventCount: scenario.events.length,
    artifactCount: Object.keys(artifacts).length,
    path: safe.candidate
  };
}

function verifyAll(fixtureRoot = DEFAULT_FIXTURE_ROOT) {
  const root = path.resolve(fixtureRoot);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`Fixture root does not exist: ${root}`);
  assertNoSymlink(root, 'fixture root');
  const summaries = [];
  for (const serviceEntry of fs.readdirSync(root, { withFileTypes: true })) {
    if (serviceEntry.name === 'README.md') continue;
    if (serviceEntry.isSymbolicLink() || !serviceEntry.isDirectory()) throw new Error(`fixtures/${serviceEntry.name}: unexpected entry`);
    if (!SERVICES.has(serviceEntry.name)) throw new Error(`fixtures/${serviceEntry.name}: unsupported service directory`);
    const serviceDir = path.join(root, serviceEntry.name);
    for (const fixtureEntry of fs.readdirSync(serviceDir, { withFileTypes: true })) {
      if (fixtureEntry.isSymbolicLink() || !fixtureEntry.isDirectory()) throw new Error(`fixtures/${serviceEntry.name}/${fixtureEntry.name}: unexpected entry`);
      summaries.push(verifyFixture(path.join(serviceDir, fixtureEntry.name), { fixtureRoot: root }));
    }
  }
  return summaries;
}

module.exports = {
  DEFAULT_FIXTURE_ROOT,
  FixtureSecurityError,
  inspectCapture,
  isInside,
  readJsonFile,
  safeFixtureDirectory,
  verifyAll,
  verifyCaptureFile,
  verifyCaptureObject,
  verifyFixture
};
