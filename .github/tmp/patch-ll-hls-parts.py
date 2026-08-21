from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = {
    ROOT / 'scripts/apple-tv-plus-subtitles-downloader.user.js': ('1.0.9', '1.0.10'),
    ROOT / 'scripts/disney-plus-subtitles-downloader.user.js': ('1.0.8', '1.0.9'),
    ROOT / 'scripts/coupang-play-subtitles-downloader.user.js': ('1.0.20', '1.0.21'),
}

FUNCTION = r'''    function extractHlsSegmentEntries(text, baseUrl) {
        var entries = [];
        var lines = String(text || '').split(/\r\n|\r|\n/);
        var isMediaPlaylist = lines.some(function (line) {
            return /^#EXTINF:/i.test(line.trim());
        });
        var currentMap = null;
        var pendingByteRange = null;
        var previousSegment = null;
        var pendingParts = [];
        var previousPart = null;

        lines.forEach(function (rawLine) {
            var line = rawLine.trim();
            if (!line) return;

            var mapMatch = line.match(/^#EXT-X-MAP:(.*)$/i);
            if (mapMatch) {
                var mapAttrs = parseAttrList(mapMatch[1]);
                if (!mapAttrs.URI) {
                    currentMap = null;
                    return;
                }
                var mapUrl = absoluteUrl(mapAttrs.URI, baseUrl);
                var mapByteRange = null;
                if (Object.prototype.hasOwnProperty.call(mapAttrs, 'BYTERANGE')) {
                    var parsedMapRange = parseHlsByteRange(mapAttrs.BYTERANGE, true);
                    if (!parsedMapRange) {
                        throw new Error('Invalid EXT-X-MAP BYTERANGE; an explicit offset is required.');
                    }
                    mapByteRange = resolveHlsByteRange(parsedMapRange, mapUrl, null);
                }
                currentMap = {
                    url: mapUrl,
                    byterange: mapByteRange
                };
                return;
            }

            var partMatch = line.match(/^#EXT-X-PART:(.*)$/i);
            if (partMatch) {
                var partAttrs = parseAttrList(partMatch[1]);
                if (!partAttrs.URI) throw new Error('EXT-X-PART is missing its URI.');
                var partDuration = Number(partAttrs.DURATION);
                if (!isFinite(partDuration) || partDuration <= 0) throw new Error('Invalid EXT-X-PART duration.');
                var partUrl = absoluteUrl(partAttrs.URI, baseUrl);
                var partByteRange = null;
                if (Object.prototype.hasOwnProperty.call(partAttrs, 'BYTERANGE')) {
                    var parsedPartRange = parseHlsByteRange(partAttrs.BYTERANGE, false);
                    if (!parsedPartRange) throw new Error('Invalid EXT-X-PART BYTERANGE.');
                    partByteRange = resolveHlsByteRange(parsedPartRange, partUrl, previousPart);
                }
                var partEntry = {
                    url: partUrl,
                    map: currentMap,
                    byterange: partByteRange,
                    partial: true
                };
                previousPart = {
                    url: partUrl,
                    byterange: partByteRange
                };
                if (!/^YES$/i.test(partAttrs.GAP || '')) pendingParts.push(partEntry);
                return;
            }

            var byteRangeMatch = line.match(/^#EXT-X-BYTERANGE:(.*)$/i);
            if (byteRangeMatch) {
                if (pendingByteRange !== null) throw new Error('Duplicate EXT-X-BYTERANGE before a media segment URI.');
                pendingByteRange = parseHlsByteRange(byteRangeMatch[1], false);
                if (!pendingByteRange) throw new Error('Invalid EXT-X-BYTERANGE.');
                return;
            }

            if (line.charAt(0) === '#') return;
            if (isMediaPlaylist || /\.(?:vtt|webvtt|ttml|dfxp|srt)(?:[?#]|$)/i.test(line)) {
                // A completed Parent Segment contains the same media as its preceding PARTs.
                // Prefer the completed segment and retain PARTs only for the unfinished live edge.
                pendingParts = [];
                previousPart = null;
                var segmentUrl = absoluteUrl(line, baseUrl);
                var segmentByteRange = pendingByteRange === null ? null :
                    resolveHlsByteRange(pendingByteRange, segmentUrl, previousSegment);
                entries.push({
                    url: segmentUrl,
                    map: currentMap,
                    byterange: segmentByteRange
                });
                previousSegment = {
                    url: segmentUrl,
                    byterange: segmentByteRange
                };
                pendingByteRange = null;
            }
        });

        if (pendingByteRange !== null) throw new Error('EXT-X-BYTERANGE is missing its media segment URI.');
        Array.prototype.push.apply(entries, pendingParts);
        return entries;
    }
'''

