# Fixture Capture Tool

Fixture Capture is a developer-only path for turning an observed playback problem into a small, sanitized, offline regression case. All four supported services have capture adapters and use the same schema, safety tooling, and repository workflow.

Once armed, the recording path is a read-only side channel. It records values that the userscript has already received or calculated, does not issue additional requests, and is never awaited by the download path. Capture failures are contained inside the adapter and must not change playback, subtitle discovery, filenames, or saved files.

## Developer activation

Capture recording is inactive during normal use. To enable it without changing the playback URL:

1. Open the Tampermonkey menu in the service tab.
2. Choose **[Fixture] Start capture and reload this tab**. The command arms only that tab and reloads it automatically.
3. Reproduce the problem. Capture starts before the normal network hooks are installed so that early metadata and manifest observations are included.
4. Open the Tampermonkey menu again and choose **[Fixture] Stop and export**.

Before activation, Tampermonkey shows only the start-and-reload command. The command stores a two-minute, one-shot arm in the current tab's `sessionStorage`; the reloaded userscript consumes and deletes it immediately. No capture content is written to browser storage. Once active, the developer commands can restart the in-memory capture, export a non-stopping snapshot, clear it, or print a value-free status summary to the console. Stopping or clearing a capture immediately restores the start-and-reload command without requiring another page reload. No page overlay, badge, notification, persistent setting, URL marker, or end-user downloader-menu item is added.

The export is named `apple-<timestamp>.fixture.local.json`, `coupang-<timestamp>.fixture.local.json`, `disney-<timestamp>.fixture.local.json`, or `netflix-<timestamp>.fixture.local.json`. This suffix and the local `captures/` directory are ignored by Git.

Netflix batch downloads navigate between episodes with a full document reload. Capture content is memory-only and the one-shot arm has already been consumed, so the first navigation discards the active capture and the next document starts with capture disabled. The current implementation therefore cannot export one continuous capture after a multi-episode batch completes. Capture the relevant movie or episode as a single download when diagnostic JSON is required, and validate the cross-episode batch separately from its resulting archive. See **Known limitation and follow-up** below.

## What a capture contains

Schema version 1 separates four kinds of evidence:

- `events`: ordered decisions such as session changes, metadata acceptance, manifest parsing, track discovery, and download outcomes.
- `snapshots`: deduplicated semantic states such as the active Shadow DOM title and resolved filename.
- `artifacts`: bounded HLS/WebVTT structures already handled by the userscript and structure-only projections of metadata JSON. Raw metadata responses are not exported.
- `observed`: the final metadata, filename, status code, and track summaries produced during the reproduction.

Known non-playback configuration operations such as Disney+'s `getSiteConfig` response are omitted from metadata artifacts. Apple TV+ HLS responses are reduced to subtitle-relevant master entries or a bounded head-and-tail media-playlist projection before entering the shared capture limits. Coupang Play records projected discovery metadata plus bounded HLS, DASH, WebVTT, and TTML structures that the downloader already receives. Netflix records bounded title catalogs, subtitle-track and format availability, mirror outcomes without the original signed URLs, and sanitized WebVTT or XML structures already downloaded by the script. Repeated metadata projections reuse the first artifact while each observation remains represented in the event timeline.

Session values and opaque identifiers are replaced with stable capture-local aliases. URL credentials, query signing parameters, and path-embedded CDN signing segments are removed. Structure-only metadata artifacts replace private or copyright-bearing text with placeholders, account/profile fields are removed, and subtitle dialogue is replaced while timing and parser-relevant structure remain. Capture sizes and entry counts are bounded; an export that hits a limit is marked as truncated and cannot be imported as a repository fixture.

The event timeline, snapshots, and final `observed` state may retain short values needed to diagnose user-visible behavior, including detected playback titles, language labels, status text, and output filenames. Treat every `.fixture.local.json` export as local review material even when `verify-capture` reports it as safe. That result means the export passes the schema and high-risk-data guard; it does not mean the file is anonymous or ready to commit.

Export is blocked if a final safety scan still sees high-risk credentials, signed URLs, DRM/license material, or other sensitive data. This browser-side protection is followed by a separate repository-side verifier; neither replaces human review.

## Importing a repository fixture

Keep the downloaded capture outside the repository or under ignored `captures/`, then inspect it without printing captured values:

```text
node tools/fixture.js inspect captures/problem.fixture.local.json
node tools/fixture.js verify-capture captures/problem.fixture.local.json
node tools/fixture.js import captures/problem.fixture.local.json --name descriptive-case-name
```

Import refuses unsafe names, overwrites, truncated captures, and captures that fail schema or safety checks. It creates:

```text
fixtures/<service>/<name>/
├── scenario.json
├── input/
├── observed.json
└── expected.json
```

`observed.json` records the faulty or successful behavior that occurred; it is evidence, not the expected result. Import therefore creates `expected.json` with `reviewed: false` and no assertions. A maintainer must minimize and pseudonymize `scenario.json`, the referenced inputs, and `observed.json`, diagnose the behavior, write the intended assertions, and set `reviewed` to `true` before the fixture can be committed.

Do not commit raw captures, cookies, authorization headers, account or device identifiers, DRM data, media files, HAR files, DOM dumps, synopsis text, real subtitle dialogue, or identifying playback titles and filenames copied from a local capture. Prefer synthetic values such as `SHOW_001`, `TOKEN_1`, and `CAPTION_001` whenever the original value is not needed to reproduce the parser decision.

## Verification and replay

Validate one reviewed fixture or the complete corpus offline:

```text
node tools/fixture.js verify fixtures/disney/synthetic-metadata
node tools/fixture.js verify fixtures/apple/synthetic-metadata
node tools/fixture.js verify fixtures/coupang/synthetic-metadata
node tools/fixture.js verify fixtures/netflix/synthetic-show-metadata
node tools/fixture.js verify fixtures/netflix/synthetic-subtitle-catalog
node tools/fixture.js verify-all
node tests/fixture-replay.js
```

Repository verification checks the schema, reviewed flag, paths, symlinks, referenced inputs, size limits, secrets, signed URLs, DRM material, opaque binary data, and unsanitized long-form or subtitle text. Replay tests then feed fixture inputs into the applicable userscript parser and compare the fresh result with the human-reviewed assertions. No streaming-service request is allowed during replay.

The committed Apple TV+, Coupang Play, Disney+, and Netflix synthetic cases demonstrate this full path. Future observed cases should be reduced to the smallest input that preserves the failing decision.

## Known limitation and follow-up

- [ ] Preserve or automatically export a sanitized Netflix capture across full-document episode navigation during batch downloads without weakening the memory-only safety boundary or changing normal downloader behavior.

## Maintaining the shared core

Edit the source template rather than the generated userscript block:

```text
node tools/sync-fixture-capture.js --write
node tools/sync-fixture-capture.js --check
```

The generated target list contains all four userscripts. Adapter changes must retain lazy, synchronous, no-throw wrappers and parity tests proving that capture-disabled execution does not create payloads, requests, timers, observers, or UI.
