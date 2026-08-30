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
const NETFLIX_SOURCE = fs.readFileSync(path.join(ROOT, 'scripts', 'netflix-subtitles-downloader.user.js'), 'utf8');

function functionDeclaration(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0, `${name} not found in the selected userscript`);
  const next = source.indexOf('\n    function ', start + 1);
  return source.slice(start, next >= 0 ? next : source.length);
}

function constDeclaration(source, name) {
  const start = source.indexOf(`const ${name} =`);
  assert(start >= 0, `${name} not found in the selected userscript`);
  const next = source.indexOf('\nconst ', start + 1);
  return source.slice(start, next >= 0 ? next : source.length);
}

function netflixRuntime(names, extras) {
  const context = {...extras};
  vm.createContext(context);
  vm.runInContext(
    names.map(name => constDeclaration(NETFLIX_SOURCE, name)).join('\n') +
      `\nthis.__netflixRuntime = {${names.join(',')}};`,
    context
  );
  return {context, runtime: context.__netflixRuntime};
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

function appleHlsRuntime() {
  const names = [
    'extractHlsSegmentEntries', 'parseAttrList', 'parseHlsByteRange',
    'isSafeHlsByteInteger', 'resolveHlsByteRange', 'absoluteUrl',
    'createHlsTimestampState', 'normalizeHlsVttSegment', 'parseHlsTimestampMap',
    'normalizeHlsTimestampOffset', 'shiftHlsVttCueTimes', 'hlsTimestampSeconds',
    'formatHlsTimestamp', 'cleanVttSegment', 'hlsVttBlocks', 'isHlsVttCueBlock',
    'isHlsVttHeaderMetadataBlock', 'isInvisibleHlsVttCueBlock', 'uniqueHlsVttBody'
  ];
  const context = {URL};
  vm.createContext(context);
  vm.runInContext(names.map(name => functionDeclaration(APPLE_SOURCE, name)).join('\n'), context);
  return context;
}

function coupangEpisodeTrackRuntime() {
  const names = [
    'mergeEpisodeObjectMetadata', 'episodeMetadataFromTitle', 'isUsableMetadataLine',
    'isPlaybackTimeText', 'cleanDisplayTitle', 'seasonEpisodeNumbers',
    'formatSeasonEpisodeTag', 'parseOptionalNumber', 'uniqueFilenameParts',
    'sanitizeFilename', 'pad2', 'inferLanguage', 'normalizeLanguageCode',
    'isThumbnailTrack', 'isForcedTrack', 'isCcTrack'
  ];
  const context = {};
  vm.createContext(context);
  vm.runInContext(names.map(name => functionDeclaration(COUPANG_SOURCE, name)).join('\n'), context);
  return context;
}

function disneyHlsRuntime() {
  const names = ['parseManifest', 'parseAttrList', 'trackLabel', 'inferTrackName', 'inferLanguage', 'absoluteUrl'];
  const context = {URL};
  vm.createContext(context);
  vm.runInContext(names.map(name => functionDeclaration(DISNEY_SOURCE, name)).join('\n'), context);
  return context;
}

const replayDrivers = {
  'apple-hls-discontinuity-v1': (inputText) => {
    const runtime = appleHlsRuntime();
    const input = JSON.parse(inputText);
    const entries = runtime.extractHlsSegmentEntries(input.playlist, input.baseUrl);
    const timestampState = runtime.createHlsTimestampState();
    const seen = {};
    const bodies = [];
    for (const entry of entries) {
      const segmentText = input.segments[entry.url];
      assert.strictEqual(typeof segmentText, 'string', `missing synthetic segment ${entry.url}`);
      const normalized = runtime.normalizeHlsVttSegment(segmentText, timestampState, '', entry.discontinuityOffset);
      const unique = runtime.uniqueHlsVttBody(normalized, seen);
      if (unique) bodies.push(unique);
    }
    const output = bodies.join('\n\n');
    const cueStarts = Array.from(output.matchAll(/^\s*((?:\d{2,}:)?\d{2}:\d{2}\.\d{3})\s+-->/gm), match => match[1]);
    const cueSeconds = cueStarts.map(value => runtime.hlsTimestampSeconds(value));
    return {
      segmentCount: entries.length,
      discontinuityOffsets: entries.map(entry => entry.discontinuityOffset),
      cueStarts,
      cueCount: cueStarts.length,
      monotonic: cueSeconds.every((value, index) => index === 0 || value >= cueSeconds[index - 1]),
      containsInvisibleCue: output.indexOf('\u200B') >= 0
    };
  },
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
  'coupang-episode-track-v1': (inputText) => {
    const runtime = coupangEpisodeTrackRuntime();
    const input = JSON.parse(inputText);
    const metadata = {
      title: input.series.title,
      seasonNumber: null,
      episodeNumber: null,
      episodeTitle: '',
      episodeConfirmed: false
    };
    runtime.mergeEpisodeObjectMetadata(input.episode, metadata);
    const episodeTag = runtime.formatSeasonEpisodeTag(metadata.seasonNumber, metadata.episodeNumber);
    const tracks = input.tracks
      .filter(track => !runtime.isThumbnailTrack(track))
      .map(track => ({
        name: track.NAME,
        language: runtime.normalizeLanguageCode(track.LANGUAGE || runtime.inferLanguage(track.URI)),
        forced: runtime.isForcedTrack(track),
        cc: runtime.isCcTrack(track)
      }));
    return {
      filename: runtime.sanitizeFilename(runtime.uniqueFilenameParts([
        metadata.title, episodeTag, metadata.episodeTitle
      ]).join('.')),
      tracks,
      tldLanguage: runtime.inferLanguage(input.tldProbe)
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
  'disney-hls-language-pair-v1': (inputText) => {
    const runtime = disneyHlsRuntime();
    runtime.state = {langs: [], playbackSessionId: 'SESSION_1', status: ''};
    runtime.isPlaybackSessionCurrent = session => session === runtime.state.playbackSessionId;
    runtime.addTrack = track => runtime.state.langs.push(track);
    runtime.looksLikeSubtitlePlaylist = () => false;
    runtime.extractSegmentUrls = () => [];
    runtime.captureDisney = () => false;
    runtime.parseManifest('https://media.example.test/master.m3u8', inputText, runtime.state.playbackSessionId);
    const tracks = runtime.state.langs.map(track => ({
      language: track.LANGUAGE,
      forced: /^YES$/i.test(track.FORCED || ''),
      cc: /sdh|transcribes-spoken-dialog/i.test(track.CHARACTERISTICS || '')
    })).sort((left, right) => left.language.localeCompare(right.language));
    return {
      tracks,
      forcedTrackCount: tracks.filter(track => track.forced).length
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
  },
  'netflix-metadata-v1': (inputText) => {
    const input = JSON.parse(inputText);
    const menu = {
      classList: {
        add() {},
        remove() {}
      }
    };
    const {context, runtime} = netflixRuntime([
      'processMetadata',
      'normalizeDomTitle',
      'positiveInteger',
      'cleanEpisodeSubtitle',
      'pad',
      'safeTitle',
      'getTitleFromCache'
    ], {
      titleCache: {},
      domDerivedTitleIds: {},
      batchAll: null,
      batchSeason: null,
      batchToEnd: null,
      epTitleInFilename: false,
      fixtureCaptureRecording: false,
      ensureMenu: () => menu,
      syncPlaybackMetadataState: () => null,
      checkSubsCache: () => {},
      episodeNumberFromLabel: () => null,
      console: {debug() {}}
    });
    runtime.processMetadata(input);
    const current = input.video.type === 'show' ?
      context.titleCache[input.video.currentEpisode] : context.titleCache[input.video.id];
    const [filename] = runtime.getTitleFromCache(current);
    return {
      metadata: {
        title: current.title,
        season: current.season,
        episode: current.episode,
        subtitle: current.subtitle,
        hiddenNumber: current.hiddenNumber
      },
      filename,
      batch: {
        allCount: Array.isArray(context.batchAll) ? context.batchAll.length : 0,
        seasonCount: Array.isArray(context.batchSeason) ? context.batchSeason.length : 0,
        toEndCount: Array.isArray(context.batchToEnd) ? context.batchToEnd.length : 0
      }
    };
  },
  'netflix-subtitle-catalog-v1': (inputText) => {
    const input = JSON.parse(inputText);
    const WEBVTT = 'webvtt-lssdh-ios8';
    const DFXP = 'dfxp-ls-sdh';
    const SIMPLE = 'simplesdh';
    const IMSC1_1 = 'imsc1.1';
    const {context, runtime} = netflixRuntime([
      'processSubInfo',
      'isUsableFormatCandidate',
      'pickFormat'
    ], {
      SUB_TYPES: {subtitles: '', closedcaptions: '[cc]'},
      ALL_FORMATS: [IMSC1_1, DFXP, WEBVTT, SIMPLE],
      ALL_FORMATS_prefer_vtt: [WEBVTT, IMSC1_1, DFXP, SIMPLE],
      EXTENSIONS: {
        [WEBVTT]: 'vtt',
        [DFXP]: 'dfxp',
        [SIMPLE]: 'xml',
        [IMSC1_1]: 'xml'
      },
      WEBVTT,
      DFXP,
      subFormat: WEBVTT,
      subCache: {},
      fixtureCaptureRecording: false,
      handleSubsReady: () => false,
      ensureMenu: () => null,
      console: {log() {}},
      alert() { throw new Error('synthetic subtitle catalog must contain usable URLs'); }
    });
    runtime.processSubInfo(input);
    const subs = context.subCache[input.movieId];
    const tracks = Object.keys(subs).map(language => {
      const selected = runtime.pickFormat(subs[language]);
      const format = Object.keys(subs[language]).find(candidate => subs[language][candidate] === selected);
      return {
        language,
        format,
        extension: selected[1],
        mirrorCount: selected[0].length
      };
    }).sort((left, right) => left.language < right.language ? -1 : (left.language > right.language ? 1 : 0));
    return {tracks};
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
