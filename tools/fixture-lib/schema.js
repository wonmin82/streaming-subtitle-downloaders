'use strict';

const SERVICES = new Set(['apple', 'disney', 'coupang', 'netflix']);
const MAX_EVENTS = 3000;
const MAX_SNAPSHOTS = 1000;
const MAX_ARTIFACTS = 200;
const MAX_ARTIFACT_BYTES = 1024 * 1024;

class FixtureValidationError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.name = 'FixtureValidationError';
    this.issues = issues;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function add(issues, path, message) {
  issues.push({ path, message });
}

function stringField(issues, value, path, options = {}) {
  if (typeof value !== 'string') {
    add(issues, path, 'must be a string');
    return;
  }
  const min = options.min === undefined ? 1 : options.min;
  const max = options.max === undefined ? 4096 : options.max;
  if (value.length < min || value.length > max) add(issues, path, `must contain ${min}-${max} characters`);
  if (options.pattern && !options.pattern.test(value)) add(issues, path, 'has an invalid format');
}

function numberField(issues, value, path, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
    add(issues, path, `must be a non-negative${integer ? ' integer' : ' number'}`);
  }
}

function objectField(issues, value, path) {
  if (!isObject(value)) {
    add(issues, path, 'must be an object');
    return false;
  }
  return true;
}

function validateJsonTree(value, issues, path = '$', state = { nodes: 0 }, depth = 0) {
  state.nodes++;
  if (state.nodes > 100000) {
    if (state.nodes === 100001) add(issues, path, 'contains too many values');
    return;
  }
  if (depth > 20) {
    add(issues, path, 'is nested too deeply');
    return;
  }
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAX_ARTIFACT_BYTES) add(issues, path, 'contains an oversized string');
    return;
  }
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) add(issues, path, 'contains a non-finite number');
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) validateJsonTree(value[index], issues, `${path}[${index}]`, state, depth + 1);
    return;
  }
  if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) validateJsonTree(child, issues, `${path}.${key}`, state, depth + 1);
    return;
  }
  add(issues, path, 'contains a non-JSON value');
}

function validateTimelineEntry(entry, path, issues, seenSequences) {
  if (!objectField(issues, entry, path)) return;
  numberField(issues, entry.seq, `${path}.seq`, true);
  if (Number.isInteger(entry.seq) && entry.seq > 0) {
    if (seenSequences.has(entry.seq)) add(issues, `${path}.seq`, 'must be unique across events and snapshots');
    seenSequences.add(entry.seq);
  } else if (entry.seq === 0) {
    add(issues, `${path}.seq`, 'must be greater than zero');
  }
  numberField(issues, entry.t, `${path}.t`);
  if (entry.session !== undefined) stringField(issues, entry.session, `${path}.session`, { pattern: /^SESSION_[1-9]\d*$/, max: 32 });
  if (!objectField(issues, entry.data, `${path}.data`)) return;
  validateJsonTree(entry.data, issues, `${path}.data`);
}

