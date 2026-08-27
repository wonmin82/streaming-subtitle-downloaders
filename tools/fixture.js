#!/usr/bin/env node
'use strict';

const path = require('path');
const { FixtureValidationError } = require('./fixture-lib/schema');
const { FixtureSecurityError, inspectCapture, readJsonFile, verifyAll, verifyCaptureFile, verifyFixture } = require('./fixture-lib/verifier');
const { importCaptureFile } = require('./fixture-lib/importer');

const USAGE = `Usage:
  node tools/fixture.js inspect <capture.fixture.json>
  node tools/fixture.js verify-capture <capture.fixture.json>
  node tools/fixture.js import <capture.fixture.json> --name <lowercase-slug>
  node tools/fixture.js verify <fixtures/service/name>
  node tools/fixture.js verify-all`;

function requiredArgument(args, index, label) {
  if (!args[index] || args[index].startsWith('--')) throw new Error(`${label} is required`);
  return args[index];
}

function importArguments(args) {
  const file = requiredArgument(args, 0, 'capture file');
  const nameIndex = args.indexOf('--name');
  if (nameIndex < 0 || !args[nameIndex + 1]) throw new Error('--name is required');
  const allowed = new Set([0, nameIndex, nameIndex + 1]);
  if (args.some((_, index) => !allowed.has(index))) throw new Error('Unexpected import argument');
  return { file, name: args[nameIndex + 1] };
}

function printIssues(error) {
  for (const issue of error.issues || []) console.error(`  ${issue.path}: ${issue.message}${issue.code ? ` [${issue.code}]` : ''}`);
}

function main(argv) {
  const [command, ...args] = argv;
  if (!command || command === '--help' || command === '-h') {
    console.log(USAGE);
    return;
  }

  if (command === 'inspect') {
    if (args.length !== 1) throw new Error('inspect requires exactly one capture file');
    const summary = inspectCapture(readJsonFile(path.resolve(args[0])));
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.safeForImport) process.exitCode = 1;
    return;
  }
  if (command === 'verify-capture') {
    if (args.length !== 1) throw new Error('verify-capture requires exactly one capture file');
    const capture = verifyCaptureFile(args[0]);
    if (capture.capture.truncated) throw new Error('Capture is truncated and cannot be imported');
    console.log(`capture is safe and valid: ${capture.service}, ${capture.events.length} events, ${Object.keys(capture.artifacts).length} artifacts`);
    return;
  }
  if (command === 'import') {
    const parsed = importArguments(args);
    const result = importCaptureFile(parsed.file, { name: parsed.name });
    console.log(`imported unreviewed fixture: ${path.relative(process.cwd(), result.target)}`);
    console.log('Review expected.json and set reviewed to true before committing.');
    return;
  }
  if (command === 'verify') {
    if (args.length !== 1) throw new Error('verify requires exactly one fixture directory');
    const summary = verifyFixture(args[0]);
    console.log(`fixture is safe, valid, and reviewed: ${summary.service}/${summary.name}`);
    return;
  }
  if (command === 'verify-all') {
    if (args.length) throw new Error('verify-all does not accept arguments');
    const summaries = verifyAll();
    console.log(`verified ${summaries.length} reviewed repository fixture${summaries.length === 1 ? '' : 's'}`);
    return;
  }
  throw new Error(`Unknown command: ${command}\n${USAGE}`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(`${error.name || 'Error'}: ${error.message}`);
  if (error instanceof FixtureValidationError || error instanceof FixtureSecurityError) printIssues(error);
  process.exitCode = 1;
}
