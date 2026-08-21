    function extractSegmentUrls(text, baseUrl) {
        return extractHlsSegmentEntries(text, baseUrl).map(function (entry) {
            return entry.url;
        });
    }

    function extractHlsSegmentEntries(text, baseUrl) {
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
            if (isMediaPlaylist || /\.(?:__HLS_SUBTITLE_EXTENSIONS__)(?:[?#]|$)/i.test(line)) {
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

    function parseHlsByteRange(value, requireOffset) {
        var match = String(value || '').trim().match(/^(\d+)(?:@(\d+))?$/);
        if (!match) return null;
        var length = Number(match[1]);
        var offset = match[2] == null ? null : Number(match[2]);
        if (!isSafeHlsByteInteger(length) || length <= 0) return null;
        if (offset !== null && !isSafeHlsByteInteger(offset)) return null;
        if (requireOffset && offset === null) return null;
        return { length: length, offset: offset };
    }

    function isSafeHlsByteInteger(value) {
        return isFinite(value) && value >= 0 && Math.floor(value) === value && value <= 9007199254740991;
    }

    function resolveHlsByteRange(parsed, url, previousSegment) {
        if (!parsed) throw new Error('Invalid HLS byte range.');
        var offset = parsed.offset;
        if (offset === null) {
            if (!previousSegment || previousSegment.url !== url || !previousSegment.byterange) {
                throw new Error('Implicit EXT-X-BYTERANGE offset requires a previous byte range on the same URI.');
            }
            offset = previousSegment.byterange.offset + previousSegment.byterange.length;
        }
        var end = offset + parsed.length - 1;
        if (!isSafeHlsByteInteger(offset) || !isSafeHlsByteInteger(end)) {
            throw new Error('HLS byte range exceeds the safe integer range.');
        }
        return { offset: offset, length: parsed.length };
    }