function validateCapture(capture) {
  const issues = [];
  if (!objectField(issues, capture, '$')) throw new FixtureValidationError('Invalid capture schema', issues);

  if (capture.schemaVersion !== 1) add(issues, '$.schemaVersion', 'must equal 1');
  stringField(issues, capture.captureToolVersion, '$.captureToolVersion', { max: 64 });
  stringField(issues, capture.service, '$.service', { pattern: /^(apple|disney|coupang|netflix)$/, max: 16 });
  if (typeof capture.service === 'string' && !SERVICES.has(capture.service)) add(issues, '$.service', 'is not a supported service');
  stringField(issues, capture.scriptVersion, '$.scriptVersion', { max: 64 });

  if (objectField(issues, capture.page, '$.page')) {
    stringField(issues, capture.page.host, '$.page.host', { pattern: /^[A-Za-z0-9.-]+(?::\d{1,5})?$/, max: 253 });
    stringField(issues, capture.page.path, '$.page.path', { pattern: /^\/[^?#]*$/, max: 2048 });
  }

  if (objectField(issues, capture.capture, '$.capture')) {
    if (capture.capture.startedAt !== undefined) {
      stringField(issues, capture.capture.startedAt, '$.capture.startedAt', { max: 64 });
      if (typeof capture.capture.startedAt === 'string' && !Number.isFinite(Date.parse(capture.capture.startedAt))) {
        add(issues, '$.capture.startedAt', 'must be an ISO-compatible timestamp');
      }
    }
    numberField(issues, capture.capture.durationMs, '$.capture.durationMs');
    if (typeof capture.capture.truncated !== 'boolean') add(issues, '$.capture.truncated', 'must be a boolean');
    if (capture.capture.limits !== undefined && objectField(issues, capture.capture.limits, '$.capture.limits')) {
      for (const [key, value] of Object.entries(capture.capture.limits)) numberField(issues, value, `$.capture.limits.${key}`, true);
    }
  }

  const seenSequences = new Set();
  if (!Array.isArray(capture.events)) {
    add(issues, '$.events', 'must be an array');
  } else {
    if (capture.events.length > MAX_EVENTS) add(issues, '$.events', `must contain no more than ${MAX_EVENTS} entries`);
    let previous = 0;
    capture.events.forEach((event, index) => {
      const eventPath = `$.events[${index}]`;
      validateTimelineEntry(event, eventPath, issues, seenSequences);
      if (isObject(event)) {
        stringField(issues, event.type, `${eventPath}.type`, { pattern: /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/, max: 80 });
        if (Number.isInteger(event.seq) && event.seq <= previous) add(issues, `${eventPath}.seq`, 'must increase within the event array');
        if (Number.isInteger(event.seq)) previous = event.seq;
      }
    });
  }

  const snapshots = capture.snapshots === undefined ? [] : capture.snapshots;
  if (!Array.isArray(snapshots)) {
    add(issues, '$.snapshots', 'must be an array when present');
  } else {
    if (snapshots.length > MAX_SNAPSHOTS) add(issues, '$.snapshots', `must contain no more than ${MAX_SNAPSHOTS} entries`);
    let previous = 0;
    snapshots.forEach((snapshot, index) => {
      const snapshotPath = `$.snapshots[${index}]`;
      validateTimelineEntry(snapshot, snapshotPath, issues, seenSequences);
      if (isObject(snapshot)) {
        stringField(issues, snapshot.kind, `${snapshotPath}.kind`, { pattern: /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/, max: 80 });
        if (Number.isInteger(snapshot.seq) && snapshot.seq <= previous) add(issues, `${snapshotPath}.seq`, 'must increase within the snapshot array');
        if (Number.isInteger(snapshot.seq)) previous = snapshot.seq;
      }
    });
  }

  if (!objectField(issues, capture.artifacts, '$.artifacts')) {
    // The object error is sufficient.
  } else {
    const artifacts = Object.entries(capture.artifacts);
    if (artifacts.length > MAX_ARTIFACTS) add(issues, '$.artifacts', `must contain no more than ${MAX_ARTIFACTS} entries`);
    for (const [id, artifact] of artifacts) {
      const artifactPath = `$.artifacts.${id}`;
      if (!/^ARTIFACT_[1-9]\d*$/.test(id)) add(issues, artifactPath, 'has an invalid artifact ID');
      if (!objectField(issues, artifact, artifactPath)) continue;
      stringField(issues, artifact.kind, `${artifactPath}.kind`, { pattern: /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/, max: 80 });
      stringField(issues, artifact.format, `${artifactPath}.format`, { pattern: /^[a-z0-9][a-z0-9.+-]*$/, max: 32 });
      if (artifact.url !== undefined) stringField(issues, artifact.url, `${artifactPath}.url`, { pattern: /^https?:\/\//i, max: 4096 });
      if (artifact.metadata !== undefined && objectField(issues, artifact.metadata, `${artifactPath}.metadata`)) {
        validateJsonTree(artifact.metadata, issues, `${artifactPath}.metadata`);
      }
      stringField(issues, artifact.text, `${artifactPath}.text`, { min: 0, max: MAX_ARTIFACT_BYTES });
      numberField(issues, artifact.byteLength, `${artifactPath}.byteLength`, true);
      if (typeof artifact.text === 'string') {
        const actualLength = Buffer.byteLength(artifact.text, 'utf8');
        if (actualLength > MAX_ARTIFACT_BYTES) add(issues, `${artifactPath}.text`, `must not exceed ${MAX_ARTIFACT_BYTES} bytes`);
        if (Number.isInteger(artifact.byteLength) && artifact.byteLength !== actualLength) {
          add(issues, `${artifactPath}.byteLength`, 'does not match the UTF-8 artifact size');
        }
      }
    }
  }

  if (objectField(issues, capture.observed, '$.observed')) validateJsonTree(capture.observed, issues, '$.observed');
  if (objectField(issues, capture.sanitization, '$.sanitization')) {
    if (capture.sanitization.version !== 1) add(issues, '$.sanitization.version', 'must equal 1');
    numberField(issues, capture.sanitization.redactions, '$.sanitization.redactions', true);
    if (!Array.isArray(capture.sanitization.warnings) || capture.sanitization.warnings.some(value => typeof value !== 'string')) {
      add(issues, '$.sanitization.warnings', 'must be an array of strings');
    }
  }

  if (issues.length) throw new FixtureValidationError('Invalid capture schema', issues);
  return capture;
}

module.exports = {
  FixtureValidationError,
  MAX_ARTIFACT_BYTES,
  SERVICES,
  isObject,
  validateCapture,
  validateJsonTree
};
