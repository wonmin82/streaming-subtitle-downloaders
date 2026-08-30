# Regression fixtures

This directory contains small, sanitized inputs that reproduce subtitle discovery, metadata, parsing, and playback-session decisions without contacting a streaming service.

Raw browser captures must not be committed. Keep them below `captures/` or give them a `.fixture.local.json` or `.fixture.raw.json` suffix. Import only captures that pass both schema and safety validation:

```text
node tools/fixture.js inspect captures/problem.fixture.local.json
node tools/fixture.js verify-capture captures/problem.fixture.local.json
node tools/fixture.js import captures/problem.fixture.local.json --name descriptive-case-name
```

Import creates `fixtures/<service>/<name>/` with:

```text
scenario.json       Sanitized timeline and references to input files
input/              Sanitized manifests, metadata, or subtitle structures
observed.json       What the capturing userscript actually produced
expected.json       Human-reviewed assertions describing correct behavior
```

`observed.json` is evidence, not an oracle. Import intentionally writes `"reviewed": false` and empty assertions. A maintainer must minimize and pseudonymize `scenario.json`, the referenced inputs, and `observed.json`, diagnose the behavior, write the intended result in `expected.json`, and set `reviewed` to `true`. Unreviewed fixtures fail repository verification.

Verify one fixture or the complete committed corpus with:

```text
node tools/fixture.js verify fixtures/disney/synthetic-metadata
node tools/fixture.js verify fixtures/apple/synthetic-metadata
node tools/fixture.js verify fixtures/coupang/synthetic-metadata
node tools/fixture.js verify fixtures/netflix/synthetic-show-metadata
node tools/fixture.js verify fixtures/netflix/synthetic-subtitle-catalog
node tools/fixture.js verify-all
node tests/fixture-replay.js
```

The verifier is dependency-free and offline. It rejects malformed schema versions, path traversal, symbolic links, unreferenced inputs, unreviewed expectations, truncated captures, credentials, query- or path-signed URLs, DRM/license material, opaque binary blobs, and subtitle dialogue that has not been replaced with placeholders such as `CAPTION_001`. Passing `verify-capture` means a local export cleared those schema and high-risk-data checks; it does not mean detected titles, language labels, status text, or output filenames have been anonymized.

To make a fixture an executable test case, add a supported `scenario.json.replay` driver and input artifact reference. The replay suite feeds that sanitized input into the corresponding userscript parser and compares the fresh result with `expected.json.assertions`; it does not compare against `observed.json`. The synthetic service fixtures are the smallest examples. Minimized production-derived cases additionally cover Apple TV+ discontinuous HLS timing, Coupang Play WebVTT track filtering, Disney+ HLS language-pair discovery, and Netflix subtitle format and mirror selection.

Fixtures should be minimal. Preserve only the structure needed for the regression: timing, manifest structure, semantic metadata fields, state transitions, and expected decisions. Do not include cookies, authorization headers, account identifiers, DRM payloads, media files, full DOM snapshots, synopsis text, real subtitle dialogue, or identifying playback titles and filenames copied from a local capture.
