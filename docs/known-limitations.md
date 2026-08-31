# Known limitations

This page records unresolved behavior found by code review and synthetic reproductions. These findings are not a report that every affected case has been reproduced in a live streaming session. Documenting a limitation does not fix it or make it intended behavior. Update or remove each entry when a code fix and its regression coverage land.

## Download integrity and timeouts

- **Netflix can save an empty or partial ZIP as complete.** `_download` can exhaust a track's mirrors without failing the overall operation, and `downloadThis` still saves the archive and reports success. Inspect the archive's entries instead of treating `Complete` as proof that all requested languages were downloaded. The selected format's mirrors are retried, but a failed transfer does not switch to another available format.
- **Apple TV+, Coupang Play, and Disney+ do not fully validate successful segment responses.** Segment request failures prevent saving, but a response with HTTP 200 can contain HTML or other invalid subtitle content. A mixture of valid cues and an invalid response can still be merged and saved. Successful HTTP status and a nonzero total cue count are not an integrity guarantee.
- **Netflix's timeout and Stop control do not cover response-body reads.** The request race ends when `fetch` returns a response; a stalled `response.text()` can leave the operation and its download lock pending even after Stop is selected.
- **Apple TV+, Coupang Play, and Disney+ do not configure a request timeout.** Their `GM_xmlhttpRequest` helpers register `ontimeout` callbacks but supply no `timeout` value or separate operation deadline. A stalled request can leave progress pending until the browser reports a failure. Retrying does not help while the original request remains unresolved.

Relevant code: [`_download`, `_save`, and `downloadThis` in Netflix](../scripts/netflix-subtitles-downloader.user.js); `getText`, `getHlsResourceText`, and the segment-merging paths in [Apple TV+](../scripts/apple-tv-plus-subtitles-downloader.user.js), [Coupang Play](../scripts/coupang-play-subtitles-downloader.user.js), and [Disney+](../scripts/disney-plus-subtitles-downloader.user.js).

## Netflix metadata and playback changes

- **Episode catalogs are a separate prerequisite from filename metadata.** The player can provide a title and episode number while the batch catalog is unavailable. Batch actions need a catalog containing the current episode; `Batch metadata unavailable` means that requirement was not met. Batch scope is limited to entries present in the catalog.
- **A normalized cache containing multiple titles can select unrelated show metadata.** `netflixMetadataFromGraphqlCache` can fall back to a show's `currentEpisode` without establishing its relationship to the current playback ID. This can return another show instead of the requested movie or show's metadata and interfere with the batch catalog.
- **An older download can overwrite progress after playback changes.** Resetting the menu to `Idle` does not invalidate the previous operation's asynchronous callbacks. When an old archive finishes, it can set the new playback menu's progress back to `Complete`.
- **Fixture capture does not continue across batch navigation.** Full-document episode navigation discards the in-memory capture. See the [capture guide and follow-up](fixture-capture.md#known-limitation-and-follow-up) for the single-download capture workflow.

Relevant code: `netflixMetadataFromGraphqlCache`, `waitForBatchPlan`, `resetDownloadUiForPlaybackChange`, and `_save` in the [Netflix userscript](../scripts/netflix-subtitles-downloader.user.js).

## Coupang Play DASH, TTML, and metadata

- **An XML declaration can prevent DASH manifest routing.** The MPD detection paths require text beginning with `<MPD`; an otherwise valid manifest starting with `<?xml ...?>` is not passed to `parseDashManifest`. Tracks that depend on parsing its template or relative addressing can therefore be missed.
- **Long sequential TTML containers can lose later cues.** `ttmlResolveTiming` recursively resolves earlier siblings in a `timeContainer="seq"` container. The recursion limit also counts that sibling chain, not just XML nesting. In a flat 70-paragraph reproduction, timing resolution failed from paragraph 65 onward and those paragraphs were skipped.
- **A failed metadata lookup can be cached as resolved.** Individual discovery requests catch their errors, allowing the enclosing lookup to resolve with incomplete metadata. `scheduleDiscoverMetadata` then sets `metadataResolvedKey`, preventing another lookup for the same key even after the network recovers. A fresh page load resets this state, but cannot guarantee that the metadata requests will succeed.

Relevant code: `parseManifest`, `ttmlResolveTiming`, `ttmlParagraphCueIntervals`, and `scheduleDiscoverMetadata` in the [Coupang Play userscript](../scripts/coupang-play-subtitles-downloader.user.js).

## Fixture safety and fidelity

- **Repository verification does not apply every safety check to referenced input bodies.** `verifyFixture` reads the input files separately from the scenario, observed result, and expectations. The generic secret and signed-URL scan does not inspect all of those separately supplied artifact bodies. An M3U8 body containing a synthetic token-bearing URL passed repository verification, although the equivalent capture-object check rejected it. Do not rely on `verify` or `verify-all` alone: inspect every input file and remove credentials, signed URLs, identifying data, and original dialogue before committing. This reproduction does not establish that existing fixtures contain exposed credentials.
- **XML capture sanitization can break TTML references.** The shared sanitizer tokenizes `xml:id` values without consistently updating `style` and `region` references to them. It can also alter namespace URLs by stripping their fragments. A sanitized artifact may therefore no longer reproduce the source document's styling or layout. Review identifier/reference consistency and namespace values when constructing a minimal fixture; prefer a synthetic equivalent with intact structural relationships.

Relevant code: [`verifyFixture`](../tools/fixture-lib/verifier.js), [`securityIssues`](../tools/fixture-lib/guards.js), and [`sanitizeXmlTag` in the shared capture core](../shared/fixture-capture.template.js).

Continue to run the [documented checks](../README.md#development-and-validation), but do not treat a passing suite as coverage for these unresolved cases. See the [capture workflow](fixture-capture.md) and [repository fixture policy](../fixtures/README.md) before collecting or committing diagnostic data.
