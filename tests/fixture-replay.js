'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { verifyAll } = require('../tools/fixture-lib/verifier');

const ROOT = path.resolve(__dirname, '..');
const APPLE_SOURCE = fs.readFileSync(path.join(ROOT, 'scripts', 'apple-tv-plus-subtitles-downloader.user.js'), 'utf8');
const COUPANG_SOURCE = fs.readFileSync(path.join(ROOT, 'scripts', 'coupang-play-subtitles-downloader.user.js'), 'utf8');
const DISNEY_SOURCE = fs.readFileSync(path.join(ROOT, 'scripts', 'disney-plus-subtitles-downloader.user.js'), 'utf8');

function functionDeclaration(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0, `${name} not found in the selected userscript`);
  const next = source.indexOf('\n    function ', start + 1);
  return source.slice(start, next >= 0 ? next : source.length);
}

function appleMetadataRuntime() {
  const names = [
    'extractMetadataFromText',
    'collectMetadataFromJson',
    'isGenericMediaTitle',
    'shouldReplaceMediaTitle',
    'updateMediaMetadata',
    'cleanDisplayTitle',
    'seasonEpisodeTag',
    'formatSeasonEpisode',
    'padNumber',
    'sanitizeFilename',
    'safeBaseFilename'
  ];
  const context = {};
  vm.createContext(context);
  vm.runInContext(names.map(name => functionDeclaration(APPLE_SOURCE, name)).join('\n'), context);
  return context;
}

function disneyMetadataRuntime() {
  const names = [
    'extractMetadataFromText',
    'collectMetadataFromJson',
    'seasonEpisodeTag',
    'episodeTagFromMetadata',
    'isTrustedDisneyPlaybackMetadataUrl',
    'rememberPlaybackResponseMetadata',
    'resolvePendingPlaybackMetadata',
    'acceptPlaybackMetadata',
    'isPlaybackMetadataReady',
    'updateMediaMetadata',
    'cleanDisplayTitle',
    'formatSeasonEpisode',
    'padNumber',
    'formatMediaBaseFilename',
    'sanitizeFilename',
    'normalizeUrl',
    'normalizedMediaTitleForComparison',
    'mediaTitlesMatch'
  ];
  const context = { URL };
  vm.createContext(context);
  vm.runInContext(names.map(name => functionDeclaration(DISNEY_SOURCE, name)).join('\n'), context);
  return context;
}

function coupangMetadataRuntime() {
  const names = [
    'mergeEpisodeObjectMetadata',
    'episodeMetadataFromTitle',
    'isUsableMetadataLine',
    'isPlaybackTimeText',
    'cleanDisplayTitle',
    'seasonEpisodeNumbers',
    'formatSeasonEpisodeTag',
    'parseOptionalNumber',
    'uniqueFilenameParts',
    'sanitizeFilename',
    'pad2'
  ];
  const context = {};
  vm.createContext(context);
  vm.runInContext(names.map(name => functionDeclaration(COUPANG_SOURCE, name)).join('\n'), context);
  return context;
}

