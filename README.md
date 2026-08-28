# Streaming Subtitle Downloaders

Tampermonkey userscripts for downloading subtitles from Apple TV+, Coupang Play, Disney+, and Netflix.

Each downloader runs in the streaming service's web player, detects subtitle resources for the active playback session, and saves subtitles through the browser. No separate desktop application or local server is required.

## Supported services

| Service | Userscript | Install |
| --- | --- | --- |
| Apple TV+ | [`apple-tv-plus-subtitles-downloader.user.js`](scripts/apple-tv-plus-subtitles-downloader.user.js) | [Install](https://raw.githubusercontent.com/wonmin82/streaming-subtitle-downloaders/main/scripts/apple-tv-plus-subtitles-downloader.user.js) |
| Coupang Play | [`coupang-play-subtitles-downloader.user.js`](scripts/coupang-play-subtitles-downloader.user.js) | [Install](https://raw.githubusercontent.com/wonmin82/streaming-subtitle-downloaders/main/scripts/coupang-play-subtitles-downloader.user.js) |
| Disney+ | [`disney-plus-subtitles-downloader.user.js`](scripts/disney-plus-subtitles-downloader.user.js) | [Install](https://raw.githubusercontent.com/wonmin82/streaming-subtitle-downloaders/main/scripts/disney-plus-subtitles-downloader.user.js) |
| Netflix | [`netflix-subtitles-downloader.user.js`](scripts/netflix-subtitles-downloader.user.js) | [Install](https://raw.githubusercontent.com/wonmin82/streaming-subtitle-downloaders/main/scripts/netflix-subtitles-downloader.user.js) |

## Features

### Apple TV+, Coupang Play, and Disney+

- Detect subtitle tracks associated with the current playback session.
- Select an individual track or download preferred English, Korean, English + Korean, or all detected tracks.
- Include associated forced tracks when the selected language provides them.
- Convert supported segmented subtitle formats to WebVTT and refuse to save incomplete downloads.
- Show the expected base filename without language or extension suffixes, plus segment-level download progress alongside track count, output format, status, and a manual playback-resource rescan.
- Build filenames from the active movie or show and add `SxxExx` when season and episode metadata is confirmed.

Coupang Play additionally supports its DASH/TTML subtitle path. Apple TV+, Coupang Play, and Disney+ share the generated HLS segment and byte-range parser maintained in [`shared/hls-segment-parser.template.js`](shared/hls-segment-parser.template.js).

### Netflix

- Download subtitles for the current movie or episode.
- For shows, batch-download from the current episode, the current season, or all available seasons.
- Configure languages, preferred locale, subtitle format, batch delay, and whether episode titles are included in filenames.
- Prefer WebVTT or XML-based Netflix subtitle variants, with fallback between available formats and mirrors.
- Read live player metadata when API metadata is unavailable or stale.
- Generate movie/show filenames and normalized TV episode names such as `Show.Title.S01E05` without duplicate episode labels.
- Show the expected base filename without the ZIP extension and progress for subtitle-track downloads and ZIP creation.

## Requirements

- A browser with Tampermonkey or another compatible userscript manager.
- An active account for the corresponding streaming service.
- Permission to play the content whose subtitles you want to download.
- Userscript permission to access the media hosts declared by each script's `@connect` metadata.

Apple TV+, Coupang Play, and Disney+ fetch subtitle manifests and segments from media CDN domains. If Tampermonkey asks whether the script may connect to those domains, allow the request for the downloader to work. Disney+ playback commonly uses `*.dssott.com` and `*.dssedge.com`.

## Installation

1. Install Tampermonkey or another compatible userscript manager.
2. Choose a service from the **Supported services** table and open its **Install** link.
3. Confirm the userscript installation.
4. Open or reload the corresponding streaming service.

To update an installed script, use the userscript manager's update command or reopen its **Install** link. Reload any already-open playback tab after updating.

## Usage

1. Start the movie or episode and wait for the web player to load.
2. Move the pointer to the top-center of the player to reveal the downloader menu.
3. Confirm the expected base filename in the menu, then choose the desired track or download action. Language and extension suffixes are added only to the downloaded file.
4. Follow the progress indicator while subtitle tracks or segments are downloaded.
5. Check the browser's configured download directory for the generated VTT or ZIP file.

For Apple TV+, Coupang Play, and Disney+, use **Rescan playback resources** if the player was already open before the script loaded or no tracks have appeared yet. On Netflix, keep the playback overlay loaded long enough for the current title, season, and episode metadata to appear before downloading.

Single-track downloads are normally saved as `.vtt`. A ZIP is used when an action produces multiple subtitle files, includes a matching forced track, or downloads a Netflix language set or episode batch.

## Filename conventions

- Movies use the detected playback title.
- TV episodes use the show title followed by a normalized season/episode tag such as `.S01E05`.
- A track suffix identifies the language and flags such as CC, SDH, or forced subtitles.
- Netflix can optionally append the episode title and uses a series-level archive name for multi-episode batches.

Filename characters that are unsafe on common desktop filesystems are sanitized before saving. The exact title and language labels depend on metadata supplied by the streaming service.

## Project structure

```text
streaming-subtitle-downloaders/
├── .github/
│   └── workflows/
│       └── regression.yml
├── docs/
│   └── fixture-capture.md
├── fixtures/
│   └── disney/
│       └── synthetic-metadata/
├── scripts/
│   ├── apple-tv-plus-subtitles-downloader.user.js
│   ├── coupang-play-subtitles-downloader.user.js
│   ├── disney-plus-subtitles-downloader.user.js
│   └── netflix-subtitles-downloader.user.js
├── shared/
│   ├── fixture-capture.template.js
│   └── hls-segment-parser.template.js
├── tests/
│   ├── fixture-capture-core.js
│   ├── fixture-capture-disney.js
│   ├── fixture-replay.js
│   ├── fixture-tooling.js
│   └── regression.js
├── tools/
│   ├── fixture-lib/
│   ├── fixture.js
│   ├── sync-fixture-capture.js
│   └── sync-hls-segment-parser.js
├── .gitattributes
├── .gitignore
└── README.md
```

## Runtime dependencies

The userscripts load their browser-side ZIP and file-saving dependencies through `@require` directives.

| Dependency | Version |
| --- | --- |
| JSZip | 3.7.1 |
| FileSaver | 2.0.5 |

No package installation is required to run the repository's current Node.js development tools and regression suite.

## Development and validation

Node.js is required for the repository tools and tests. Before submitting a change, run:

```bash
node tools/sync-hls-segment-parser.js --check
node tools/sync-fixture-capture.js --check
for file in scripts/*.user.js; do node --check "$file"; done
node tests/regression.js
node tests/fixture-capture-core.js
node tests/fixture-capture-disney.js
node tests/fixture-tooling.js
node tools/fixture.js verify-all
node tests/fixture-replay.js
git diff --check
```

The synchronization tools normalize line endings before comparing generated blocks, so the checks are consistent across LF and CRLF checkouts.

When changing the shared HLS parser, edit [`shared/hls-segment-parser.template.js`](shared/hls-segment-parser.template.js), regenerate the three userscript copies, and verify them:

```bash
node tools/sync-hls-segment-parser.js --write
node tools/sync-hls-segment-parser.js --check
```

When changing the shared developer-only fixture capture core, edit [`shared/fixture-capture.template.js`](shared/fixture-capture.template.js) and run the corresponding `sync-fixture-capture.js` write and check commands. Its generated targets are the Apple TV+ and Disney+ userscripts.

The `Regression tests` GitHub Actions workflow performs both shared-block synchronization checks, userscript syntax checks, whitespace validation, the regression suites, repository-fixture safety verification, and offline fixture replay for pull requests and pushes to `main`.

When a userscript changes, increment its `@version` so installed copies can receive the update.

## Fixture capture development

The repository includes a developer-only workflow for recording a sanitized playback timeline and turning it into a reviewed, offline regression fixture. It is disabled during normal use and currently has a Disney+ adapter pilot. Raw captures are ignored by Git; only minimized fixtures that pass the repository safety checks and contain human-reviewed expectations may be committed.

See [`docs/fixture-capture.md`](docs/fixture-capture.md) for activation, sanitization boundaries, import commands, fixture layout, and replay requirements. [`fixtures/README.md`](fixtures/README.md) contains the shorter repository-fixture policy.

## License and attribution

All four userscripts currently declare the MIT license. Author and upstream attribution is recorded in each userscript metadata block; some scripts are based on or derived from earlier subtitle downloader projects.

## Disclaimer

These scripts are intended for personal use with content that you are authorized to access.

Streaming services may change their sites, APIs, playback systems, media hosts, or terms of service at any time. Users are responsible for ensuring that their use of these scripts complies with applicable laws and the terms of the corresponding streaming service.