pattern = re.compile(r"    function extractHlsSegmentEntries\(text, baseUrl\) \{.*?\n    \}\n\n(?=    function parseHlsByteRange)", re.S)

for path, (old_version, new_version) in SCRIPTS.items():
    text = path.read_text()
    old_meta = f'// @version    {old_version}'
    new_meta = f'// @version    {new_version}'
    if text.count(old_meta) != 1:
        raise SystemExit(f'{path}: expected exactly one {old_meta!r}')
    text = text.replace(old_meta, new_meta, 1)
    text, count = pattern.subn(lambda match: FUNCTION + '\n', text, count=1)
    if count != 1:
        raise SystemExit(f'{path}: extractHlsSegmentEntries replacement count={count}')
    path.write_text(text)

test_path = ROOT / 'tests/regression.js'
test_text = test_path.read_text()
marker = "  test(`${service}: WebVTT HLS metadata path remains present`, () => {\n"
if test_text.count(marker) != 1:
    raise SystemExit(f'regression marker count={test_text.count(marker)}')
ll_hls_test = r'''  test(`${service}: LL-HLS partial segments cover only the unfinished live edge`, () => {
    const block = functionDeclarations(source, [
      'extractHlsSegmentEntries', 'parseAttrList', 'absoluteUrl',
      'parseHlsByteRange', 'isSafeHlsByteInteger', 'resolveHlsByteRange'
    ]);
    const ctx = evaluateFunctions(block, { URL });
    const playlist = [
      '#EXTM3U',
      '#EXT-X-MAP:URI="init.vtt"',
      '#EXT-X-PART:DURATION=0.5,URI="seg1.vtt",BYTERANGE="10@0"',
      '#EXT-X-PART:DURATION=0.5,URI="seg1.vtt",BYTERANGE="12"',
      '#EXTINF:1.0,',
      'seg1.vtt',
      '#EXT-X-PART:DURATION=0.5,URI="seg2.vtt",BYTERANGE="8@0"',
      '#EXT-X-PART:DURATION=0.5,URI="seg2.vtt",BYTERANGE="9"',
      '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="seg2.vtt",BYTERANGE-START=17'
    ].join('\n');
    const entries = ctx.extractHlsSegmentEntries(playlist, 'https://example.test/subs/live.m3u8');
    assert.strictEqual(entries.length, 3, 'completed parent must replace its PARTs while live-edge PARTs remain');
    assert.strictEqual(entries[0].url, 'https://example.test/subs/seg1.vtt');
    assert.strictEqual(entries[0].partial, undefined, 'completed parent must not be marked partial');
    assert.strictEqual(entries[1].partial, true);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(entries[1].byterange)), { offset: 0, length: 8 });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(entries[2].byterange)), { offset: 8, length: 9 });
    assert(entries.every(entry => entry.map && entry.map.url === 'https://example.test/subs/init.vtt'), 'map must apply to parent and PART entries');
    assert(!entries.some(entry => /PRELOAD/.test(entry.url)), 'preload hints must not be fetched');

    const gapPlaylist = [
      '#EXTM3U',
      '#EXT-X-PART:DURATION=0.5,URI="seg3.vtt",BYTERANGE="5@0",GAP=YES',
      '#EXT-X-PART:DURATION=0.5,URI="seg3.vtt",BYTERANGE="7"'
    ].join('\n');
    const gapEntries = ctx.extractHlsSegmentEntries(gapPlaylist, 'https://example.test/subs/live.m3u8');
    assert.strictEqual(gapEntries.length, 1, 'GAP part must not be fetched');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(gapEntries[0].byterange)), { offset: 5, length: 7 }, 'GAP range must still advance implicit offset');

    const invalidImplicit = [
      '#EXTM3U',
      '#EXT-X-PART:DURATION=0.5,URI="seg4.vtt",BYTERANGE="5@0"',
      '#EXTINF:0.5,',
      'seg4.vtt',
      '#EXT-X-PART:DURATION=0.5,URI="seg5.vtt",BYTERANGE="7"'
    ].join('\n');
    assert.throws(() => ctx.extractHlsSegmentEntries(invalidImplicit, 'https://example.test/subs/live.m3u8'), /Implicit EXT-X-BYTERANGE offset/);
    assert.throws(() => ctx.extractHlsSegmentEntries('#EXTM3U\n#EXT-X-PART:URI="missing-duration.vtt"', 'https://example.test/live.m3u8'), /duration/);
  });

'''
test_text = test_text.replace(marker, ll_hls_test + marker, 1)
test_path.write_text(test_text)