const replayDrivers = {
  'apple-metadata-v1': (inputText) => {
    const runtime = appleMetadataRuntime();
    runtime.state = {
      playbackSessionId: 'SESSION_1',
      mediaTitle: '', mediaTitlePriority: 0,
      seasonNumber: null, episodeNumber: null, episodeTag: ''
    };
    runtime.captureAppleSnapshot = () => false;
    runtime.fixtureMetadataState = () => ({});
    runtime.activePlaybackTitle = () => '';
    runtime.activePlaybackInfoText = () => '';
    runtime.playbackInfoText = () => '';
    runtime.refreshMediaMetadataFromDom = () => {};
    runtime.displayTitle = () => runtime.state.mediaTitle || 'AppleTVPlus';

    const extracted = runtime.extractMetadataFromText(inputText);
    runtime.updateMediaMetadata(extracted, 3);
    return {
      metadata: {
        title: runtime.state.mediaTitle,
        season: runtime.state.seasonNumber,
        episode: runtime.state.episodeNumber,
        episodeTag: runtime.state.episodeTag
      },
      filename: runtime.safeBaseFilename()
    };
  },
  'coupang-metadata-v1': (inputText) => {
    const runtime = coupangMetadataRuntime();
    const input = JSON.parse(inputText);
    const metadata = {
      title: input.series && input.series.title || '',
      seasonNumber: null,
      episodeNumber: null,
      episodeTitle: '',
      episodeConfirmed: false
    };
    runtime.mergeEpisodeObjectMetadata(input.episode, metadata);
    const episodeTag = runtime.formatSeasonEpisodeTag(metadata.seasonNumber, metadata.episodeNumber);
    return {
      metadata: {
        title: metadata.title,
        season: metadata.seasonNumber,
        episode: metadata.episodeNumber,
        episodeTag
      },
      filename: runtime.sanitizeFilename(runtime.uniqueFilenameParts([
        metadata.title,
        episodeTag,
        metadata.episodeTitle
      ]).join('.'))
    };
  },
  'disney-metadata-v1': (inputText) => {
    const runtime = disneyMetadataRuntime();
    const extracted = runtime.extractMetadataFromText(inputText);
    runtime.state = {
      mediaTitle: '', seasonNumber: null, episodeNumber: null,
      episodeTag: '', episodeMetadataTitle: ''
    };
    runtime.updateMediaMetadata(extracted);
    const title = runtime.state.mediaTitle;
    const season = runtime.state.seasonNumber;
    const episode = runtime.state.episodeNumber;
    return {
      metadata: { title, season, episode },
      filename: runtime.formatMediaBaseFilename(title, runtime.state.episodeTag)
    };
  },
  'disney-playback-resolution-v1': (inputText, scenario) => {
    const runtime = disneyMetadataRuntime();
    const activeSnapshot = (scenario.snapshots || []).find(snapshot => snapshot.kind === 'active-player');
    assert(activeSnapshot && activeSnapshot.data && activeSnapshot.data.title, 'active-player snapshot title is required');
    runtime.state = {
      playbackSessionId: 'SESSION_1',
      mediaTitle: '', seasonNumber: null, episodeNumber: null,
      episodeTag: '', episodeMetadataTitle: '', mediaKind: 'unknown',
      metadataReady: false, metadataSource: '', pendingEpisodeTag: '',
      playbackMetadataResponseSeen: false, playbackMetadataUnresolvedLogged: false
    };
    runtime.fixtureCaptureRecording = false;
    runtime.isPlaybackSessionCurrent = session => session === runtime.state.playbackSessionId;
    runtime.isPlaybackMetadataSettling = () => false;
    runtime.activePlaybackContainer = () => ({ current: true });
    runtime.activePlaybackTitle = () => activeSnapshot.data.title;
    runtime.captureDisney = () => true;
    runtime.cancelPlaybackMetadataSettling = () => {};
    runtime.restartPlaybackSessionForMetadataChange = () => runtime.state.playbackSessionId;

    const extracted = runtime.extractMetadataFromText(inputText);
    const inputArtifact = scenario.artifacts[scenario.replay.input];
    runtime.rememberPlaybackResponseMetadata(extracted, runtime.state.playbackSessionId, inputArtifact.url);
    return {
      metadata: {
        title: runtime.state.mediaTitle,
        episodeTag: runtime.state.episodeTag,
        mediaKind: runtime.state.mediaKind,
        ready: runtime.isPlaybackMetadataReady()
      },
      filename: runtime.formatMediaBaseFilename(runtime.state.mediaTitle, runtime.state.episodeTag)
    };
  }
};

let replayed = 0;
for (const summary of verifyAll()) {
  const scenario = JSON.parse(fs.readFileSync(path.join(summary.path, 'scenario.json'), 'utf8'));
  if (!scenario.replay) continue;

  const driver = replayDrivers[scenario.replay.driver];
  assert(driver, `${scenario.service}/${scenario.name}: unsupported replay driver ${scenario.replay.driver}`);
  const artifact = scenario.artifacts[scenario.replay.input];
  assert(artifact, `${scenario.service}/${scenario.name}: replay input artifact is missing`);
  const inputPath = path.resolve(summary.path, ...artifact.input.split('/'));
  const inputText = fs.readFileSync(inputPath, 'utf8');
  const expected = JSON.parse(fs.readFileSync(path.join(summary.path, 'expected.json'), 'utf8'));
  const actual = JSON.parse(JSON.stringify(driver(inputText, scenario)));

  assert.deepStrictEqual(actual, expected.assertions, `${scenario.service}/${scenario.name}: replay result differs from reviewed assertions`);
  replayed++;
  console.log(`ok ${replayed} - ${scenario.service}/${scenario.name} (${scenario.replay.driver})`);
}

assert(replayed > 0, 'repository must contain at least one executable fixture');
console.log(`fixture replay tests passed: ${replayed}`);
