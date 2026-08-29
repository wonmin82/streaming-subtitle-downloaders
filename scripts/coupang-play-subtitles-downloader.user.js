// ==UserScript==
// @name       Coupang Play Subtitles Downloader
// @namespace  https://github.com/wonmin82/streaming-subtitle-downloaders
// @description Download subtitles from Coupang Play
// @version    1.0.27
// @author     Wonmin Jung
// @license    MIT
// @homepageURL https://github.com/wonmin82/streaming-subtitle-downloaders
// @downloadURL https://raw.githubusercontent.com/wonmin82/streaming-subtitle-downloaders/main/scripts/coupang-play-subtitles-downloader.user.js
// @updateURL  https://raw.githubusercontent.com/wonmin82/streaming-subtitle-downloaders/main/scripts/coupang-play-subtitles-downloader.user.js
// @match      https://www.coupangplay.com/*
// @match      https://coupangplay.com/*
// @match      https://*.coupangplay.com/*
// @grant      GM_info
// @grant      GM_xmlhttpRequest
// @grant      GM_registerMenuCommand
// @grant      GM_unregisterMenuCommand
// @grant      unsafeWindow
// @connect    *
// @require    https://cdn.jsdelivr.net/npm/jszip@3.7.1/dist/jszip.min.js
// @require    https://cdn.jsdelivr.net/npm/file-saver@2.0.5/dist/FileSaver.min.js
// @run-at     document-start
// ==/UserScript==

(function () {
    'use strict';

    var debug = location.hash === '#debug' || location.hash.indexOf('cpsd_debug') >= 0;
    var MAX_RETRIES = 5;
    var RETRY_BASE_DELAY_MS = 250;
    var RETRY_MAX_DELAY_MS = 4000;
    var MAX_DASH_TEMPLATE_SEGMENTS = 10000;
    var MAX_TTML_CUE_BOUNDARIES = 2048;
    var LOG_PREFIX = '[Coupang Play Subtitles DL]';
    var targetWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    var MESSAGE_TYPE_TRACK = 'cpsd-subtitle-track';
    var MESSAGE_TYPE_SESSION = 'cpsd-playback-session';
    var MESSAGE_TYPE_SESSION_REQUEST = 'cpsd-playback-session-request';
    var MAX_SESSION_CLIENTS = 32;
    var MAX_MESSAGE_TRACK_SEGMENTS = 10000;
    var FIXTURE_CAPTURE_ARM_KEY = 'ssd:fixture-capture:coupang:armed-until';
    var FIXTURE_CAPTURE_ARM_TTL_MS = 2 * 60 * 1000;

    var state = {
        initialized: false,
        installedHooks: false,
        observer: null,
        oldlocation: null,
        playbackSessionSequence: 0,
        playbackSessionId: '',
        playbackSessionStartedAt: 0,
        playbackSessionEpochMs: 0,
        topSessionOrigin: '',
        playbackScanStartedAt: 0,
        sessionClients: [],
        pendingSessionObservations: [],
        pendingSessionObservationBytes: 0,
        replayingSessionObservations: false,
        downloadOperationSequence: 0,
        activeDownloadOperationId: 0,
        tracks: [],
        trackKeys: {},
        seenResourceUrls: {},
        seenManifestUrls: {},
        selectedTrackKey: '',
        userSelectedTrack: false,
        mediaTitle: '',
        mediaTitlePriority: 0,
        episodeTag: '',
        episodeTitle: '',
        seasonNumber: null,
        episodeNumber: null,
        episodeConfirmed: false,
        metadataRequestKey: '',
        metadataResolvedKey: '',
        metadataFailedKey: '',
        metadataPromise: null,
        playbackActive: false,
        lastMetadataScanAt: 0,
        lastPerformanceScanAt: 0,
        performanceEntryCount: 0,
        wait: false,
        status: 'Start playback, then wait for tracks...',
        lastError: '',
        outputFilename: '',
        progressCompleted: 0,
        progressTotal: 0,
        progressLabel: 'Idle',
        progressUiTimer: null,
        lastProgressUiAt: 0,
        zip: null
    };

    // BEGIN SHARED FIXTURE CAPTURE CORE
    function createFixtureCapture(options) {
        'use strict';

        options = options && typeof options === 'object' ? options : {};

        var CAPTURE_TOOL_VERSION = '1.0.0';
        var SANITIZATION_VERSION = 1;
        var HARD_LIMITS = {
            maxEvents: 3000,
            maxSnapshots: 500,
            maxArtifacts: 200,
            maxArtifactBytes: 1024 * 1024,
            maxCaptureBytes: 20 * 1024 * 1024,
            maxStringBytes: 4096,
            maxArrayItems: 200,
            maxObjectKeys: 200,
            maxDepth: 12
        };
        var MIN_LIMITS = {
            maxEvents: 1,
            maxSnapshots: 1,
            maxArtifacts: 1,
            maxArtifactBytes: 128,
            maxCaptureBytes: 2048,
            maxStringBytes: 64,
            maxArrayItems: 1,
            maxObjectKeys: 1,
            maxDepth: 1
        };
        var SAFE_QUERY_VALUES = /^(?:lang(?:uage)?|locale|format|_HLS_msn|_HLS_part)$/i;
        var SENSITIVE_KEY = /(?:^|_)(?:authorization|cookies?|set_cookie|password|passwd|secrets?|access_tokens?|refresh_tokens?|id_tokens?|tokens?|signatures?|polic(?:y|ies)|credentials?|api_keys?|private_keys?)(?:$|_)/i;
        var SESSION_KEY = /(?:^|_)(?:playback_)?session(?:_?id)?(?:$|_)/i;
        var URL_KEY = /(?:^|_)(?:url|uri|href|src|manifest|playlist)(?:$|_)/i;
        var CONTENT_TEXT_KEY = /(?:^|_)(?:caption|subtitle|transcript|dialogue|body|description|synopsis|overview|summary|plot)(?:$|_)/i;
        var ID_KEY = /(?:^|_)(?:id|(?:movie|content|playable|episode|asset|account|profile|subscriber|customer|user|viewer|device)_?id)(?:$|_)/i;
        var PII_KEY = /(?:^|_)(?:(?:first|middle|last|full|given|family|display|profile|user|account|subscriber|customer|viewer)_?name|e_?mail|phone(?:_number)?|address|birth(?:date)?|date_of_birth|gender)(?:$|_)/i;
        var PII_CONTAINER_KEY = /^(?:accounts?|profiles?|subscribers?|customers?|users?|viewers?|persons?|members?)$/i;
        var DRM_KEY = /(?:^|_)(?:pssh|drm_data|license_data|license_challenge|license_response|certificate_data|widevine_data|fairplay_data|playready_data)(?:$|_)/i;
        var DRM_ARTIFACT = /^(?:drm|license|certificate|cert|pssh|widevine|fairplay|playready|cenc)$/i;
        var PROHIBITED_ARTIFACT = /^(?:dom|html|har|media|video|audio|image|binary|blob)$/i;
        var DRM_PATH = /\/(?:drm|license|licenses|widevine|fairplay|playready|certificate|cert)(?:\/|$)/i;
        var SIGNED_PATH_SEGMENT = /(?:^|[~;,])(?:dvt\d*|exp(?:ires)?|signature|sig|policy|tokens?|auth(?:orization)?|credentials?|psid|playback_?session_?id)=/i;
        var limits = resolveLimits(options.limits);
        var state = 'idle';
        var data = null;
        var startedAtMs = 0;
        var capturedBytes = 0;
        var artifactSequence = 0;
        var eventSequence = 0;
        var captionSequence = 0;
        var textSequence = 0;
        var sessionValues = [];
        var tokenValues = [];
        var warningKeys = Object.create(null);
        var securityBlocked = false;
        var lastError = '';

        function resolveLimits(requested) {
            var source = requested && typeof requested === 'object' ? requested : {};
            var result = {};
            Object.keys(HARD_LIMITS).forEach(function (key) {
                var value = Number(source[key]);
                if (!isFinite(value)) value = HARD_LIMITS[key];
                value = Math.floor(value);
                result[key] = Math.max(MIN_LIMITS[key], Math.min(HARD_LIMITS[key], value));
            });
            return result;
        }

        function safeNow() {
            try {
                var value = typeof options.now === 'function' ? Number(options.now()) : Date.now();
                return isFinite(value) ? value : Date.now();
            } catch (error) {
                return Date.now();
            }
        }

        function safeIsoTime(value) {
            try {
                return new Date(value).toISOString();
            } catch (error) {
                return '';
            }
        }

        function byteLength(value) {
            var string = String(value == null ? '' : value);
            var bytes = 0;
            for (var index = 0; index < string.length; index++) {
                var code = string.charCodeAt(index);
                if (code < 0x80) {
                    bytes += 1;
                } else if (code < 0x800) {
                    bytes += 2;
                } else if (code >= 0xD800 && code <= 0xDBFF && index + 1 < string.length &&
                    string.charCodeAt(index + 1) >= 0xDC00 && string.charCodeAt(index + 1) <= 0xDFFF) {
                    bytes += 4;
                    index++;
                } else {
                    bytes += 3;
                }
            }
            return bytes;
        }

        function truncateUtf8(value, maximum) {
            var string = String(value == null ? '' : value);
            if (byteLength(string) <= maximum) return string;
            var bytes = 0;
            var output = '';
            for (var index = 0; index < string.length; index++) {
                var code = string.charCodeAt(index);
                var width = code < 0x80 ? 1 : (code < 0x800 ? 2 : 3);
                var chunk = string.charAt(index);
                if (code >= 0xD800 && code <= 0xDBFF && index + 1 < string.length &&
                    string.charCodeAt(index + 1) >= 0xDC00 && string.charCodeAt(index + 1) <= 0xDFFF) {
                    width = 4;
                    chunk += string.charAt(++index);
                }
                if (bytes + width > maximum) break;
                output += chunk;
                bytes += width;
            }
            return output;
        }

        function safeJson(value) {
            try {
                return JSON.stringify(value);
            } catch (error) {
                return '';
            }
        }

        function cloneJson(value) {
            try {
                return JSON.parse(JSON.stringify(value));
            } catch (error) {
                return null;
            }
        }

        function sanitizeIdentifier(value, fallback) {
            var result = String(value == null ? '' : value).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
            return truncateUtf8(result || fallback || 'unknown', 80);
        }

        function sanitizeEventType(value) {
            var parts = String(value == null ? '' : value).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(function (part) {
                return /^[a-z]/.test(part) ? part : 'x' + part;
            });
            if (!parts.length) parts = ['custom', 'event'];
            if (parts.length === 1) parts.unshift('custom');
            return truncateUtf8(parts.join('.'), 80).replace(/\.+$/, '') || 'custom.event';
        }

        function sanitizeKind(value, fallback) {
            var result = String(value == null ? '' : value).toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '');
            if (!result) result = fallback || 'item';
            if (!/^[a-z]/.test(result)) result = 'item-' + result;
            return truncateUtf8(result, 80).replace(/[.-]+$/, '') || 'item';
        }

        function sanitizeFormat(value) {
            var result = String(value == null ? '' : value).toLowerCase().replace(/[^a-z0-9.+-]+/g, '-').replace(/^[.+-]+|[.+-]+$/g, '');
            return truncateUtf8(result || 'text', 32).replace(/[.+-]+$/, '') || 'text';
        }

        function resetMappings() {
            sessionValues = [];
            tokenValues = [];
            captionSequence = 0;
            textSequence = 0;
        }

        function mappedValue(collection, prefix, value) {
            var string = String(value == null ? '' : value);
            var index = collection.indexOf(string);
            if (index < 0) {
                collection.push(string);
                index = collection.length - 1;
            }
            return prefix + '_' + (index + 1);
        }

        function mapSession(value) {
            if (value == null || value === '') return '';
            return mappedValue(sessionValues, 'SESSION', value);
        }

        function mapToken(value) {
            if (value == null || value === '') return '';
            return mappedValue(tokenValues, 'TOKEN', value);
        }

        function looksOpaque(value) {
            var string = String(value == null ? '' : value);
            return /^[0-9]{10,}$/.test(string) ||
                /^[0-9a-f]{16,}$/i.test(string) ||
                /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(string) ||
                (/^[A-Za-z0-9_-]{20,}$/.test(string) && /[0-9]/.test(string));
        }

        function normalizedKey(value) {
            return String(value == null ? '' : value)
                .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
                .replace(/[-:\s]+/g, '_')
                .toLowerCase();
        }

        function addWarning(code) {
            if (!data || warningKeys[code]) return;
            warningKeys[code] = true;
            if (data.sanitization.warnings.length < 50) data.sanitization.warnings.push(truncateUtf8(code, 120));
        }

        function markTruncated(code) {
            if (data) data.capture.truncated = true;
            addWarning('limit:' + code);
        }

        function redact() {
            if (data) data.sanitization.redactions++;
            return 'REDACTED';
        }

        function flagCriticalSecret(code) {
            securityBlocked = true;
            addWarning('security:' + code);
            if (data) data.sanitization.redactions++;
        }

        function containsCriticalSecret(value, key) {
            var string = String(value == null ? '' : value);
            if ((/(?:authorization|cookie|set-cookie)/i.test(String(key || '')) && string && string !== 'REDACTED') ||
                /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(string) ||
                /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+=\/-]{8,}/i.test(string) ||
                /\b(?:Cookie|Set-Cookie|Authorization)\s*:\s*\S+/i.test(string) ||
                /\bAKIA[0-9A-Z]{16}\b/.test(string) ||
                /\bgh[pousr]_[A-Za-z0-9]{20,}\b/.test(string) ||
                (!/\s/.test(string) && /^(?:[A-Za-z0-9+/]{256,}={0,2})$/.test(string)) ||
                /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(string)) {
                return true;
            }
            return false;
        }

        function sanitizeUrl(value) {
            try {
                var input = truncateUtf8(value, limits.maxStringBytes * 4);
                if (!input) return '';
                if (/^(?:data|blob|javascript):/i.test(input)) return redact() + '_URL';
                var absolute = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(input) || /^\/\//.test(input);
                var url = new URL(input, 'https://fixture.invalid/');
                if (!/^https?:$/.test(url.protocol)) return redact() + '_URL';
                if (DRM_PATH.test(url.pathname)) {
                    flagCriticalSecret('drm-url');
                    return 'REDACTED_URL';
                }
                url.username = '';
                url.password = '';
                var pathParts = url.pathname.split('/').map(function (part) {
                    if (!part) return part;
                    var decodedPart = part;
                    try { decodedPart = decodeURIComponent(part); } catch (error) {}
                    if (SIGNED_PATH_SEGMENT.test(decodedPart)) return mapToken(part);
                    var extensionMatch = part.match(/^(.*?)(\.[A-Za-z0-9]{1,8})$/);
                    var stem = extensionMatch ? extensionMatch[1] : part;
                    var extension = extensionMatch ? extensionMatch[2] : '';
                    return looksOpaque(stem) ? mapToken(stem) + extension : truncateUtf8(part, 160);
                });
                url.pathname = pathParts.join('/');
                var query = [];
                url.searchParams.forEach(function (queryValue, queryKey) {
                    var safeKey = truncateUtf8(queryKey.replace(/[^A-Za-z0-9_.-]/g, '_'), 80);
                    var safeValue = SAFE_QUERY_VALUES.test(queryKey) && /^[A-Za-z0-9_.-]{1,40}$/.test(queryValue) ? queryValue : redact();
                    query.push(encodeURIComponent(safeKey) + '=' + encodeURIComponent(safeValue));
                });
                url.search = query.length ? '?' + query.join('&') : '';
                url.hash = '';
                if (!absolute) return url.pathname + url.search;
                if (/^\/\//.test(input)) return '//' + url.host + url.pathname + url.search;
                return url.protocol + '//' + url.host + url.pathname + url.search;
            } catch (error) {
                if (data) data.sanitization.redactions++;
                return 'REDACTED_URL';
            }
        }

        function sanitizeInlineString(value, key) {
            var string = String(value == null ? '' : value);
            if (containsCriticalSecret(string, key)) {
                flagCriticalSecret('high-risk-value');
                return 'REDACTED_SECRET';
            }
            var normalized = normalizedKey(key);
            if (DRM_KEY.test(normalized)) {
                if (data) data.sanitization.redactions++;
                addWarning('sanitizer:drm-field-removed');
                return 'REDACTED';
            }
            if (PII_KEY.test(normalized) || PII_CONTAINER_KEY.test(normalized)) return redact();
            if (SENSITIVE_KEY.test(normalized)) return redact();
            if (SESSION_KEY.test(normalized)) return mapSession(string);
            if (CONTENT_TEXT_KEY.test(normalized)) {
                textSequence++;
                if (data) data.sanitization.redactions++;
                return 'TEXT_' + textSequence;
            }
            if (URL_KEY.test(normalized) || /^(?:https?:)?\/\//i.test(string)) return sanitizeUrl(string);
            if (ID_KEY.test(normalized) && string) return mapToken(string);
            if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(string)) {
                if (data) data.sanitization.redactions++;
                string = string.replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, 'REDACTED_EMAIL');
            }
            string = string.replace(/([?&](?:token|sig|signature|policy|key|auth|credential)=)[^&#\s]*/ig, '$1REDACTED');
            if (byteLength(string) > limits.maxStringBytes) {
                markTruncated('maxStringBytes');
                string = truncateUtf8(string, limits.maxStringBytes);
            }
            return string;
        }

        function sanitizeValue(value, key, depth, seen) {
            var normalized = normalizedKey(key);
            if (value == null) return value;
            if (typeof value === 'boolean') {
                if (DRM_KEY.test(normalized) || SENSITIVE_KEY.test(normalized) || PII_KEY.test(normalized) ||
                    PII_CONTAINER_KEY.test(normalized) || SESSION_KEY.test(normalized) || ID_KEY.test(normalized)) return redact();
                return value;
            }
            if (typeof value !== 'string') {
                if (DRM_KEY.test(normalized) || SENSITIVE_KEY.test(normalized) || PII_KEY.test(normalized) ||
                    (PII_CONTAINER_KEY.test(normalized) && typeof value === 'object')) return redact();
                if (SESSION_KEY.test(normalized) && (typeof value === 'number' || typeof value === 'bigint')) return mapSession(value);
                if (ID_KEY.test(normalized) && (typeof value === 'number' || typeof value === 'bigint')) return mapToken(value);
                if (CONTENT_TEXT_KEY.test(normalized) && typeof value === 'object') {
                    textSequence++;
                    if (data) data.sanitization.redactions++;
                    return 'TEXT_' + textSequence;
                }
            }
            if (typeof value === 'number') return isFinite(value) ? value : null;
            if (typeof value === 'bigint') return sanitizeInlineString(String(value), key);
            if (typeof value === 'string') return sanitizeInlineString(value, key);
            if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'undefined') return null;
            if (depth >= limits.maxDepth) {
                markTruncated('maxDepth');
                return '[MAX_DEPTH]';
            }
            if (seen.indexOf(value) >= 0) {
                addWarning('sanitizer:cyclic-value');
                return '[CIRCULAR]';
            }
            seen.push(value);
            try {
                if (Array.isArray(value)) {
                    if (value.length > limits.maxArrayItems) markTruncated('maxArrayItems');
                    return value.slice(0, limits.maxArrayItems).map(function (item) {
                        return sanitizeValue(item, key, depth + 1, seen);
                    });
                }
                var result = Object.create(null);
                var keys;
                try {
                    keys = Object.keys(value);
                } catch (error) {
                    addWarning('sanitizer:unreadable-object');
                    return '[UNREADABLE]';
                }
                if (keys.length > limits.maxObjectKeys) markTruncated('maxObjectKeys');
                keys.slice(0, limits.maxObjectKeys).forEach(function (property) {
                    var propertyValue;
                    try {
                        propertyValue = value[property];
                    } catch (error) {
                        addWarning('sanitizer:unreadable-property');
                        result[property] = '[UNREADABLE]';
                        return;
                    }
                    var safeProperty = truncateUtf8(String(property), 120);
                    result[safeProperty] = sanitizeValue(propertyValue, property, depth + 1, seen);
                });
                return result;
            } finally {
                seen.pop();
            }
        }

        function sanitizeJsonText(text) {
            var input = truncateUtf8(text, limits.maxArtifactBytes);
            try {
                return JSON.stringify(sanitizeValue(JSON.parse(input), '', 0, []), null, 2);
            } catch (error) {
                addWarning('sanitizer:invalid-json');
                return '[REDACTED_INVALID_JSON]';
            }
        }

        function sanitizeManifestText(text) {
            var input = truncateUtf8(text, limits.maxArtifactBytes);
            var lines = input.split(/\r\n|\r|\n/);
            return lines.map(function (line) {
                var trimmed = line.trim();
                if (!trimmed) return '';
                if (/^#EXT-X-(?:SESSION-)?KEY\s*:/i.test(trimmed)) {
                    if (data) data.sanitization.redactions++;
                    addWarning('sanitizer:drm-hls-removed');
                    return trimmed.replace(/:.*/, ':REDACTED');
                }
                if (/^(?:https?:)?\/\//i.test(trimmed) || (!/^#/.test(trimmed) && /[/?]/.test(trimmed))) {
                    return sanitizeUrl(trimmed);
                }
                var output = line.replace(/(URI\s*=\s*)(["'])(.*?)(\2)/ig, function (_, prefix, quote, uri) {
                    return prefix + quote + sanitizeUrl(uri) + quote;
                });
                output = output.replace(/(https?:\/\/[^\s,"']+)/ig, function (url) {
                    return sanitizeUrl(url);
                });
                return sanitizeInlineString(output, 'structure_line');
            }).join('\n');
        }

        function sanitizeCueMarkup(line) {
            var parts = String(line).split(/(<[^>]*>)/g);
            var wroteCaption = false;
            return parts.map(function (part) {
                if (!part) return '';
                if (/^<[^>]*>$/.test(part)) {
                    if (/^<v(?:\s|>)/i.test(part)) return part.replace(/^<v[^>]*>/i, '<v SPEAKER>');
                    return truncateUtf8(part.replace(/\s(?:id|data-[\w-]+)=(['"])[\s\S]*?\1/ig, ''), 240);
                }
                if (!part.trim()) return part;
                if (wroteCaption) return '';
                captionSequence++;
                wroteCaption = true;
                if (data) data.sanitization.redactions++;
                return 'CAPTION_' + captionSequence;
            }).join('');
        }

        function sanitizeWebVttText(text) {
            var input = truncateUtf8(text, limits.maxArtifactBytes);
            var lines = input.split(/\r\n|\r|\n/);
            var inCue = false;
            var inNote = false;
            var structuralBlock = '';
            return lines.map(function (line) {
                var trimmed = line.trim();
                if (!trimmed) {
                    inCue = false;
                    inNote = false;
                    structuralBlock = '';
                    return '';
                }
                if (/^WEBVTT(?:\s|$)/i.test(trimmed)) return 'WEBVTT';
                if (/^NOTE(?:\s|$)/i.test(trimmed)) {
                    inNote = true;
                    textSequence++;
                    if (data) data.sanitization.redactions++;
                    return 'NOTE TEXT_' + textSequence;
                }
                if (inNote) return '';
                if (/^(?:STYLE|REGION)$/i.test(trimmed)) {
                    structuralBlock = trimmed.toUpperCase();
                    return structuralBlock;
                }
                if (/-->/.test(line)) {
                    inCue = true;
                    structuralBlock = '';
                    return sanitizeInlineString(line, 'cue_timing');
                }
                if (inCue) return sanitizeCueMarkup(line);
                if (structuralBlock) {
                    return sanitizeInlineString(line.replace(/url\((['"]?)(.*?)\1\)/ig, function (_, quote, url) {
                        return 'url(' + quote + sanitizeUrl(url) + quote + ')';
                    }), 'vtt_structure');
                }
                if (/^(?:X-TIMESTAMP-MAP|Kind|Language)\s*[:=]/i.test(trimmed)) return sanitizeManifestText(line);
                textSequence++;
                if (data) data.sanitization.redactions++;
                return 'CUE_' + textSequence;
            }).join('\n');
        }

        function sanitizeXmlTag(tag) {
            return tag.replace(/\s([:\w.-]+)\s*=\s*(["'])([\s\S]*?)\2/g, function (_, attribute, quote, value) {
                var safeValue;
                var normalized = normalizedKey(attribute);
                if (SENSITIVE_KEY.test(normalized)) safeValue = redact();
                else if (URL_KEY.test(normalized) || /^(?:https?:)?\/\//i.test(value)) safeValue = sanitizeUrl(value);
                else if (SESSION_KEY.test(normalized)) safeValue = mapSession(value);
                else if (ID_KEY.test(normalized) && looksOpaque(value)) safeValue = mapToken(value);
                else safeValue = sanitizeInlineString(value, attribute);
                return ' ' + attribute + '=' + quote + safeValue + quote;
            });
        }

        function sanitizeXmlText(text) {
            var input = truncateUtf8(text, limits.maxArtifactBytes);
            input = input.replace(/<!--[\s\S]*?-->/g, '<!-- REDACTED -->');
            input = input.replace(/<(?:[\w.-]+:)?(?:pssh|pro|ContentProtection)\b[^>]*(?:\/>|>[\s\S]*?<\/(?:[\w.-]+:)?(?:pssh|pro|ContentProtection)\s*>)/gi, function () {
                if (data) data.sanitization.redactions++;
                addWarning('sanitizer:drm-xml-removed');
                return '<!-- DRM_REMOVED -->';
            });
            input = input.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, function () {
                captionSequence++;
                if (data) data.sanitization.redactions++;
                return '<![CDATA[CAPTION_' + captionSequence + ']]>';
            });
            return input.split(/(<[^>]+>)/g).map(function (part) {
                if (!part) return '';
                if (/^<[^>]+>$/.test(part)) return sanitizeXmlTag(part);
                if (!part.trim()) return part;
                captionSequence++;
                if (data) data.sanitization.redactions++;
                var leading = (part.match(/^\s*/) || [''])[0];
                var trailing = (part.match(/\s*$/) || [''])[0];
                return leading + 'CAPTION_' + captionSequence + trailing;
            }).join('');
        }

        function sanitizeArtifactText(kind, text, format) {
            var normalized = String(format || '').toLowerCase();
            if (normalized === 'json' || /json/.test(normalized)) return sanitizeJsonText(text);
            if (/^(?:vtt|webvtt)$/.test(normalized)) return sanitizeWebVttText(text);
            if (/^(?:xml|ttml|dfxp|mpd)$/.test(normalized)) return sanitizeXmlText(text);
            if (/^(?:m3u8|hls|manifest)$/.test(normalized) || /manifest|playlist/i.test(String(kind || ''))) {
                return sanitizeManifestText(text);
            }
            addWarning('sanitizer:unsupported-artifact-format');
            if (data) data.sanitization.redactions++;
            return '[REDACTED_ARTIFACT]';
        }

        function reserve(value) {
            var encoded = safeJson(value);
            if (!encoded) return false;
            var size = byteLength(encoded);
            if (capturedBytes + size > limits.maxCaptureBytes) {
                markTruncated('maxCaptureBytes');
                return false;
            }
            capturedBytes += size;
            return true;
        }

        function captureEvent(type, eventData, context, internal) {
            if (state !== 'recording') return false;
            if (data.events.length >= limits.maxEvents) {
                markTruncated('maxEvents');
                return false;
            }
            var safeType = sanitizeEventType(type);
            var safeContext = context && typeof context === 'object' ? context : {};
            var record = {
                seq: ++eventSequence,
                t: Math.max(0, Math.round(safeNow() - startedAtMs)),
                type: safeType,
                data: {}
            };
            if (safeContext.session != null && safeContext.session !== '') record.session = mapSession(safeContext.session);
            if (eventData !== undefined) {
                var sanitizedEventData = sanitizeValue(eventData, '', 0, []);
                record.data = sanitizedEventData && typeof sanitizedEventData === 'object' && !Array.isArray(sanitizedEventData) ?
                    sanitizedEventData : { value: sanitizedEventData };
            }
            if (!reserve(record)) return false;
            data.events.push(record);
            return true;
        }

        function captureSnapshot(kind, snapshotData, context) {
            try {
                if (state !== 'recording') return false;
                if (data.snapshots.length >= limits.maxSnapshots) {
                    markTruncated('maxSnapshots');
                    return false;
                }
                var safeContext = context && typeof context === 'object' ? context : {};
                var record = {
                    seq: ++eventSequence,
                    t: Math.max(0, Math.round(safeNow() - startedAtMs)),
                    kind: sanitizeKind(kind, 'snapshot'),
                    data: {}
                };
                var sanitizedSnapshotData = sanitizeValue(snapshotData, '', 0, []);
                record.data = sanitizedSnapshotData && typeof sanitizedSnapshotData === 'object' && !Array.isArray(sanitizedSnapshotData) ?
                    sanitizedSnapshotData : { value: sanitizedSnapshotData };
                if (safeContext.session != null && safeContext.session !== '') record.session = mapSession(safeContext.session);
                if (!reserve(record)) return false;
                data.snapshots.push(record);
                return true;
            } catch (error) {
                lastError = 'snapshot-failed';
                return false;
            }
        }

        function captureArtifact(kind, text, metadata) {
            try {
                if (state !== 'recording') return null;
                var requestedKind = String(kind == null ? '' : kind);
                var requestedFormat = metadata && typeof metadata === 'object' ? String(metadata.format || '') : '';
                if (DRM_ARTIFACT.test(requestedKind) || DRM_ARTIFACT.test(requestedFormat)) {
                    flagCriticalSecret('drm-artifact');
                    return null;
                }
                if (PROHIBITED_ARTIFACT.test(requestedKind) || PROHIBITED_ARTIFACT.test(requestedFormat)) {
                    addWarning('sanitizer:prohibited-artifact-ignored');
                    return null;
                }
                if (data && data.artifacts && Object.keys(data.artifacts).length >= limits.maxArtifacts) {
                    markTruncated('maxArtifacts');
                    return null;
                }
                var source = String(text == null ? '' : text);
                if (byteLength(source) > limits.maxArtifactBytes) markTruncated('maxArtifactBytes');
                var safeMetadata = metadata && typeof metadata === 'object' ? metadata : {};
                var format = sanitizeFormat(safeMetadata.format || '');
                var sanitizedText = sanitizeArtifactText(kind, source, format);
                if (byteLength(sanitizedText) > limits.maxArtifactBytes) {
                    sanitizedText = truncateUtf8(sanitizedText, limits.maxArtifactBytes);
                    markTruncated('maxArtifactBytes');
                }
                var identifier = 'ARTIFACT_' + (++artifactSequence);
                var record = {
                    kind: sanitizeKind(kind, 'artifact'),
                    format: format,
                    text: sanitizedText,
                    byteLength: byteLength(sanitizedText)
                };
                if (safeMetadata.url) {
                    var safeArtifactUrl = sanitizeUrl(safeMetadata.url);
                    if (/^https?:\/\//i.test(safeArtifactUrl)) record.url = safeArtifactUrl;
                }
                var metadataCopy = {};
                Object.keys(safeMetadata).forEach(function (key) {
                    if (key !== 'url' && key !== 'format') metadataCopy[key] = safeMetadata[key];
                });
                if (Object.keys(metadataCopy).length) record.metadata = sanitizeValue(metadataCopy, '', 0, []);
                if (!reserve(record)) return null;
                data.artifacts[identifier] = record;
                return identifier;
            } catch (error) {
                lastError = 'artifact-failed';
                return null;
            }
        }

        function sanitizePage() {
            var supplied = options.page && typeof options.page === 'object' ? options.page : {};
            var host = String(supplied.host || '');
            var path = String(supplied.path || '');
            if ((!host || !path) && options.pageUrl) {
                try {
                    var parsed = new URL(String(options.pageUrl));
                    host = host || parsed.host;
                    path = path || parsed.pathname;
                } catch (error) {
                    addWarning('sanitizer:invalid-page-url');
                }
            }
            var safePath = sanitizeUrl(path || '/');
            return {
                host: truncateUtf8(host.replace(/[^A-Za-z0-9.:-]/g, ''), 255),
                path: safePath.split('?')[0] || '/'
            };
        }

        function start(context) {
            try {
                if (state === 'recording') return false;
                state = 'idle';
                data = null;
                capturedBytes = 0;
                artifactSequence = 0;
                eventSequence = 0;
                warningKeys = Object.create(null);
                securityBlocked = false;
                lastError = '';
                resetMappings();
                startedAtMs = safeNow();
                data = {
                    schemaVersion: 1,
                    captureToolVersion: CAPTURE_TOOL_VERSION,
                    service: sanitizeIdentifier(options.service, 'unknown'),
                    scriptVersion: sanitizeIdentifier(options.scriptVersion, 'unknown'),
                    page: {},
                    capture: {
                        startedAt: safeIsoTime(startedAtMs),
                        durationMs: 0,
                        truncated: false,
                        limits: cloneJson(limits)
                    },
                    events: [],
                    artifacts: {},
                    snapshots: [],
                    observed: {},
                    sanitization: {
                        version: SANITIZATION_VERSION,
                        redactions: 0,
                        warnings: []
                    }
                };
                data.page = sanitizePage();
                capturedBytes = byteLength(safeJson(data));
                if (capturedBytes > limits.maxCaptureBytes) {
                    data = null;
                    lastError = 'capture-limit-too-small';
                    return false;
                }
                state = 'recording';
                captureEvent('capture.start', context || {}, null, true);
                return true;
            } catch (error) {
                state = 'idle';
                data = null;
                lastError = 'start-failed';
                return false;
            }
        }

        function stop(observed) {
            try {
                if (state !== 'recording') return false;
                if (observed !== undefined) {
                    var safeObserved = sanitizeValue(observed, '', 0, []);
                    data.observed = safeObserved && typeof safeObserved === 'object' && !Array.isArray(safeObserved) ?
                        safeObserved : { value: safeObserved };
                }
                captureEvent('capture.stop', {}, null, true);
                data.capture.durationMs = Math.max(0, Math.round(safeNow() - startedAtMs));
                state = 'stopped';
                return true;
            } catch (error) {
                state = data ? 'stopped' : 'idle';
                lastError = 'stop-failed';
                return false;
            }
        }

        function setObserved(observed) {
            try {
                if (state !== 'recording' || !data) return false;
                var safeObserved = sanitizeValue(observed, '', 0, []);
                safeObserved = safeObserved && typeof safeObserved === 'object' && !Array.isArray(safeObserved) ?
                    safeObserved : { value: safeObserved };
                if (!reserve(safeObserved)) return false;
                data.observed = safeObserved;
                return true;
            } catch (error) {
                lastError = 'observed-failed';
                return false;
            }
        }

        function clear() {
            try {
                data = null;
                state = 'idle';
                startedAtMs = 0;
                capturedBytes = 0;
                artifactSequence = 0;
                eventSequence = 0;
                warningKeys = Object.create(null);
                securityBlocked = false;
                lastError = '';
                resetMappings();
                return true;
            } catch (error) {
                return false;
            }
        }

        function scanExport(serialized) {
            return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(serialized) ||
                /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+=\/-]{8,}/i.test(serialized) ||
                /\bAKIA[0-9A-Z]{16}\b/.test(serialized) ||
                /\bgh[pousr]_[A-Za-z0-9]{20,}\b/.test(serialized) ||
                /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(serialized) ||
                /"(?:authorization|cookie|set-cookie)"\s*:\s*"(?!REDACTED(?:_SECRET)?")[^"]+"/i.test(serialized) ||
                /[?&](?:token|sig|signature|policy|key|auth|credential)=(?!REDACTED(?:%20|\b))[^&#"\s]+/i.test(serialized) ||
                /(?:^|[\/~;,])(?:dvt\d*|exp(?:ires)?|signature|sig|policy|tokens?|auth(?:orization)?|credentials?|psid|playback_?session_?id)=(?!REDACTED(?:%20|\b)|TOKEN_[1-9]\d*(?:[\/~;,]|$))[^\s"'<>]*/im.test(serialized);
        }

        function compactExport(result) {
            var serialized = safeJson(result);
            if (!serialized) return null;
            if (byteLength(serialized) <= limits.maxCaptureBytes) return result;
            result.capture.truncated = true;
            if (result.sanitization.warnings.indexOf('limit:export-size') < 0) result.sanitization.warnings.push('limit:export-size');
            var artifactIds = Object.keys(result.artifacts).reverse();
            while (byteLength(safeJson(result)) > limits.maxCaptureBytes && artifactIds.length) {
                delete result.artifacts[artifactIds.shift()];
            }
            while (byteLength(safeJson(result)) > limits.maxCaptureBytes && result.snapshots.length) result.snapshots.pop();
            while (byteLength(safeJson(result)) > limits.maxCaptureBytes && result.events.length > 1) result.events.pop();
            return byteLength(safeJson(result)) <= limits.maxCaptureBytes ? result : null;
        }

        function exportObject() {
            try {
                if (!data || state === 'idle') return null;
                var result = cloneJson(data);
                if (!result) {
                    lastError = 'export-serialization-failed';
                    return null;
                }
                if (state === 'recording') result.capture.durationMs = Math.max(0, Math.round(safeNow() - startedAtMs));
                result = compactExport(result);
                if (!result) {
                    lastError = 'export-size-limit';
                    return null;
                }
                var serialized = safeJson(result);
                if (securityBlocked || scanExport(serialized)) {
                    securityBlocked = true;
                    lastError = 'export-blocked-sensitive-data';
                    return null;
                }
                return result;
            } catch (error) {
                lastError = 'export-failed';
                return null;
            }
        }

        function exportBlob(pretty) {
            try {
                var result = exportObject();
                if (!result) return null;
                var BlobConstructor = options.Blob;
                if (!BlobConstructor && typeof Blob !== 'undefined') BlobConstructor = Blob;
                if (typeof BlobConstructor !== 'function') {
                    lastError = 'blob-unavailable';
                    return null;
                }
                return new BlobConstructor([JSON.stringify(result, null, pretty === false ? 0 : 2)], {
                    type: 'application/json;charset=utf-8'
                });
            } catch (error) {
                lastError = 'blob-export-failed';
                return null;
            }
        }

        function status() {
            try {
                return {
                    state: state,
                    recording: state === 'recording',
                    eventCount: data ? data.events.length : 0,
                    artifactCount: data ? Object.keys(data.artifacts).length : 0,
                    snapshotCount: data ? data.snapshots.length : 0,
                    truncated: !!(data && data.capture.truncated),
                    exportBlocked: securityBlocked,
                    lastError: lastError
                };
            } catch (error) {
                return {
                    state: state,
                    recording: false,
                    eventCount: 0,
                    artifactCount: 0,
                    snapshotCount: 0,
                    truncated: false,
                    exportBlocked: true,
                    lastError: 'status-failed'
                };
            }
        }

        return {
            start: start,
            stop: stop,
            clear: clear,
            event: function (type, eventData, context) {
                try {
                    return captureEvent(type, eventData, context, false);
                } catch (error) {
                    lastError = 'event-failed';
                    return false;
                }
            },
            artifact: captureArtifact,
            snapshot: captureSnapshot,
            setObserved: setObserved,
            exportObject: exportObject,
            exportBlob: exportBlob,
            status: status
        };
    }
    // END SHARED FIXTURE CAPTURE CORE

    var fixtureCaptureEnabled = consumeFixtureCaptureArm();
    var fixtureCapture = fixtureCaptureEnabled ? createFixtureCapture({
        service: 'coupang',
        scriptVersion: currentUserscriptVersion(),
        page: {
            host: location.host,
            path: location.pathname || '/'
        },
        Blob: typeof Blob === 'function' ? Blob : null
    }) : null;
    var fixtureCaptureRecording = false;
    var fixtureSnapshotValues = fixtureCaptureEnabled ? Object.create(null) : null;
    var fixtureMetadataArtifactCache = fixtureCaptureEnabled ? [] : null;
    var fixtureCaptureMenuCommandIds = [];

    init();

    function currentUserscriptVersion() {
        try {
            if (typeof GM_info === 'object' && GM_info && GM_info.script &&
                typeof GM_info.script.version === 'string' && GM_info.script.version) {
                return GM_info.script.version;
            }
        } catch (err) {}
        return 'unknown';
    }

    function consumeFixtureCaptureArm() {
        try {
            if (window.top !== window) return false;
            var storage = window.sessionStorage;
            var rawExpiry = storage.getItem(FIXTURE_CAPTURE_ARM_KEY);
            if (!rawExpiry) return false;
            storage.removeItem(FIXTURE_CAPTURE_ARM_KEY);
            var expiresAt = Number(rawExpiry);
            var remainingMs = expiresAt - Date.now();
            return isFinite(expiresAt) && remainingMs >= 0 && remainingMs <= FIXTURE_CAPTURE_ARM_TTL_MS;
        } catch (err) {
            return false;
        }
    }

    function armFixtureCaptureAndReload() {
        try {
            if (window.top !== window) return false;
            window.sessionStorage.setItem(FIXTURE_CAPTURE_ARM_KEY, String(Date.now() + FIXTURE_CAPTURE_ARM_TTL_MS));
            location.reload();
            return true;
        } catch (err) {
            debuglog('Could not arm fixture capture for this tab.');
            return false;
        }
    }

    function installFixtureCaptureCommands(skipAutoStart) {
        try {
            if (window.top !== window) return;
        } catch (err) {
            return;
        }
        if (!skipAutoStart && fixtureCapture) startFixtureCapture('menu-armed-reload');
        if (typeof GM_registerMenuCommand !== 'function') return;

        try {
            if (typeof GM_unregisterMenuCommand === 'function') {
                fixtureCaptureMenuCommandIds.forEach(function (commandId) {
                    try { GM_unregisterMenuCommand(commandId); } catch (err) {}
                });
            }
            fixtureCaptureMenuCommandIds = [];

            function registerCommand(label, handler) {
                var commandId = GM_registerMenuCommand(label, handler);
                if (commandId !== undefined && commandId !== null) fixtureCaptureMenuCommandIds.push(commandId);
            }

            if (!fixtureCaptureRecording) {
                registerCommand('[Fixture] Start capture and reload this tab', armFixtureCaptureAndReload);
                return;
            }
            registerCommand('[Fixture] Start/restart capture', function () {
                startFixtureCapture('menu-restart');
                installFixtureCaptureCommands(true);
                printFixtureCaptureStatus();
            });
            registerCommand('[Fixture] Stop and export', function () {
                exportFixtureCapture(true);
            });
            registerCommand('[Fixture] Export snapshot', function () {
                exportFixtureCapture(false);
            });
            registerCommand('[Fixture] Clear capture', function () {
                fixtureCapture.clear();
                fixtureCaptureRecording = false;
                fixtureSnapshotValues = Object.create(null);
                fixtureMetadataArtifactCache = [];
                installFixtureCaptureCommands(true);
                printFixtureCaptureStatus();
            });
            registerCommand('[Fixture] Print status', printFixtureCaptureStatus);
        } catch (err) {
            debuglog('Could not register fixture capture commands.');
        }
    }

    function startFixtureCapture(reason) {
        if (!fixtureCapture) return false;
        try {
            fixtureCapture.clear();
            fixtureSnapshotValues = Object.create(null);
            fixtureMetadataArtifactCache = [];
            fixtureCaptureRecording = fixtureCapture.start({ reason: reason || 'manual' });
            return fixtureCaptureRecording;
        } catch (err) {
            fixtureCaptureRecording = false;
            return false;
        }
    }

    function fixtureObservedState() {
        return {
            metadata: fixtureMetadataState(),
            outputFilename: state.outputFilename || '',
            status: state.status || '',
            lastErrorCode: fixtureErrorCode(state.lastError),
            tracks: state.tracks.map(fixtureTrackSummary)
        };
    }

    function exportFixtureCapture(stopFirst) {
        if (!fixtureCapture) return;
        try {
            if (fixtureCaptureRecording) {
                if (stopFirst) {
                    fixtureCapture.stop(fixtureObservedState());
                    fixtureCaptureRecording = false;
                    installFixtureCaptureCommands(true);
                } else {
                    fixtureCapture.setObserved(fixtureObservedState());
                }
            }
            var blob = fixtureCapture.exportBlob(true);
            if (!blob) {
                printFixtureCaptureStatus();
                return;
            }
            var timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            saveAs(blob, 'coupang-' + timestamp + '.fixture.local.json');
            printFixtureCaptureStatus();
        } catch (err) {
            debuglog('Fixture export failed.');
        }
    }

    function printFixtureCaptureStatus() {
        if (!fixtureCapture) return;
        try { console.info(LOG_PREFIX + ' Fixture capture status ' + JSON.stringify(fixtureCapture.status())); } catch (err) {}
    }

    function captureCoupang(type, sessionId, payloadFactory) {
        if (!fixtureCaptureRecording || !fixtureCapture) return false;
        try {
            var payload = typeof payloadFactory === 'function' ? payloadFactory() : (payloadFactory || {});
            return fixtureCapture.event(type, payload, { session: sessionId || '' });
        } catch (err) {
            return false;
        }
    }

    function captureCoupangResource(url, source, sessionId) {
        if (!fixtureCaptureRecording || !fixtureCapture) return false;
        var kind = fixtureResourceKind(url);
        if (!/^(?:hls-manifest|dash-manifest|subtitle|metadata)$/.test(kind)) return false;
        return captureCoupang('resource.observed', sessionId, function () {
            return { url: url, source: source || '', kind: kind };
        });
    }

    function captureCoupangArtifact(kind, text, metadataFactory) {
        if (!fixtureCaptureRecording || !fixtureCapture) return null;
        try {
            if (kind === 'metadata-structure' && fixtureMetadataArtifactCache) {
                for (var index = 0; index < fixtureMetadataArtifactCache.length; index++) {
                    if (fixtureMetadataArtifactCache[index].text === text) return fixtureMetadataArtifactCache[index].artifact;
                }
            }
            var metadata = typeof metadataFactory === 'function' ? metadataFactory() : (metadataFactory || {});
            var artifactId = fixtureCapture.artifact(kind, text, metadata);
            if (artifactId && kind === 'metadata-structure' && fixtureMetadataArtifactCache) {
                fixtureMetadataArtifactCache.push({ text: text, artifact: artifactId });
            }
            return artifactId;
        } catch (err) {
            return null;
        }
    }

    function captureCoupangSnapshot(kind, sessionId, payloadFactory) {
        if (!fixtureCaptureRecording || !fixtureCapture) return false;
        try {
            var payload = typeof payloadFactory === 'function' ? payloadFactory() : (payloadFactory || {});
            var dedupeKey = String(sessionId || '') + '\n' + JSON.stringify(payload);
            if (fixtureSnapshotValues[kind] === dedupeKey) return false;
            fixtureSnapshotValues[kind] = dedupeKey;
            return fixtureCapture.snapshot(kind, payload, { session: sessionId || '' });
        } catch (err) {
            return false;
        }
    }

    function fixtureTrackSummary(track) {
        track = track || {};
        return {
            name: track.NAME || '',
            language: track.LANGUAGE || '',
            forced: /^(?:YES|true|1)$/i.test(String(track.FORCED || '')),
            cc: /sdh|cc|caption|closed|transcribes/i.test(String(track.CHARACTERISTICS || '') + ' ' + String(track.NAME || '')),
            source: track.source || '',
            uri: track.URI || '',
            contentType: track.contentType || '',
            segmentCount: track.segments && track.segments.length ? track.segments.length : 0,
            activePlayback: !!track.activePlayback
        };
    }

    function fixtureMetadataState() {
        return {
            title: state.mediaTitle || '',
            titlePriority: state.mediaTitlePriority || 0,
            seasonNumber: state.seasonNumber,
            episodeNumber: state.episodeNumber,
            episodeTag: state.episodeTag || '',
            episodeTitle: state.episodeTitle || '',
            episodeConfirmed: !!state.episodeConfirmed
        };
    }

    function fixtureResourceKind(url) {
        if (/\/(?:drm|license|licenses|widevine|fairplay|playready|certificate|cert)(?:\/|[?#]|$)/i.test(url || '')) return 'ignored';
        if (isManifestUrl(url)) return /\.mpd(?:[?#]|$)/i.test(url || '') ? 'dash-manifest' : 'hls-manifest';
        if (isSubtitleUrl(url)) return 'subtitle';
        if (/api-(?:discover|playback)|\/discover\//i.test(url || '')) return 'metadata';
        if (/\.(?:m4s|mp4|ts|cmfv|cmfa)(?:[?#]|$)/i.test(url || '')) return 'media';
        return 'other';
    }

    function fixtureMetadataProjection(text) {
        if (!fixtureCaptureRecording || typeof text !== 'string' || !text || text.length > 500000) return '';
        var source;
        try { source = JSON.parse(text); } catch (err) { return ''; }
        var keySequence = 0;
        var stringSequence = 0;

        function normalizedKey(value) {
            return String(value || '')
                .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
                .replace(/[^a-z0-9]+/gi, '_')
                .toLowerCase();
        }

        function projectedKey(value) {
            var key = String(value || '');
            if (/^[A-Za-z_$][A-Za-z0-9_$.-]{0,79}$/.test(key) &&
                !/@/.test(key) && !/^[A-Fa-f0-9]{16,}$/.test(key) && !/^[A-Za-z0-9_-]{32,}$/.test(key)) return key;
            keySequence++;
            return 'FIELD_' + keySequence;
        }

        function placeholderString(value, key, path) {
            var normalized = normalizedKey(key);
            var normalizedPath = normalizedKey(path || key);
            if (/(?:^|_)(?:authorization|cookies?|password|passwd|secrets?|tokens?|signatures?|credentials?|api_keys?|private_keys?)(?:$|_)/.test(normalizedPath)) {
                return 'REDACTED';
            }
            if (/(?:^|_)(?:accounts?|profiles?|subscribers?|customers?|users?|viewers?|persons?|members?)(?:$|_)/.test(normalizedPath) &&
                /(?:^|_)(?:id|name|email|phone|address|birth|gender)(?:$|_)/.test(normalizedPath)) {
                return 'REDACTED';
            }
            if (/(?:^|_)(?:url|uri|href|src|manifest|playlist)(?:$|_)/.test(normalized)) return 'URL_001';
            if (/(?:^|_)(?:id|(?:movie|content|playable|episode|asset|account|profile|subscriber|customer|user|viewer|device|parent|title)_?id)(?:$|_)/.test(normalized)) return 'TOKEN_001';
            var episodeTag = value ? seasonEpisodeTag(value) : '';
            if (episodeTag) return episodeTag;
            if (/(?:season|episode)/.test(normalizedPath) && /^\d{1,3}$/.test(value)) return value;
            if (/(?:^|_)(?:language|locale)(?:$|_)/.test(normalized) && /^[A-Za-z]{2,3}(?:[-_][A-Za-z]{2})?$/.test(value)) return value;
            if (/(?:series|show|program|collection|franchise|parent)/.test(normalizedPath) && /(?:title|name)/.test(normalized)) return 'SHOW_001';
            if (/(?:title|name)/.test(normalized)) return 'TITLE_001';
            stringSequence++;
            return 'STRING_' + stringSequence;
        }

        function project(value, key, path, depth) {
            if (value == null || typeof value === 'boolean') return value;
            if (typeof value === 'string') return placeholderString(value, key, path);
            var normalizedPath = normalizedKey(path || key);
            if (typeof value === 'number') {
                return /(?:season|episode)/.test(normalizedPath) && isFinite(value) && value > 0 && value < 1000 ? value : 0;
            }
            if (typeof value !== 'object') return null;
            if (depth >= 10) return '[MAX_DEPTH]';
            if (Array.isArray(value)) {
                return value.slice(0, 50).map(function (item) {
                    return project(item, key, path, depth + 1);
                });
            }
            var result = Object.create(null);
            Object.keys(value).slice(0, 100).forEach(function (property) {
                var safeProperty = projectedKey(property);
                while (Object.prototype.hasOwnProperty.call(result, safeProperty)) safeProperty += '_';
                result[safeProperty] = project(value[property], property, path ? path + '_' + property : property, depth + 1);
            });
            return result;
        }

        try {
            return JSON.stringify(project(source, '', '', 0), null, 2);
        } catch (err) {
            return '';
        }
    }

    function fixtureManifestText(text) {
        if (!fixtureCaptureRecording || typeof text !== 'string' || !text || text.length > 500000) return '';
        return text;
    }

    function fixtureErrorCode(error) {
        var value = String(error && error.message ? error.message : (error || ''));
        if (!value) return '';
        if (/stale|playback changed/i.test(value)) return 'stale-session';
        if (/timeout/i.test(value)) return 'timeout';
        if (/network/i.test(value)) return 'network';
        if (/HTTP\s+\d+/i.test(value)) return 'http';
        if (/No subtitle|No VTT|No cue|empty/i.test(value)) return 'empty-output';
        if (/manifest/i.test(value)) return 'manifest';
        return 'unknown';
    }

    function init() {
        if (state.initialized) return;
        state.initialized = true;

        installFixtureCaptureCommands();
        installSessionBridge();
        requestPlaybackSession();
        if (isTopFrame()) {
            installNavigationHooks();
            tick();
        }
        installNetworkHooks();
        startPerformanceObserver();
        if (isTopFrame()) {
            installStyles();
            installFrameBridge();
            scheduleUi();
            setInterval(tick, 1000);
            tick();
        } else if (!state.observer) {
            setInterval(function () {
                if (isPlaybackContext()) scanPerformanceEntries();
            }, 5000);
        }
        debuglog('Script loaded');
    }

    function tick() {
        var pageKey = isCoupangPlayPage() ? location.href.split('#')[0] : '';
        var playbackPage = isPlaybackPage();
        if (state.oldlocation !== pageKey) {
            captureCoupang('navigation.changed', state.playbackSessionId, function () {
                return {
                    hadPreviousPlayback: !!state.oldlocation,
                    playback: playbackPage,
                    path: location.pathname || '/'
                };
            });
            state.oldlocation = pageKey;
            if (playbackPage) {
                beginPlaybackSession();
                state.playbackActive = true;
                resetTracks();
                refreshMediaMetadataFromDom();
                scanPerformanceEntries();
                state.lastMetadataScanAt = Date.now();
                state.lastPerformanceScanAt = Date.now();
                updateUi();
            } else {
                invalidatePlaybackSession();
                if (state.playbackActive) resetTracks();
                state.playbackActive = false;
                hideWidget();
            }
        }

        if (!playbackPage) {
            hideWidget();
            return;
        }

        var now = Date.now();
        ensureStyles();
        if (now - state.lastPerformanceScanAt >= 5000) {
            scanPerformanceEntries();
            state.lastPerformanceScanAt = now;
        }
        if (now - state.lastMetadataScanAt >= 3000) {
            refreshMediaMetadataFromDom();
            state.lastMetadataScanAt = now;
        }
        if (hasPlaybackSurface()) {
            ensureWidget();
        } else {
            hideWidget();
        }
    }

    function installNavigationHooks() {
        if (!isTopFrame()) return;
        var historyObject;
        try {
            historyObject = targetWindow.history || window.history;
        } catch (err) {
            historyObject = window.history;
        }

        ['pushState', 'replaceState'].forEach(function (method) {
            try {
                if (!historyObject || typeof historyObject[method] !== 'function') return;
                var original = historyObject[method];
                if (original.__cpsdSessionPatched) return;
                var wrapped = function () {
                    var result = original.apply(this, arguments);
                    try { tick(); } catch (err) { debuglog('Navigation sync failed: ' + err.message); }
                    return result;
                };
                wrapped.__cpsdSessionPatched = true;
                historyObject[method] = wrapped;
            } catch (err) {
                debuglog('Could not patch history.' + method + ': ' + err.message);
            }
        });

        try {
            targetWindow.addEventListener('popstate', function () {
                try { tick(); } catch (err) { debuglog('Navigation sync failed: ' + err.message); }
            }, false);
        } catch (err) {}
    }

    function isCoupangPlayPage() {
        return isCoupangHost(location.hostname);
    }

    function isPlaybackPage() {
        return isCoupangPlayPage() && isPlaybackPath(location.pathname);
    }

    function isPlaybackPath(pathname) {
        return /^\/play(?:\/|$)/i.test(pathname || '');
    }

    function isPlaybackContext() {
        if (isPlaybackPage()) return true;
        try {
            return window.top !== window &&
                isCoupangHost(window.top.location.hostname) &&
                isPlaybackPath(window.top.location.pathname);
        } catch (err) {
            return false;
        }
    }

    function isActivePlaybackObservation() {
        if (isTopFrame()) return isPlaybackPage() && hasPlaybackSurface();
        return !!state.playbackSessionId && !!state.topSessionOrigin && isPlaybackContext();
    }

    function isPlaybackResourceUrl(rawUrl) {
        var url = normalizeUrl(rawUrl);
        return /(?:\/play\/|playback|manifest|\.m3u8(?:[?#]|$)|\.mpd(?:[?#]|$)|\.vtt(?:[?#]|$)|\.webvtt(?:[?#]|$)|\.ttml(?:[?#]|$)|\.dfxp(?:[?#]|$)|\.srt(?:[?#]|$)|subtitle|caption|timedtext|texttrack)/i.test(url || '');
    }

    function shouldObserveNetworkRequest(rawUrl) {
        return isPlaybackContext() || isPlaybackResourceUrl(rawUrl);
    }

    function isCoupangHost(hostname) {
        return hostname === 'www.coupangplay.com' ||
            hostname === 'coupangplay.com' ||
            /\.coupangplay\.com$/i.test(hostname || '');
    }

    function isTopFrame() {
        try { return window.top === window; } catch (err) { return false; }
    }

    function hasPlaybackSurface() {
        if (!isTopFrame()) return false;
        if (hasPlayableVideo()) return true;
        return hasVisibleElement('#playerWrapper, [id*="player" i], [class*="playerWrapper"], [class*="Player_playerMain"], .video-js');
    }

    function hasPlayableVideo() {
        var videos = collectVideosDeep(document);
        for (var i = 0; i < videos.length; i++) {
            var video = videos[i];
            var rect = video.getBoundingClientRect();
            if (!rect || rect.width < 240 || rect.height < 160) continue;
            if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= window.innerHeight || rect.left >= window.innerWidth) continue;
            var style = window.getComputedStyle(video);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
            if (video.currentSrc || video.src || video.readyState > 0 || Number(video.duration) > 0) return true;
        }
        return false;
    }

    function hasVisibleElement(selector) {
        var nodes = document.querySelectorAll(selector);
        for (var i = 0; i < nodes.length; i++) {
            if (isVisibleRect(nodes[i])) return true;
        }
        return false;
    }

    function isVisibleRect(element) {
        var rect = element.getBoundingClientRect();
        if (rect.width < 240 || rect.height < 160) return false;
        if (rect.bottom <= 0 || rect.right <= 0) return false;
        if (rect.top >= window.innerHeight || rect.left >= window.innerWidth) return false;
        var style = window.getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }

    function collectVideosDeep(root) {
        var videos = [];
        collectVideosFromRoot(root, videos, 0);
        return videos;
    }

    function collectVideosFromRoot(root, videos, depth) {
        if (!root || depth > 8) return;
        try {
            if (root.querySelectorAll) {
                Array.prototype.forEach.call(root.querySelectorAll('video'), function (video) {
                    videos.push(video);
                });
                Array.prototype.forEach.call(root.querySelectorAll('*'), function (element) {
                    if (element.shadowRoot) {
                        collectVideosFromRoot(element.shadowRoot, videos, depth + 1);
                    }
                });
            }
        } catch (err) {
            debuglog('Could not inspect video root: ' + err.message);
        }
    }

    function beginPlaybackSession() {
        invalidateDownloadOperation();
        var nowEpochMs = Date.now();
        var initialLookbackMs = state.playbackSessionSequence === 0 ? 5000 : 0;
        state.playbackSessionSequence++;
        state.playbackSessionId = 'coupang:' + state.playbackSessionSequence + ':' + nowEpochMs.toString(36) + ':' + Math.random().toString(36).slice(2);
        state.playbackSessionEpochMs = nowEpochMs - initialLookbackMs;
        state.playbackSessionStartedAt = Math.max(0, performanceNow() - initialLookbackMs);
        captureCoupang('session.started', state.playbackSessionId, function () {
            return { sequence: state.playbackSessionSequence, initialLookbackMs: initialLookbackMs };
        });
        broadcastPlaybackSession();
    }

    function invalidatePlaybackSession() {
        var previousSessionId = state.playbackSessionId;
        captureCoupang('session.invalidated', previousSessionId, function () {
            return { hadSession: !!previousSessionId };
        });
        invalidateDownloadOperation();
        state.playbackSessionId = '';
        state.playbackSessionEpochMs = 0;
        state.playbackSessionStartedAt = performanceNow();
    }

    function adoptPlaybackSession(sessionId, startedAtEpochMs) {
        if (!sessionId || sessionId === state.playbackSessionId) return;
        var cutoff = Number(startedAtEpochMs) || 0;
        var pending = state.pendingSessionObservations.filter(function (observation) {
            return !cutoff || observation.observedAt >= cutoff;
        });
        state.pendingSessionObservations = [];
        state.pendingSessionObservationBytes = 0;
        invalidateDownloadOperation();
        state.playbackSessionId = sessionId;
        state.playbackSessionEpochMs = cutoff || Date.now();
        state.playbackSessionStartedAt = performanceNow();
        captureCoupang('session.adopted', sessionId, function () {
            return { pendingObservationCount: pending.length, hadCutoff: !!cutoff };
        });
        resetTracks();
        state.replayingSessionObservations = true;
        try {
            replayPendingSessionObservations(pending, sessionId);
        } finally {
            state.replayingSessionObservations = false;
        }
        scanPerformanceEntries(true);
    }

    function isPlaybackSessionCurrent(sessionId) {
        return !!sessionId && sessionId === state.playbackSessionId;
    }

    function resolveObservationSession(sessionId, observedAt) {
        if (isPlaybackSessionCurrent(sessionId)) return sessionId;
        if (!isTopFrame() && state.playbackSessionId && state.playbackSessionEpochMs && observedAt >= state.playbackSessionEpochMs) {
            return state.playbackSessionId;
        }
        return sessionId;
    }

    function rememberSessionObservation(observation, observedAt) {
        if (isTopFrame() || state.replayingSessionObservations || !observation) return false;
        observation.observedAt = Number(observedAt) || Date.now();
        observation.size = observation.text ? observation.text.length : 256;
        if (observation.size > 10000000) return !state.playbackSessionId;
        while (state.pendingSessionObservations.length &&
               (state.pendingSessionObservations.length >= 100 || state.pendingSessionObservationBytes + observation.size > 10000000)) {
            var removed = state.pendingSessionObservations.shift();
            state.pendingSessionObservationBytes -= removed.size || 0;
        }
        state.pendingSessionObservations.push(observation);
        state.pendingSessionObservationBytes += observation.size;
        return !state.playbackSessionId;
    }

    function replayPendingSessionObservations(observations, sessionId) {
        observations.forEach(function (observation) {
            if (!isPlaybackSessionCurrent(sessionId)) return;
            if (observation.type === 'resource') {
                recordResourceUrl(observation.rawUrl, observation.source, sessionId, observation.observedAt);
            } else if (observation.type === 'text') {
                inspectTextForResources(observation.baseUrl, observation.text, observation.source, sessionId, observation.observedAt);
            }
        });
    }

    function performanceNow() {
        try {
            var perf = targetWindow.performance || window.performance;
            if (perf && typeof perf.now === 'function') return perf.now();
        } catch (err) {}
        return 0;
    }

    function performanceEntryEpochMs(entry) {
        try {
            var perf = targetWindow.performance || window.performance;
            var timeOrigin = Number(perf && perf.timeOrigin);
            if (isFinite(timeOrigin) && entry && typeof entry.startTime === 'number') return timeOrigin + entry.startTime;
        } catch (err) {}
        return Date.now();
    }

    function isPlainMessageObject(value) {
        return !!value && typeof value === 'object' && !Array.isArray(value);
    }

    function isDescendantFrameSource(source) {
        if (!isTopFrame() || !source || source === window) return false;
        try {
            return source.top === window;
        } catch (err) {
            return false;
        }
    }

    function isValidSessionId(sessionId) {
        return typeof sessionId === 'string' && /^coupang\:[A-Za-z0-9:._-]{1,248}$/.test(sessionId);
    }

    function isValidSessionStartedAt(value) {
        return typeof value === 'number' && isFinite(value) && value > 0 && value <= Date.now() + 60000;
    }

    function isSessionRequestMessage(data) {
        return isPlainMessageObject(data) && data.type === MESSAGE_TYPE_SESSION_REQUEST;
    }

    function isSessionMessage(data) {
        return isPlainMessageObject(data) && data.type === MESSAGE_TYPE_SESSION &&
            isValidSessionId(data.sessionId) && isValidSessionStartedAt(data.sessionStartedAtEpochMs);
    }

    function isTrackMessage(data) {
        return isPlainMessageObject(data) && data.type === MESSAGE_TYPE_TRACK &&
            isValidSessionId(data.sessionId) && isPlainMessageObject(data.track);
    }

    function registerSessionClient(source, origin) {
        if (!isTopFrame() || !isDescendantFrameSource(source) || !isTrustedCoupangOrigin(origin)) return false;
        for (var i = 0; i < state.sessionClients.length; i++) {
            if (state.sessionClients[i].source === source) {
                state.sessionClients[i].origin = origin;
                return true;
            }
        }
        if (state.sessionClients.length >= MAX_SESSION_CLIENTS) return false;
        state.sessionClients.push({ source: source, origin: origin });
        return true;
    }

    function isRegisteredSessionClient(source, origin) {
        if (!isTopFrame() || !isDescendantFrameSource(source) || !isTrustedCoupangOrigin(origin)) return false;
        for (var i = 0; i < state.sessionClients.length; i++) {
            if (state.sessionClients[i].source === source && state.sessionClients[i].origin === origin) return true;
        }
        return false;
    }

    function installSessionBridge() {
        window.addEventListener('message', function (event) {
            var data = event.data;
            if (!isPlainMessageObject(data) || !isTrustedCoupangOrigin(event.origin)) return;

            if (isSessionRequestMessage(data) && isTopFrame()) {
                if (!registerSessionClient(event.source, event.origin)) return;
                if (!state.playbackSessionId) return;
                try {
                    event.source.postMessage({
                        type: MESSAGE_TYPE_SESSION,
                        sessionId: state.playbackSessionId,
                        sessionStartedAtEpochMs: state.playbackSessionEpochMs
                    }, event.origin);
                } catch (err) {
                    debuglog('Could not reply with playback session: ' + err.message);
                }
                return;
            }

            if (isSessionMessage(data) && !isTopFrame()) {
                if (event.source !== window.top) return;
                if (state.topSessionOrigin && event.origin !== state.topSessionOrigin) return;
                if (state.playbackSessionEpochMs && Number(data.sessionStartedAtEpochMs) < state.playbackSessionEpochMs) return;
                state.topSessionOrigin = event.origin;
                adoptPlaybackSession(data.sessionId, data.sessionStartedAtEpochMs);
            }
        });
    }

    function requestPlaybackSession() {
        if (isTopFrame()) return;
        var attempts = 0;
        function request() {
            if (state.playbackSessionId || attempts >= 40) return;
            attempts++;
            try {
                window.top.postMessage({ type: MESSAGE_TYPE_SESSION_REQUEST }, '*');
            } catch (err) {
                debuglog('Could not request playback session: ' + err.message);
            }
            if (!state.playbackSessionId) setTimeout(request, 250);
        }
        request();
    }

    function broadcastPlaybackSession() {
        if (!isTopFrame() || !state.playbackSessionId) return;
        var activeClients = [];
        state.sessionClients.forEach(function (client) {
            if (!isDescendantFrameSource(client.source) || !isTrustedCoupangOrigin(client.origin)) return;
            try {
                client.source.postMessage({
                    type: MESSAGE_TYPE_SESSION,
                    sessionId: state.playbackSessionId,
                    sessionStartedAtEpochMs: state.playbackSessionEpochMs
                }, client.origin);
                activeClients.push(client);
            } catch (err) {}
        });
        state.sessionClients = activeClients;
    }

    function installFrameBridge() {
        window.addEventListener('message', function (event) {
            var data = event.data;
            if (!isTrackMessage(data)) return;
            if (!isTrustedCoupangOrigin(event.origin)) return;
            if (!isRegisteredSessionClient(event.source, event.origin)) return;
            if (data.sessionId !== state.playbackSessionId) return;
            var track = sanitizeTrackMessage(data.track);
            if (!track) return;
            addTrack(track, true);
            state.status = 'Ready. Select a subtitle track.';
            updateUi();
        });
    }

    function isTrustedCoupangOrigin(origin) {
        try {
            var parsed = new URL(origin);
            if (parsed.protocol !== 'https:') return false;
            var host = parsed.hostname;
            return isCoupangHost(host);
        } catch (err) {
            return false;
        }
    }

    function isSafeMessageUrl(value) {
        if (typeof value !== 'string' || !value || value.length > 8192) return false;
        try {
            var parsed = new URL(value);
            return parsed.protocol === 'https:' || parsed.protocol === 'http:';
        } catch (err) {
            return false;
        }
    }

    function sanitizedMessageString(value, maxLength) {
        if (value == null) return '';
        if (typeof value !== 'string' || value.length > maxLength) return null;
        return value;
    }

    function isSafeMessageSegments(segments) {
        if (segments == null) return true;
        if (!Array.isArray(segments) || segments.length > MAX_MESSAGE_TRACK_SEGMENTS) return false;
        for (var i = 0; i < segments.length; i++) {
            if (!isSafeMessageUrl(segments[i])) return false;
        }
        return true;
    }

    function cloneSafeMessageSegments(segments) {
        return segments == null ? null : segments.slice();
    }

    function isSafeMessageByteRange(range) {
        if (range == null) return true;
        if (!isPlainMessageObject(range) || typeof range.offset !== 'number' || typeof range.length !== 'number') return false;
        var offset = range.offset;
        var length = range.length;
        return isFinite(offset) && Math.floor(offset) === offset && offset >= 0 && offset <= 9007199254740991 &&
            isFinite(length) && Math.floor(length) === length && length > 0 && length <= 9007199254740991 &&
            offset + length - 1 <= 9007199254740991;
    }

    function cloneSafeMessageByteRange(range) {
        return range == null ? null : { offset: Number(range.offset), length: Number(range.length) };
    }

    function isSafeMessageHlsMap(map) {
        return map == null || (isPlainMessageObject(map) && isSafeMessageUrl(map.url) && isSafeMessageByteRange(map.byterange));
    }

    function isSafeMessageHlsSegments(entries) {
        if (entries == null) return true;
        if (!Array.isArray(entries) || entries.length > MAX_MESSAGE_TRACK_SEGMENTS) return false;
        for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            if (!isPlainMessageObject(entry) || !isSafeMessageUrl(entry.url) ||
                !isSafeMessageByteRange(entry.byterange) || !isSafeMessageHlsMap(entry.map)) return false;
        }
        return true;
    }

    function cloneSafeMessageHlsSegments(entries) {
        if (entries == null) return null;
        return entries.map(function (entry) {
            return {
                url: entry.url,
                byterange: cloneSafeMessageByteRange(entry.byterange),
                map: entry.map == null ? null : {
                    url: entry.map.url,
                    byterange: cloneSafeMessageByteRange(entry.map.byterange)
                }
            };
        });
    }

    function sanitizeTrackMessage(track) {
        if (!isPlainMessageObject(track) || !isSafeMessageUrl(track.URI)) return null;
        var name = sanitizedMessageString(track.NAME, 512);
        var language = sanitizedMessageString(track.LANGUAGE, 64);
        var forced = sanitizedMessageString(track.FORCED, 16);
        var characteristics = sanitizedMessageString(track.CHARACTERISTICS, 1024);
        var type = sanitizedMessageString(track.TYPE, 256);
        var source = sanitizedMessageString(track.source, 128);
        var contentType = sanitizedMessageString(track.contentType, 256);
        if (name === null || language === null || forced === null || characteristics === null || type === null || source === null || contentType === null) return null;
        if (!isSafeMessageSegments(track.segments)) return null;
        if (!isSafeMessageHlsSegments(track.hlsSegments)) return null;
        if (track.activePlayback != null && typeof track.activePlayback !== 'boolean') return null;
        if (track.playlistDuration != null && (typeof track.playlistDuration !== 'number' || !isFinite(track.playlistDuration) || track.playlistDuration < 0 || track.playlistDuration > 2592000)) return null;
        return {
            NAME: name,
            LANGUAGE: language,
            FORCED: forced || 'NO',
            CHARACTERISTICS: characteristics,
            TYPE: type,
            URI: track.URI,
            source: source,
            segments: cloneSafeMessageSegments(track.segments),
            activePlayback: !!track.activePlayback,
            playlistDuration: track.playlistDuration == null ? null : track.playlistDuration,
            hlsSegments: cloneSafeMessageHlsSegments(track.hlsSegments),
            contentType: contentType,
        };
    }

    function forwardTrackToTop(track) {
        if (!state.playbackSessionId || !state.topSessionOrigin) return;
        var messageTrack = sanitizeTrackMessage(cloneTrackForMessage(track));
        if (!messageTrack) return;
        try {
            window.top.postMessage({ type: MESSAGE_TYPE_TRACK, sessionId: state.playbackSessionId, track: messageTrack }, state.topSessionOrigin);
        } catch (err) {
            debuglog('Could not forward track to top frame: ' + err.message);
        }
    }

    function cloneTrackForMessage(track) {
        return {
            NAME: track.NAME || '',
            LANGUAGE: track.LANGUAGE || '',
            FORCED: track.FORCED || 'NO',
            CHARACTERISTICS: track.CHARACTERISTICS || '',
            TYPE: track.TYPE || '',
            URI: track.URI || '',
            source: track.source || '',
            segments: track.segments || null,
            hlsSegments: track.hlsSegments || null,
            playlistDuration: track.playlistDuration || null,
            activePlayback: !!track.activePlayback,
            contentType: track.contentType || ''
        };
    }

    function scheduleUi() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', ensureWidget, false);
        } else {
            ensureWidget();
        }
    }

    function installStyles() {
        Array.prototype.forEach.call(document.querySelectorAll('style#cpsd-styles'), function (existing) {
            existing.parentNode.removeChild(existing);
        });

        var style = document.createElement('style');
        style.id = 'cpsd-styles';
        style.textContent = [
            '#cpsd-root{position:fixed;display:block;width:300px;top:0;left:calc(50% - 150px);z-index:2147483647;font-family:Arial,sans-serif;color:#fff;font-size:10px;pointer-events:auto}',
            '#cpsd-root *{box-sizing:border-box}',
            '#cpsd-menu{list-style:none;position:relative;width:300px;background:#333;color:#fff;padding:0;margin:auto;font-size:12px;z-index:2147483647}',
            '#cpsd-menu li{padding:10px;min-height:34px;line-height:14px;white-space:normal}',
            '#cpsd-menu li.cpsd-header{font-weight:bold;cursor:default}',
            '#cpsd-menu li:not(.cpsd-header){display:none;cursor:pointer}',
            '#cpsd-root:hover #cpsd-menu li,#cpsd-root:focus-within #cpsd-menu li{display:block}',
            '#cpsd-menu li:not(.cpsd-header):hover{background:#666}',
            '#cpsd-menu li.cpsd-info{cursor:default}',
            '#cpsd-menu li.cpsd-info:hover{background:transparent}',
            '#cpsd-menu li.cpsd-disabled{opacity:.45;cursor:not-allowed}',
            '#cpsd-menu li.cpsd-disabled:hover{background:transparent}',
            '#cpsd-track{width:100%;margin-top:6px;border:1px solid #555;background:#222;color:#fff;padding:4px;font-size:12px}',
            '#cpsd-status,#cpsd-filename{color:#ddd;word-break:break-word}',
            '#cpsd-progress{width:100%;height:10px;margin-top:6px;accent-color:#00a8e1}',
            '#cpsd-count,#cpsd-selected-name,#cpsd-format,#cpsd-progress-text{font-weight:normal}'
        ].join('\n');

        appendWhenPossible(style);
    }

    function ensureStyles() {
        if (document.getElementById('cpsd-styles')) return;
        installStyles();
    }

    function appendWhenPossible(node) {
        var parent = document.head || document.documentElement;
        if (parent) {
            parent.appendChild(node);
            return;
        }
        setTimeout(function () { appendWhenPossible(node); }, 25);
    }

    function ensureWidget() {
        if (!isPlaybackPage()) {
            hideWidget();
            return;
        }
        if (!document.body) {
            setTimeout(ensureWidget, 100);
            return;
        }
        ensureStyles();
        if (!hasPlaybackSurface()) {
            hideWidget();
            return;
        }

        var root = document.getElementById('cpsd-root');
        if (root) {
            root.style.display = '';
            updateUi();
            return;
        }

        root = document.createElement('div');
        root.id = 'cpsd-root';
        var menu = document.createElement('ol');
        menu.id = 'cpsd-menu';
        root.appendChild(menu);

        menu.appendChild(createMenuItem('', 'Coupang Play subtitle downloader', 'cpsd-header'));
        menu.appendChild(createMenuItem('cpsd-download', 'Download selected subtitle'));
        menu.appendChild(createMenuItem('cpsd-download-en', 'Download English subtitle'));
        menu.appendChild(createMenuItem('cpsd-download-ko', 'Download Korean subtitle'));
        menu.appendChild(createMenuItem('cpsd-download-en-ko', 'Download English + Korean subtitles'));
        menu.appendChild(createMenuItem('cpsd-download-all', 'Download all detected subtitles'));

        var selectedItem = createMenuItem('', 'Selected track: ', 'cpsd-info');
        var selectedName = document.createElement('span');
        selectedName.id = 'cpsd-selected-name';
        selectedName.textContent = 'none';
        var trackSelect = document.createElement('select');
        trackSelect.id = 'cpsd-track';
        selectedItem.appendChild(selectedName);
        selectedItem.appendChild(trackSelect);
        menu.appendChild(selectedItem);

        var countItem = createMenuItem('', 'Detected subtitles: ', 'cpsd-info');
        var countValue = document.createElement('span');
        countValue.id = 'cpsd-count';
        countValue.textContent = '0 tracks';
        countItem.appendChild(countValue);
        menu.appendChild(countItem);

        var formatItem = createMenuItem('', 'Subtitle format: ', 'cpsd-info');
        var formatValue = document.createElement('span');
        formatValue.id = 'cpsd-format';
        formatValue.textContent = 'WebVTT';
        formatItem.appendChild(formatValue);
        menu.appendChild(formatItem);

        var filenameItem = createMenuItem('', 'Output file: ', 'cpsd-info');
        var filenameValue = document.createElement('span');
        filenameValue.id = 'cpsd-filename';
        filenameValue.textContent = 'Waiting for a subtitle track...';
        filenameItem.appendChild(filenameValue);
        menu.appendChild(filenameItem);

        var progressItem = createMenuItem('', 'Progress: ', 'cpsd-info');
        var progressValue = document.createElement('span');
        progressValue.id = 'cpsd-progress-text';
        progressValue.textContent = 'Idle';
        var progressBar = document.createElement('progress');
        progressBar.id = 'cpsd-progress';
        progressBar.max = 1;
        progressBar.value = 0;
        progressItem.appendChild(progressValue);
        progressItem.appendChild(progressBar);
        menu.appendChild(progressItem);

        menu.appendChild(createMenuItem('cpsd-rescan', 'Rescan playback resources'));

        var statusItem = createMenuItem('', 'Status: ', 'cpsd-info');
        var statusValue = document.createElement('span');
        statusValue.id = 'cpsd-status';
        statusValue.textContent = state.status;
        statusItem.appendChild(statusValue);
        menu.appendChild(statusItem);

        document.body.appendChild(root);

        bindMenuAction('cpsd-rescan', function () {
            state.status = 'Rescanning playback resources...';
            scanPerformanceEntries(true);
            updateUi();
        });
        document.getElementById('cpsd-track').addEventListener('change', function () {
            state.selectedTrackKey = this.value;
            state.userSelectedTrack = true;
            updateUi();
        });
        bindMenuAction('cpsd-download', function () {
            if (state.wait || state.tracks.length === 0) return;
            var select = document.getElementById('cpsd-track');
            state.selectedTrackKey = select.value;
            state.userSelectedTrack = true;
            var track = findTrackByKey(select.value);
            if (track) downloadTrack(track);
        });
        bindMenuAction('cpsd-download-all', downloadAllTracks);
        bindMenuAction('cpsd-download-en', function () {
            downloadPreferredTrack('en');
        });
        bindMenuAction('cpsd-download-ko', function () {
            downloadPreferredTrack('ko');
        });
        bindMenuAction('cpsd-download-en-ko', downloadEnglishAndKorean);

        updateUi();
    }

    function hideWidget() {
        var root = document.getElementById('cpsd-root');
        if (root) root.style.display = 'none';
    }

    function createMenuItem(id, text, className) {
        var item = document.createElement('li');
        if (id) {
            item.id = id;
            item.setAttribute('role', 'button');
            item.setAttribute('tabindex', '0');
        }
        if (className) item.className = className;
        item.appendChild(document.createTextNode(text));
        return item;
    }

    function bindMenuAction(id, handler) {
        var node = document.getElementById(id);
        if (!node) return;
        node.addEventListener('click', function () {
            if (node.classList.contains('cpsd-disabled')) return;
            handler();
        });
        node.addEventListener('keydown', function (event) {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            if (node.classList.contains('cpsd-disabled')) return;
            handler();
        });
    }

    function updateUi() {
        var root = document.getElementById('cpsd-root');
        if (!root) return;
        if (!hasPlaybackSurface()) {
            hideWidget();
            return;
        }

        var select = document.getElementById('cpsd-track');
        var count = document.getElementById('cpsd-count');
        var status = document.getElementById('cpsd-status');
        var download = document.getElementById('cpsd-download');
        var downloadAll = document.getElementById('cpsd-download-all');
        var downloadEn = document.getElementById('cpsd-download-en');
        var downloadKo = document.getElementById('cpsd-download-ko');
        var downloadEnKo = document.getElementById('cpsd-download-en-ko');
        var selectedName = document.getElementById('cpsd-selected-name');
        var filename = document.getElementById('cpsd-filename');
        var progress = document.getElementById('cpsd-progress');
        var progressText = document.getElementById('cpsd-progress-text');
        var preferredEn = findPreferredTrack('en');
        var preferredKo = findPreferredTrack('ko');
        var desiredKey = state.userSelectedTrack ? state.selectedTrackKey : preferredSelectionKey();

        select.innerHTML = '';
        state.tracks.forEach(function (track) {
            var option = document.createElement('option');
            option.value = track.key;
            option.textContent = track.NAME;
            select.appendChild(option);
        });

        if (state.tracks.length === 0) {
            var empty = document.createElement('option');
            empty.textContent = 'No subtitles detected yet';
            empty.value = '';
            select.appendChild(empty);
        }

        if (!findTrackByKey(desiredKey)) desiredKey = preferredSelectionKey();
        if (desiredKey) {
            select.value = desiredKey;
            state.selectedTrackKey = desiredKey;
        }

        count.textContent = state.tracks.length + (state.tracks.length === 1 ? ' track' : ' tracks');
        selectedName.textContent = findTrackByKey(select.value) ? findTrackByKey(select.value).NAME : 'none';
        filename.textContent = state.wait && state.outputFilename ? state.outputFilename : previewSelectedFilename(select.value);
        updateProgressElement(progress, progressText);
        status.textContent = state.lastError || state.status;
        setMenuItemDisabled(download, state.wait || state.tracks.length === 0);
        setMenuItemDisabled(downloadAll, state.wait || state.tracks.length === 0);
        setMenuItemDisabled(downloadEn, state.wait || !preferredEn);
        setMenuItemDisabled(downloadKo, state.wait || !preferredKo);
        setMenuItemDisabled(downloadEnKo, state.wait || !preferredEn || !preferredKo);
        downloadEn.title = preferredEn ? preferredEn.NAME : 'No English subtitle detected yet';
        downloadKo.title = preferredKo ? preferredKo.NAME : 'No Korean subtitle detected yet';
        downloadEnKo.title = preferredEn && preferredKo ? preferredEn.NAME + ' + ' + preferredKo.NAME : 'English and Korean subtitles are both required';
    }

    function setMenuItemDisabled(node, disabled) {
        if (!node) return;
        node.classList.toggle('cpsd-disabled', !!disabled);
        node.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    }

    function previewSelectedFilename(trackKey) {
        return safeBaseFilename();
    }

    function operationOutputFilename(operation) {
        if (!operation || !operation.baseFilename) return 'Resolving title metadata...';
        if (operation.kind === 'all') return operation.baseFilename + '.subtitles.zip';
        if (operation.kind === 'en-ko') return operation.baseFilename + '.en-ko.subtitles.zip';
        return operation.baseFilename + '.' + safeTrackName(operation.track) + '.vtt';
    }

    function updateProgressElement(progress, progressText) {
        if (!progress || !progressText) return;
        var completed = Math.max(0, Number(state.progressCompleted) || 0);
        var total = Math.max(0, Number(state.progressTotal) || 0);
        var label = state.progressLabel || (state.wait ? 'Preparing...' : 'Idle');

        if (state.wait && total === 0) {
            progress.removeAttribute('value');
            progress.max = 1;
            progressText.textContent = label;
            return;
        }

        progress.max = Math.max(1, total);
        progress.value = Math.min(completed, Math.max(1, total));
        progressText.textContent = total > 0
            ? label + ' (' + completed + '/' + total + ', ' + Math.floor(completed * 100 / total) + '%)'
            : label;
    }

    function scheduleProgressUi(force) {
        var now = Date.now();
        var elapsed = now - state.lastProgressUiAt;
        var render = function () {
            state.progressUiTimer = null;
            state.lastProgressUiAt = Date.now();
            updateProgressElement(
                document.getElementById('cpsd-progress'),
                document.getElementById('cpsd-progress-text')
            );
        };

        if (force || elapsed >= 100) {
            if (state.progressUiTimer !== null) {
                clearTimeout(state.progressUiTimer);
                state.progressUiTimer = null;
            }
            render();
        } else if (state.progressUiTimer === null) {
            state.progressUiTimer = setTimeout(render, 100 - elapsed);
        }
    }

    function setDownloadProgress(operation, completed, total, label) {
        assertDownloadOperationCurrent(operation);
        operation.progressCompleted = Math.max(0, Number(completed) || 0);
        operation.progressTotal = Math.max(operation.progressCompleted, Number(total) || 0);
        state.progressCompleted = operation.progressCompleted;
        state.progressTotal = operation.progressTotal;
        if (label) state.progressLabel = label;
        scheduleProgressUi(operation.progressCompleted >= operation.progressTotal);
    }

    function addDownloadProgressTotal(operation, count, label) {
        setDownloadProgress(
            operation,
            operation.progressCompleted,
            operation.progressTotal + Math.max(0, Number(count) || 0),
            label
        );
    }

    function advanceDownloadProgress(operation, label) {
        setDownloadProgress(operation, operation.progressCompleted + 1, operation.progressTotal, label || 'Downloading segments...');
    }

    function installNetworkHooks() {
        if (state.installedHooks) return;
        state.installedHooks = true;

        hookXhr(targetWindow);
        hookFetch(targetWindow);
        if (targetWindow !== window) {
            hookXhr(window);
            hookFetch(window);
        }
    }

    function hookXhr(win) {
        try {
            if (!win.XMLHttpRequest || !win.XMLHttpRequest.prototype) return;
            var proto = win.XMLHttpRequest.prototype;
            if (proto.open && proto.open.__cpsdPatched) return;
            var originalOpen = proto.open;
            var originalSend = proto.send;
            proto.open = function () {
                if (arguments.length >= 2) {
                    this.__cpsdUrl = normalizeUrl(arguments[1]);
                    this.__cpsdSessionId = state.playbackSessionId;
                    this.__cpsdObservedAt = Date.now();
                    this.__cpsdObserve = shouldObserveNetworkRequest(arguments[1]);
                    if (this.__cpsdObserve) recordResourceUrl(arguments[1], 'xhr', this.__cpsdSessionId, this.__cpsdObservedAt);
                }
                return originalOpen.apply(this, arguments);
            };
            proto.send = function () {
                var xhr = this;
                if (xhr.__cpsdObserve && !xhr.__cpsdMetaHooked) {
                    xhr.__cpsdMetaHooked = true;
                    xhr.addEventListener('loadend', function () {
                        if (!xhr.__cpsdObserve) return;
                        var responseText = '';
                        try {
                            if (!xhr.responseType || xhr.responseType === 'text') responseText = xhr.responseText;
                        } catch (err) {}
                        inspectTextForResources(xhr.responseURL || xhr.__cpsdUrl, responseText, 'xhr-text', xhr.__cpsdSessionId, xhr.__cpsdObservedAt);
                    }, false);
                }
                return originalSend.apply(this, arguments);
            };
            proto.open.__cpsdPatched = true;
            debuglog('XHR hook installed');
        } catch (err) {
            debuglog('XHR hook failed: ' + err.message);
        }
    }

    function hookFetch(win) {
        try {
            if (!win.fetch || win.fetch.__cpsdPatched) return;
            var originalFetch = win.fetch;
            win.fetch = function () {
                var url = fetchInputUrl(arguments[0]);
                var sessionId = state.playbackSessionId;
                var observedAt = Date.now();
                if (!shouldObserveNetworkRequest(url)) {
                    return originalFetch.apply(this, arguments);
                }
                recordResourceUrl(url, 'fetch', sessionId, observedAt);
                return originalFetch.apply(this, arguments).then(function (response) {
                    inspectFetchResponse(url || response.url, response, sessionId, observedAt);
                    return response;
                });
            };
            win.fetch.__cpsdPatched = true;
            debuglog('fetch hook installed');
        } catch (err) {
            debuglog('fetch hook failed: ' + err.message);
        }
    }

    function fetchInputUrl(input) {
        if (!input) return '';
        if (typeof input === 'string') return input;
        if (input.url) return input.url;
        try { return String(input); } catch (err) { return ''; }
    }

    function startPerformanceObserver() {
        if (isPlaybackContext()) scanPerformanceEntries();
        else if (!isTopFrame() && !state.playbackSessionId) scanPerformanceEntries(true);
        try {
            if (!targetWindow.PerformanceObserver) return;
            state.observer = new targetWindow.PerformanceObserver(function (list) {
                list.getEntries().forEach(function (entry) {
                    var observedAt = performanceEntryEpochMs(entry);
                    if (state.playbackSessionEpochMs && observedAt < state.playbackSessionEpochMs) return;
                    if (isPlaybackResourceUrl(entry.name)) {
                        recordResourceUrl(entry.name, 'performance', state.playbackSessionId, performanceEntryEpochMs(entry));
                    }
                });
            });
            state.observer.observe({ entryTypes: ['resource'] });
            debuglog('PerformanceObserver installed');
        } catch (err) {
            debuglog('PerformanceObserver failed: ' + err.message);
        }
    }

    function scanPerformanceEntries(rescanAll) {
        try {
            var perf = targetWindow.performance || window.performance;
            if (!perf || !perf.getEntriesByType) return;
            var entries = perf.getEntriesByType('resource');
            var start = rescanAll || entries.length < state.performanceEntryCount ? 0 : state.performanceEntryCount;
            for (var i = start; i < entries.length; i++) {
                var observedAt = performanceEntryEpochMs(entries[i]);
                if (state.playbackSessionEpochMs && observedAt < state.playbackSessionEpochMs) continue;
                if (isPlaybackResourceUrl(entries[i].name)) {
                    recordResourceUrl(entries[i].name, 'performance-scan', state.playbackSessionId, observedAt);
                }
            }
            state.performanceEntryCount = entries.length;
        } catch (err) {
            debuglog('Performance scan failed: ' + err.message);
        }
    }

    function inspectFetchResponse(url, response, sessionId, observedAt) {
        if (!response || !response.clone) return;
        if (!shouldInspectResponse(url, response)) return;
        try {
            response.clone().text().then(function (text) {
                inspectTextForResources(url || response.url, text, 'fetch-text', sessionId, observedAt);
            }).catch(function () {});
        } catch (err) {}
    }

    function shouldInspectResponse(url, response) {
        url = normalizeUrl(url || (response && response.url));
        if (!url) return false;
        if (/\.(m4s|mp4|mp4a|ts|cmfv|cmfa|jpg|jpeg|png|webp|gif|woff2?|wasm)(?:[?#]|$)/i.test(url)) return false;
        var contentType = '';
        try { contentType = response.headers.get('content-type') || ''; } catch (err) {}
        if (/javascript|json|xml|mpegurl|dash|vtt|ttml|text|octet-stream/i.test(contentType)) return true;
        return /coupangplay|playback|manifest|m3u8|mpd|vtt|webvtt|ttml|dfxp|srt|subtitle|caption|timedtext/i.test(url);
    }

    function recordResourceUrl(rawUrl, source, sessionId, observedAt) {
        observedAt = Number(observedAt) || Date.now();
        var shouldDefer = rememberSessionObservation({ type: 'resource', rawUrl: rawUrl, source: source }, observedAt);
        sessionId = sessionId == null ? state.playbackSessionId : sessionId;
        sessionId = resolveObservationSession(sessionId, observedAt);
        if (!sessionId && shouldDefer) return;
        if (!isPlaybackSessionCurrent(sessionId)) return;
        var url = normalizeUrl(rawUrl);
        if (!url || state.seenResourceUrls[url]) return;
        state.seenResourceUrls[url] = true;
        captureCoupangResource(url, source, sessionId);

        if (isManifestUrl(url)) {
            queueManifest(url, source, sessionId);
        } else if (isSubtitleUrl(url)) {
            addTrack({
                NAME: inferTrackName(url),
                LANGUAGE: inferLanguage(url),
                FORCED: /forced/i.test(url) ? 'YES' : 'NO',
                URI: url,
                source: source || 'direct',
                activePlayback: isActivePlaybackObservation(),
                contentType: inferContentType(url)
            });
            state.status = 'Ready. Select a subtitle track.';
            updateUi();
        }
    }

    function inspectTextForResources(baseUrl, text, source, sessionId, observedAt) {
        if (!text || typeof text !== 'string') return;
        if (text.length > 5000000) return;
        observedAt = Number(observedAt) || Date.now();
        var shouldDefer = rememberSessionObservation({ type: 'text', baseUrl: baseUrl, text: text, source: source }, observedAt);
        sessionId = sessionId == null ? state.playbackSessionId : sessionId;
        sessionId = resolveObservationSession(sessionId, observedAt);
        if (!sessionId && shouldDefer) return;
        if (!isPlaybackSessionCurrent(sessionId)) return;
        var activePlayback = isActivePlaybackObservation();

        baseUrl = normalizeUrl(baseUrl);
        var trimmed = text.replace(/^\uFEFF/, '').trim();
        var subtitleFormat = fixtureCaptureRecording ? inferTextContentType(trimmed) : '';
        if (baseUrl && /^(?:vtt|ttml)$/.test(subtitleFormat)) {
            var subtitleArtifact = captureCoupangArtifact('subtitle', fixtureManifestText(trimmed), function () {
                return { format: subtitleFormat, url: baseUrl };
            });
            captureCoupang('subtitle.response-observed', sessionId, function () {
                return { url: baseUrl, source: source || '', format: subtitleFormat, artifact: subtitleArtifact || '' };
            });
        }
        if (baseUrl && fixtureResourceKind(baseUrl) === 'metadata') {
            var metadataProjection = fixtureMetadataProjection(trimmed);
            if (metadataProjection) {
                var metadataArtifact = captureCoupangArtifact('metadata-structure', metadataProjection, function () {
                    return { format: 'json', url: baseUrl };
                });
                captureCoupang('metadata.response-observed', sessionId, function () {
                    return { url: baseUrl, source: source || '', artifact: metadataArtifact || '' };
                });
            }
        }
        if (baseUrl && isManifestUrl(baseUrl)) {
            parseManifest(baseUrl, trimmed, sessionId, activePlayback);
        } else if (baseUrl && isSubtitleUrl(baseUrl)) {
            addTrack({
                NAME: inferTrackName(baseUrl),
                LANGUAGE: inferLanguage(baseUrl),
                FORCED: /forced/i.test(baseUrl) ? 'YES' : 'NO',
                URI: baseUrl,
                source: source || 'direct',
                activePlayback: activePlayback,
                contentType: inferContentType(baseUrl),
                playlistDuration: subtitleTextDurationSeconds(trimmed) || null
            });
        } else if (baseUrl && looksLikeSubtitleText(trimmed)) {
            addTrack({
                NAME: inferTrackName(baseUrl),
                LANGUAGE: inferLanguage(baseUrl),
                FORCED: /forced/i.test(baseUrl) ? 'YES' : 'NO',
                URI: baseUrl,
                source: source || 'direct-text',
                activePlayback: activePlayback,
                contentType: inferTextContentType(trimmed),
                text: trimmed,
                playlistDuration: subtitleTextDurationSeconds(trimmed) || null
            });
        } else if (/^\s*#EXTM3U/i.test(trimmed) || /^\s*<MPD[\s>]/i.test(trimmed)) {
            parseManifest(baseUrl || location.href, trimmed, sessionId, activePlayback);
        }

        extractUrlsFromText(trimmed, baseUrl).forEach(function (url) {
            recordResourceUrl(url, source || 'text-url', sessionId, observedAt);
        });

        try {
            collectSubtitleUrlsFromJson(JSON.parse(trimmed), baseUrl, '', 0, sessionId, observedAt, activePlayback);
        } catch (err) {}
    }

    function extractUrlsFromText(text, baseUrl) {
        var urls = {};
        var normalized = text
            .replace(/\\u002[fF]/g, '/')
            .replace(/\\\//g, '/')
            .replace(/&amp;/g, '&');
        var re = /https?:\/\/[^"'\s<>\\]+|\/\/[^"'\s<>\\]+|(?:[A-Za-z0-9._~!$&'()*+,;=:@%-]+\/)+(?:[^"'\s<>\\]*)(?:\.m3u8|\.mpd|\.vtt|\.webvtt|\.ttml|\.dfxp|\.srt)(?:[^"'\s<>\\]*)?/gi;
        var match;
        while ((match = re.exec(normalized)) !== null) {
            var url = match[0].replace(/[),.]+$/, '');
            if (/^(?:https?:)?\/\//i.test(url)) {
                if (url.indexOf('//') === 0) url = location.protocol + url;
            } else {
                url = absoluteUrl(url, baseUrl || location.href);
            }
            if (isManifestUrl(url) || isSubtitleUrl(url)) urls[url] = true;
        }
        return Object.keys(urls);
    }

    function collectSubtitleUrlsFromJson(value, baseUrl, path, depth, sessionId, observedAt, activePlayback) {
        if (value == null || depth > 12) return;
        if (typeof value === 'string') {
            extractUrlsFromText(value, baseUrl).forEach(function (url) {
                recordResourceUrl(url, 'json-string', sessionId, observedAt);
            });
            return;
        }
        if (typeof value !== 'object') return;

        if (Array.isArray(value)) {
            value.slice(0, 500).forEach(function (item) {
                collectSubtitleUrlsFromJson(item, baseUrl, path, depth + 1, sessionId, observedAt, activePlayback);
            });
            return;
        }

        var possibleUrl = '';
        var language = '';
        var label = '';
        var forced = 'NO';
        var type = '';

        Object.keys(value).forEach(function (key) {
            var child = value[key];
            var lower = key.toLowerCase();
            var nextPath = path ? path + '.' + lower : lower;

            if (typeof child === 'string') {
                if (/(?:url|uri|src|href|path|file|location)$/.test(lower)) possibleUrl = child;
                if (/(?:language|lang|locale|srclang)$/.test(lower)) language = child;
                if (/(?:label|name|title|displayname)$/.test(lower)) label = child;
                if (/forced/.test(lower) && /true|yes|forced/i.test(child)) forced = 'YES';
                if (/(?:kind|type|format|mime|contenttype)$/.test(lower)) type = child;
            } else if (typeof child === 'boolean' && /forced/.test(lower) && child) {
                forced = 'YES';
            }

            collectSubtitleUrlsFromJson(child, baseUrl, nextPath, depth + 1, sessionId, observedAt, activePlayback);
        });

        if (possibleUrl) {
            var url = absoluteUrl(cleanJsonUrl(possibleUrl), baseUrl || location.href);
            if (isManifestUrl(url)) {
                recordResourceUrl(url, 'json-object', sessionId, observedAt);
            } else if (isSubtitleUrl(url) || /subtitle|caption|texttrack|timedtext/i.test(path + ' ' + type + ' ' + label)) {
                addTrack({
                    NAME: buildTrackName(label, language, forced, type, url),
                    LANGUAGE: language || inferLanguage(url),
                    FORCED: forced,
                    TYPE: type || '',
                    URI: url,
                    source: 'json',
                    activePlayback: !!activePlayback,
                    contentType: inferContentType(url)
                });
            }
        }
    }

    function cleanJsonUrl(url) {
        return String(url || '').replace(/\\u002[fF]/g, '/').replace(/\\\//g, '/').replace(/&amp;/g, '&');
    }

    function isManifestUrl(url) {
        return /\.(?:m3u8|mpd)(?:[?#]|$)/i.test(url || '');
    }

    function isSubtitleUrl(url) {
        return /\.(?:vtt|webvtt|ttml|dfxp|srt)(?:[?#]|$)/i.test(url || '') ||
            /(?:subtitle|caption|timedtext|texttrack).*(?:vtt|ttml|dfxp|srt)/i.test(url || '');
    }

    function inferContentType(url) {
        if (/\.srt(?:[?#]|$)/i.test(url)) return 'srt';
        if (/\.(?:ttml|dfxp)(?:[?#]|$)/i.test(url)) return 'ttml';
        if (/\.(?:vtt|webvtt)(?:[?#]|$)/i.test(url)) return 'vtt';
        if (/\.mpd(?:[?#]|$)/i.test(url)) return 'mpd';
        if (/\.m3u8(?:[?#]|$)/i.test(url)) return 'm3u8';
        return '';
    }

    function looksLikeSubtitleText(text) {
        return /^\s*WEBVTT\b/i.test(text || '') ||
            looksLikeTtmlText(text) ||
            looksLikeSrt(text || '');
    }

    function inferTextContentType(text) {
        if (/^\s*WEBVTT\b/i.test(text || '')) return 'vtt';
        if (looksLikeTtmlText(text)) return 'ttml';
        if (looksLikeSrt(text || '')) return 'srt';
        return '';
    }

    function scheduleManifestRetry(url, source, sessionId, delayMs) {
        delayMs = Number(delayMs);
        if (!isFinite(delayMs) || delayMs <= 0 || delayMs > 2147483647) return;
        setTimeout(function () {
            if (!isPlaybackSessionCurrent(sessionId)) return;
            if (state.seenManifestUrls[url] !== 'cooldown') return;
            delete state.seenManifestUrls[url];
            delete state.seenResourceUrls[url];
            queueManifest(url, source, sessionId);
        }, delayMs);
    }

    function queueManifest(url, source, sessionId) {
        sessionId = sessionId == null ? state.playbackSessionId : sessionId;
        if (!isPlaybackSessionCurrent(sessionId)) return;
        if (state.seenManifestUrls[url]) return;
        state.seenManifestUrls[url] = 'pending';
        var activePlayback = isActivePlaybackObservation();
        state.status = 'Found manifest via ' + source + '. Reading tracks...';
        updateUi();

        getText(url).then(function (text) {
            if (!isPlaybackSessionCurrent(sessionId)) return;
            state.seenManifestUrls[url] = 'loaded';
            if (/^Could not read manifest:/.test(state.lastError || '')) state.lastError = '';
            parseManifest(url, text || '', sessionId, activePlayback);
            updateUi();
        }).catch(function (err) {
            if (!isPlaybackSessionCurrent(sessionId)) return;
            if (state.seenManifestUrls[url] === 'pending') {
                var retryAfterMs = Number(err && err.retryAfterMs);
                if (isFinite(retryAfterMs) && retryAfterMs > 0) {
                    state.seenManifestUrls[url] = 'cooldown';
                    scheduleManifestRetry(url, source, sessionId, retryAfterMs);
                } else {
                    delete state.seenManifestUrls[url];
                    delete state.seenResourceUrls[url];
                }
            }
            state.lastError = 'Could not read manifest: ' + err.message;
            updateUi();
        });
    }

    function parseManifest(url, text, sessionId, activePlayback) {
        if (!isPlaybackSessionCurrent(sessionId)) return;
        if (!text) return;
        activePlayback = activePlayback == null ? isActivePlaybackObservation() : !!activePlayback;
        var format = /^\s*#EXTM3U/i.test(text) ? 'm3u8' : (/^\s*<MPD[\s>]/i.test(text) ? 'mpd' : '');
        var projectedManifest = fixtureManifestText(text);
        var manifestArtifact = projectedManifest ? captureCoupangArtifact('manifest', projectedManifest, function () {
            return { format: format, url: url };
        }) : null;
        var trackCountBefore = state.tracks.length;
        if (/^\s*#EXTM3U/i.test(text)) {
            parseHlsManifest(url, text, activePlayback);
        } else if (/^\s*<MPD[\s>]/i.test(text)) {
            parseDashManifest(url, text, activePlayback);
        }
        captureCoupang('manifest.parsed', sessionId, function () {
            return {
                url: url,
                format: format || 'unknown',
                artifact: manifestArtifact || '',
                activePlayback: activePlayback,
                tracksAdded: Math.max(0, state.tracks.length - trackCountBefore)
            };
        });
        if (state.tracks.length > 0) state.status = 'Ready. Select a subtitle track.';
    }

    function parseHlsManifest(url, text, activePlayback) {
        var lines = text.split(/\r\n|\r|\n/);
        var subtitleMediaLines = lines.filter(function (line) {
            return /^#EXT-X-MEDIA:/i.test(line) && /TYPE=(SUBTITLES|CLOSED-CAPTIONS)/i.test(line);
        });

        subtitleMediaLines.forEach(function (line) {
            var attrs = parseAttrList(line.replace(/^#EXT-X-MEDIA:/i, ''));
            if (!attrs.URI) return;
            var trackUrl = absoluteUrl(attrs.URI, url);
            addTrack({
                NAME: trackLabel(attrs, trackUrl),
                LANGUAGE: attrs.LANGUAGE || inferLanguage(trackUrl),
                FORCED: attrs.FORCED || 'NO',
                CHARACTERISTICS: attrs.CHARACTERISTICS || '',
                TYPE: attrs.TYPE || '',
                URI: trackUrl,
                source: 'hls-master',
                activePlayback: !!activePlayback,
                contentType: inferContentType(trackUrl)
            });
        });

        if (looksLikeSubtitlePlaylist(url, text)) {
            addTrack({
                NAME: inferTrackName(url),
                LANGUAGE: inferLanguage(url),
                FORCED: /forced/i.test(url) ? 'YES' : 'NO',
                URI: url,
                source: 'hls-playlist',
                activePlayback: !!activePlayback,
                segments: extractSegmentUrls(text, url),
                hlsSegments: extractHlsSegmentEntries(text, url),
                playlistDuration: playlistDurationSeconds(text) || null,
                contentType: 'm3u8'
            });
        }
    }

    function parseDashManifest(url, text, activePlayback) {
        var doc;
        try {
            doc = new DOMParser().parseFromString(text, 'application/xml');
        } catch (err) {
            return;
        }
        var nodes = Array.prototype.slice.call(doc.getElementsByTagName('*'));
        var mpd =
            nodes.filter(function (node) {
                return localName(node) === 'MPD';
            })[0] || null;
        var mpdBaseText = mpd ? firstChildText(mpd, 'BaseURL') : '';
        var mpdBaseUrl = dashResolveBaseUrl(url, mpdBaseText);

        nodes
            .filter(function (node) {
                return localName(node) === 'AdaptationSet' && isTextAdaptation(node);
            })
            .forEach(function (adaptation) {
                var period = findAncestorElement(adaptation, 'Period');
                var periodDuration = dashPeriodDurationSeconds(period, doc);
                var periodBaseText = period ? firstChildText(period, 'BaseURL') : '';
                var periodBaseUrl = dashResolveBaseUrl(mpdBaseUrl, periodBaseText);
                var adaptationBaseText = firstChildText(adaptation, 'BaseURL');
                var adaptationBaseUrl = dashResolveBaseUrl(periodBaseUrl, adaptationBaseText);
                var adaptationTemplate = firstChildElement(adaptation, 'SegmentTemplate');
                var periodTemplate = period ? firstChildElement(period, 'SegmentTemplate') : null;
                var language = adaptation.getAttribute('lang') || adaptation.getAttribute('xml:lang') || '';
                var label = adaptation.getAttribute('label') || adaptation.getAttribute('contentType') || 'Subtitle';
                var mimeType = adaptation.getAttribute('mimeType') || '';
                var representations = childElements(adaptation, 'Representation');
                if (!representations.length) representations = [adaptation];

                representations.forEach(function (representation) {
                    var representationBaseText = representation === adaptation ? '' : firstChildText(representation, 'BaseURL');
                    var representationBaseUrl = dashResolveBaseUrl(adaptationBaseUrl, representationBaseText);
                    var repLang = representation.getAttribute('lang') || representation.getAttribute('xml:lang') || language;
                    var repMime = representation.getAttribute('mimeType') || mimeType;
                    var repLabel = representation.getAttribute('label') || label;
                    var directBaseText = representationBaseText || adaptationBaseText;
                    if (directBaseText) {
                        addTrack({
                            NAME: buildTrackName(repLabel, repLang, 'NO', repMime, representationBaseUrl),
                            LANGUAGE: repLang || inferLanguage(representationBaseUrl),
                            FORCED: /forced/i.test(repLabel + ' ' + representationBaseUrl) ? 'YES' : 'NO',
                            TYPE: repMime,
                            URI: representationBaseUrl,
                            source: 'dash',
                            activePlayback: !!activePlayback,
                            contentType: inferContentType(representationBaseUrl)
                        });
                    }

                    var representationTemplate = representation === adaptation ? null : firstChildElement(representation, 'SegmentTemplate');
                    var templateLayers = [];
                    if (representationTemplate) templateLayers.push(representationTemplate);
                    if (adaptationTemplate) templateLayers.push(adaptationTemplate);
                    if (periodTemplate) templateLayers.push(periodTemplate);
                    var templateSegments = templateLayers.length
                        ? dashTemplateSegments(templateLayers, representation, representationBaseUrl, periodDuration)
                        : [];
                    if (templateSegments.length) {
                        addTrack({
                            NAME: buildTrackName(repLabel, repLang, 'NO', repMime, templateSegments[0]),
                            LANGUAGE: repLang || inferLanguage(templateSegments[0]),
                            FORCED: /forced/i.test(repLabel + ' ' + templateSegments[0]) ? 'YES' : 'NO',
                            TYPE: repMime,
                            URI: url,
                            source: 'dash-template',
                            activePlayback: !!activePlayback,
                            segments: templateSegments,
                            playlistDuration: periodDuration || null,
                            contentType: inferContentType(templateSegments[0])
                        });
                    }
                });
            });
    }

    function localName(node) {
        return node.localName || String(node.nodeName || '').replace(/^.*:/, '');
    }

    function childElements(parent, name) {
        return Array.prototype.slice.call(parent.children || []).filter(function (child) {
            return localName(child) === name;
        });
    }

    function firstChildElement(parent, name) {
        var items = childElements(parent, name);
        return items.length ? items[0] : null;
    }

    function firstChildText(parent, name) {
        var node = firstChildElement(parent, name);
        return node ? node.textContent.trim() : '';
    }

    function findAncestorElement(node, name) {
        var current = node && (node.parentElement || node.parentNode);
        while (current) {
            if (localName(current) === name) return current;
            current = current.parentElement || current.parentNode;
        }
        return null;
    }

    function dashResolveBaseUrl(parentUrl, childBase) {
        return childBase ? absoluteUrl(childBase, parentUrl) : parentUrl;
    }

    function parseDashDurationSeconds(value) {
        var match = String(value || '')
            .trim()
            .match(/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
        if (!match) return null;
        return (Number(match[1]) || 0) * 86400 + (Number(match[2]) || 0) * 3600 + (Number(match[3]) || 0) * 60 + (Number(match[4]) || 0);
    }

    function dashPeriodStartSeconds(period, periods, index) {
        if (!period) return null;
        var explicit = parseDashDurationSeconds(period.getAttribute('start'));
        if (explicit != null) return explicit;
        var position = 0;
        for (var i = 0; i < index; i++) {
            var priorStart = parseDashDurationSeconds(periods[i].getAttribute('start'));
            if (priorStart != null) position = priorStart;
            var priorDuration = parseDashDurationSeconds(periods[i].getAttribute('duration'));
            if (priorDuration == null) return null;
            position += priorDuration;
        }
        return position;
    }

    function dashPeriodDurationSeconds(period, doc) {
        if (!period) return null;
        var direct = parseDashDurationSeconds(period.getAttribute('duration'));
        if (direct != null) return direct;

        var mpd = findAncestorElement(period, 'MPD');
        if (!mpd && doc) {
            var nodes = Array.prototype.slice.call(doc.getElementsByTagName('*'));
            mpd =
                nodes.filter(function (node) {
                    return localName(node) === 'MPD';
                })[0] || null;
        }
        if (!mpd) return null;

        var periods = childElements(mpd, 'Period');
        var index = periods.indexOf(period);
        if (index < 0) return null;
        var start = dashPeriodStartSeconds(period, periods, index);
        if (start == null) return null;

        if (index + 1 < periods.length) {
            var nextStart = dashPeriodStartSeconds(periods[index + 1], periods, index + 1);
            if (nextStart != null && nextStart > start) return nextStart - start;
        }

        var presentationDuration = parseDashDurationSeconds(mpd.getAttribute('mediaPresentationDuration'));
        if (presentationDuration != null && presentationDuration > start) return presentationDuration - start;
        return null;
    }

    function dashTemplateAttribute(templates, name, fallback) {
        for (var i = 0; i < templates.length; i++) {
            var template = templates[i];
            if (!template || !template.getAttribute) continue;
            var value = template.getAttribute(name);
            if (value != null && value !== '') return value;
        }
        return fallback;
    }

    function dashTemplateTimeline(templates) {
        for (var i = 0; i < templates.length; i++) {
            var timeline = firstChildElement(templates[i], 'SegmentTimeline');
            if (timeline) return timeline;
        }
        return null;
    }

    function dashReplaceNumericToken(text, token, value) {
        var expression = new RegExp('\\$' + token + '(?:%0(\\d+)d)?\\$', 'g');
        return text.replace(expression, function (_, widthText) {
            var rendered = String(value);
            var width = parseInt(widthText || '0', 10) || 0;
            if (!width || rendered.length >= width) return rendered;
            var sign = rendered.charAt(0) === '-' ? '-' : '';
            var digits = sign ? rendered.slice(1) : rendered;
            while (sign.length + digits.length < width) digits = '0' + digits;
            return sign + digits;
        });
    }

    function dashFormatTemplate(media, representationId, bandwidth, number, time) {
        var marker = '\uE000';
        var rendered = String(media || '').replace(/\$\$/g, marker);
        if (/\$RepresentationID\$/.test(rendered) && !representationId) return '';
        if (/\$Bandwidth(?:%0\d+d)?\$/.test(rendered) && (bandwidth == null || bandwidth === '')) return '';
        rendered = rendered.replace(/\$RepresentationID\$/g, representationId || '');
        rendered = dashReplaceNumericToken(rendered, 'Number', number);
        rendered = dashReplaceNumericToken(rendered, 'Time', time);
        rendered = dashReplaceNumericToken(rendered, 'Bandwidth', bandwidth || '');
        if (/\$[A-Za-z][^$]*\$/.test(rendered)) return '';
        return rendered.replace(new RegExp(marker, 'g'), '$');
    }

    function dashTemplateHasAddressingToken(media) {
        var marker = '\uE000';
        var normalized = String(media || '').replace(/\$\$/g, marker);
        return /\$(?:Number|Time)(?:%0\d+d)?\$/.test(normalized);
    }

    function isTextAdaptation(node) {
        var text = [
            node.getAttribute('contentType') || '',
            node.getAttribute('mimeType') || '',
            node.getAttribute('codecs') || '',
            node.getAttribute('label') || '',
            node.textContent.slice(0, 500)
        ]
            .join(' ')
            .toLowerCase();
        return /text|subtitle|caption|webvtt|vtt|ttml|dfxp|stpp/.test(text);
    }

    function dashTemplateSegments(templates, representation, baseUrl, periodDurationSeconds) {
        templates = Array.isArray(templates) ? templates.filter(Boolean) : [templates].filter(Boolean);
        if (!templates.length) return [];

        var media = dashTemplateAttribute(templates, 'media', '');
        if (!media || !/\.(?:vtt|webvtt|ttml|dfxp|xml|srt)(?:[?#]|$)/i.test(media)) return [];
        if (!dashTemplateHasAddressingToken(media)) return [];

        var representationId = representation.getAttribute('id') || '';
        var bandwidth = representation.getAttribute('bandwidth') || '';
        var startNumber = parseInt(dashTemplateAttribute(templates, 'startNumber', '1'), 10);
        if (!isFinite(startNumber)) startNumber = 1;
        var timescale = Number(dashTemplateAttribute(templates, 'timescale', '1'));
        if (!(timescale > 0)) timescale = 1;
        var presentationTimeOffset = Number(dashTemplateAttribute(templates, 'presentationTimeOffset', '0')) || 0;
        var eptDelta = Number(dashTemplateAttribute(templates, 'eptDelta', '0')) || 0;
        var timeline = dashTemplateTimeline(templates);
        var references = [];

        if (timeline) {
            var sNodes = childElements(timeline, 'S');
            var currentTime = null;
            var segmentNumber = startNumber;
            for (var sIndex = 0; sIndex < sNodes.length; sIndex++) {
                var s = sNodes[sIndex];
                var duration = Number(s.getAttribute('d'));
                if (!(duration > 0)) return [];

                var explicitTime = s.getAttribute('t');
                if (explicitTime != null && explicitTime !== '') {
                    currentTime = Number(explicitTime);
                    if (!isFinite(currentTime)) return [];
                } else if (currentTime == null) {
                    currentTime = 0;
                }

                var repeat = parseInt(s.getAttribute('r') || '0', 10);
                if (!isFinite(repeat)) repeat = 0;
                var count = repeat >= 0 ? repeat + 1 : 0;

                if (repeat < 0) {
                    if (sIndex + 1 < sNodes.length) {
                        var nextTimeText = sNodes[sIndex + 1].getAttribute('t');
                        if (nextTimeText == null || nextTimeText === '') return [];
                        var nextTime = Number(nextTimeText);
                        if (!isFinite(nextTime) || nextTime <= currentTime) return [];
                        count = Math.ceil((nextTime - currentTime) / duration);
                    } else if (periodDurationSeconds != null && isFinite(periodDurationSeconds) && periodDurationSeconds > 0) {
                        var periodEndTime = presentationTimeOffset + periodDurationSeconds * timescale;
                        count = Math.ceil((periodEndTime - currentTime) / duration);
                    } else {
                        return [];
                    }
                }

                if (count <= 0 || references.length + count > MAX_DASH_TEMPLATE_SEGMENTS) return [];
                for (var repeatIndex = 0; repeatIndex < count; repeatIndex++) {
                    references.push({ number: segmentNumber++, time: currentTime });
                    currentTime += duration;
                }
            }
        } else {
            var simpleDuration = Number(dashTemplateAttribute(templates, 'duration', '0'));
            if (!(simpleDuration > 0) || periodDurationSeconds == null || !isFinite(periodDurationSeconds) || periodDurationSeconds <= 0) return [];
            var describedUnits = periodDurationSeconds * timescale - eptDelta;
            var simpleCount = Math.ceil(describedUnits / simpleDuration);
            if (simpleCount <= 0 || simpleCount > MAX_DASH_TEMPLATE_SEGMENTS) return [];
            for (var index = 0; index < simpleCount; index++) {
                references.push({
                    number: startNumber + index,
                    time: presentationTimeOffset + index * simpleDuration
                });
            }
        }

        var urls = [];
        for (var i = 0; i < references.length; i++) {
            var reference = references[i];
            var rendered = dashFormatTemplate(media, representationId, bandwidth, reference.number, reference.time);
            if (!rendered) return [];
            urls.push(absoluteUrl(rendered, baseUrl));
        }
        return urls;
    }

    function parseAttrList(value) {
        var attrs = {};
        var re = /([A-Z0-9-]+)=("(?:[^"\\]|\\.)*"|[^,]*)/gi;
        var match;
        while ((match = re.exec(value)) !== null) {
            attrs[match[1].toUpperCase()] = match[2].replace(/^"|"$/g, '');
        }
        return attrs;
    }

    function trackLabel(attrs, uri) {
        return buildTrackName(attrs.NAME || '', attrs.LANGUAGE || inferLanguage(uri), attrs.FORCED || 'NO', attrs.CHARACTERISTICS || attrs.TYPE || '', uri);
    }

    function buildTrackName(label, language, forced, type, uri) {
        var parts = [];
        if (label) parts.push(label);
        if (language && parts.join(' ').toLowerCase().indexOf(String(language).toLowerCase()) < 0) parts.push('[' + language + ']');
        if (/^yes$/i.test(forced || '') || /forced/i.test(label + ' ' + uri)) parts.push('(forced)');
        if (/sdh|cc|caption|closed|transcribes/i.test(type + ' ' + label + ' ' + uri)) parts.push('(CC)');
        return parts.join(' ') || inferTrackName(uri);
    }

    function inferTrackName(url) {
        var decoded = decodeURIComponent(url || '');
        var language = inferLanguage(decoded);
        var file = decoded.split(/[/?#]/).filter(Boolean).pop() || 'Subtitle';
        var label = language ? language : file.replace(/\.(?:m3u8|mpd|vtt|webvtt|ttml|dfxp|srt).*/i, '').replace(/[_-]+/g, ' ');
        if (/sdh|cc|caption/i.test(decoded) && !/\bcc\b/i.test(label)) label += ' (CC)';
        if (/forced/i.test(decoded)) label += ' (forced)';
        return label || 'Subtitle';
    }

    function inferLanguage(url) {
        var decoded = decodeURIComponent(url || '');
        var match = decoded.match(/(?:^|[\/._-])([a-z]{2,3}(?:[-_][a-z0-9]+)?)(?:[_-](?:SDH|CC|FORCED|MAIN|PRIMARY))?(?:[_-]|\.|\/|$)/i);
        return match ? normalizeLanguageCode(match[1]) : '';
    }

    function addTrack(track, fromFrameMessage) {
        if (!track || !track.URI) return;
        if (!isTopFrame() && !fromFrameMessage) {
            forwardTrackToTop(track);
            return;
        }
        track.LANGUAGE = track.LANGUAGE || inferLanguage(track.URI);
        track.NAME = track.NAME || inferTrackName(track.URI);
        track.key = trackIdentity(track);

        var existing = state.trackKeys[track.key];
        if (existing) {
            mergeTrack(existing, track);
            return;
        }

        state.trackKeys[track.key] = track;
        state.tracks.push(track);
        state.tracks.sort(function (a, b) {
            return a.NAME.localeCompare(b.NAME);
        });
        state.status = 'Ready. Select a subtitle track.';
        captureCoupang('track.added', state.playbackSessionId, function () {
            return { track: fixtureTrackSummary(track), fromFrameMessage: !!fromFrameMessage };
        });
        debuglog('Track added: ' + track.NAME);
        updateUi();
    }

    function mergeTrack(existing, incoming) {
        var fixtureTrackBefore = fixtureCaptureRecording && fixtureCapture ? JSON.stringify(fixtureTrackSummary(existing)) : '';
        var incomingScore = trackScoreForSource(incoming);
        var existingScore = trackScoreForSource(existing);
        if (incomingScore > existingScore) {
            existing.URI = incoming.URI;
            existing.source = incoming.source || existing.source;
            existing.segments = incoming.segments || null;
            existing.hlsSegments = incoming.hlsSegments || null;
            existing.contentType = incoming.contentType || existing.contentType;
            existing.playlistDuration = incoming.playlistDuration || existing.playlistDuration;
            existing.activePlayback = !!incoming.activePlayback;
        } else if (incoming.segments && incoming.segments.length && (!existing.segments || !existing.segments.length)) {
            existing.segments = incoming.segments;
        }
        if (incoming.hlsSegments && incoming.hlsSegments.length && (!existing.hlsSegments || !existing.hlsSegments.length)) {
            existing.hlsSegments = incoming.hlsSegments;
        }
        if (!existing.LANGUAGE && incoming.LANGUAGE) existing.LANGUAGE = incoming.LANGUAGE;
        if (!existing.FORCED && incoming.FORCED) existing.FORCED = incoming.FORCED;
        if (!existing.TYPE && incoming.TYPE) existing.TYPE = incoming.TYPE;
        if (!existing.CHARACTERISTICS && incoming.CHARACTERISTICS) existing.CHARACTERISTICS = incoming.CHARACTERISTICS;
        if (!existing.activePlayback && incoming.activePlayback && incomingScore >= existingScore) existing.activePlayback = true;
        if (isBetterTrackName(incoming.NAME, existing.NAME)) existing.NAME = incoming.NAME;
        if (fixtureTrackBefore) {
            var fixtureTrackAfter = fixtureTrackSummary(existing);
            if (JSON.stringify(fixtureTrackAfter) !== fixtureTrackBefore) {
                captureCoupang('track.merged', state.playbackSessionId, function () {
                    return { track: fixtureTrackAfter, incoming: fixtureTrackSummary(incoming) };
                });
            }
        }
        debuglog('Track merged: ' + existing.NAME);
    }

    function trackScoreForSource(track) {
        var score = 0;
        if (track.activePlayback) score += 100;
        if (track.source === 'json') score += 5;
        if (/master|dash/.test(track.source || '')) score += 4;
        if (/playlist/.test(track.source || '')) score += 3;
        if (track.segments && track.segments.length) score += 3;
        if (track.playlistDuration && track.playlistDuration > 120) score += 5;
        if (isShortPreviewTrack(track)) score -= 200;
        if (track.URI) score += 1;
        return score;
    }

    function isBetterTrackName(candidate, current) {
        if (!candidate) return false;
        if (!current) return true;
        if (/subtitle/i.test(current) && !/subtitle/i.test(candidate)) return true;
        if ((current.indexOf('[') < 0) && candidate.indexOf('[') >= 0) return true;
        return candidate.length > current.length && candidate.length < 100;
    }

    function trackIdentity(track) {
        var language = trackLanguage(track);
        var type = isForcedTrack(track) ? 'forced' : 'main';
        var captions = isCcTrack(track) ? 'cc' : 'plain';
        var label = normalizeTrackLabel(track.NAME || inferTrackName(track.URI));
        if (language) return language + '|' + type + '|' + captions + '|' + label;
        return (label || track.URI.replace(/[?#].*$/, '')) + '|' + type + '|' + captions;
    }

    function findTrackByKey(key) {
        if (!key) return null;
        for (var i = 0; i < state.tracks.length; i++) {
            if (state.tracks[i].key === key) return state.tracks[i];
        }
        return null;
    }

    function preferredSelectionKey() {
        var preferred = findPreferredTrack('ko') || findPreferredTrack('en') || state.tracks[0];
        return preferred ? preferred.key : '';
    }

    function findPreferredTrack(language) {
        var candidates = state.tracks.filter(function (track) {
            return trackMatchesLanguage(track, language);
        });
        if (!candidates.length) return null;

        var mainTracks = candidates.filter(function (track) {
            return !isForcedTrack(track);
        });
        if (mainTracks.length) candidates = mainTracks;

        candidates.sort(function (a, b) {
            return trackScore(b, language) - trackScore(a, language) || a.NAME.localeCompare(b.NAME);
        });
        return candidates[0];
    }

    function trackMatchesLanguage(track, language) {
        var trackCode = languagePrimary(trackLanguage(track));
        var desiredCode = languagePrimary(language);
        if (trackCode && desiredCode && trackCode === desiredCode) return true;

        var haystack = ((track.LANGUAGE || '') + ' ' + (track.NAME || '') + ' ' + (track.URI || '')).toLowerCase();
        if (language === 'ko') return /\b(ko|kor|kr|korean)\b/.test(haystack) || haystack.indexOf('한국') >= 0;
        if (language === 'en') return /\b(en|eng|english)\b/.test(haystack);
        return false;
    }

    function trackScore(track, language) {
        var haystack = ((track.LANGUAGE || '') + ' ' + (track.NAME || '') + ' ' + (track.URI || '')).toLowerCase();
        var score = trackScoreForSource(track);
        if (languagePrimary(trackLanguage(track)) === languagePrimary(language)) score += 100;
        if (language === 'ko' && (haystack.indexOf('korean') >= 0 || haystack.indexOf('한국') >= 0)) score += 50;
        if (language === 'en' && haystack.indexOf('english') >= 0) score += 50;
        if (isCcTrack(track)) score += 8;
        if (isForcedTrack(track)) score -= 20;
        return score;
    }

    function trackLanguage(track) {
        return normalizeLanguageCode(track.LANGUAGE) ||
            languageFromTrackName(track.NAME) ||
            normalizeLanguageCode(inferLanguage(track.URI || ''));
    }

    function languageFromTrackName(name) {
        var text = String(name || '').toLowerCase();
        var bracket = text.match(/\[([a-z]{2,3}(?:-[a-z0-9]+)?)\]/i);
        if (bracket) return normalizeLanguageCode(bracket[1]);
        if (/\bkorean\b/.test(text) || text.indexOf('한국') >= 0) return 'ko';
        if (/\benglish\b/.test(text)) return 'en';
        var compact = text.match(/^([a-z]{2,3})(?:[-_\s]+|--)(?:forced|cc|sdh|subtitle|caption|\()/i);
        return compact ? normalizeLanguageCode(compact[1]) : '';
    }

    function normalizeLanguageCode(value) {
        var text = String(value || '').toLowerCase().trim().replace(/_/g, '-');
        var match = text.match(/^([a-z]{2,3})(?:-([a-z0-9]+))?/i);
        if (!match) return '';
        var primary = match[1];
        if (primary === 'kor' || primary === 'kr') return 'ko';
        if (primary === 'eng') return 'en';
        if (primary === 'ko' || primary === 'en') return primary;
        return match[2] ? primary + '-' + match[2] : primary;
    }

    function languagePrimary(value) {
        return normalizeLanguageCode(value).split('-')[0];
    }

    function isForcedTrack(track) {
        return /^yes$/i.test(track.FORCED || '') ||
            /(?:^|[\s._-])forced(?:$|[\s._-])/i.test(track.NAME || '') ||
            /(?:^|[\/._-])forced(?:$|[\/._-])/i.test(track.URI || '');
    }

    function isCcTrack(track) {
        var text = ((track.NAME || '') + ' ' + (track.CHARACTERISTICS || '') + ' ' + (track.TYPE || '') + ' ' + (track.URI || '')).toLowerCase();
        return /\bcc\b|sdh|closed captions|caption|transcribes-spoken-dialog|describes-music-and-sound/.test(text);
    }

    function normalizeTrackLabel(name) {
        return String(name || '')
            .toLowerCase()
            .replace(/\[[^\]]+\]/g, '')
            .replace(/\((?:cc|forced|sdh)\)/g, '')
            .replace(/\b(?:cc|forced|sdh|closed captions)\b/g, '')
            .replace(/[_-]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function looksLikeSubtitlePlaylist(url, text) {
        return /\.(?:vtt|webvtt|ttml|dfxp|srt)(?:[?#\s]|$)/i.test(text) ||
            /WEBVTT|TTML|SUBTITLE|caption|timedtext/i.test(text) ||
            /subtitle|webvtt|_sdh_|_cc_|forced|timedtext/i.test(url);
    }

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

    function isShortPreviewTrack(track) {
        var duration = Number(track && track.playlistDuration);
        return duration > 0 && duration < 90;
    }

    function playlistDurationSeconds(text) {
        var total = 0;
        var found = false;
        String(text || '').split(/\r\n|\r|\n/).forEach(function (line) {
            var match = line.match(/^#EXTINF:([\d.]+)/i);
            if (!match) return;
            var value = parseFloat(match[1]);
            if (isFinite(value) && value > 0) {
                total += value;
                found = true;
            }
        });
        return found ? total : 0;
    }

    function subtitleTextDurationSeconds(text) {
        var max = 0;
        String(text || '').replace(/(\d{2}:\d{2}:\d{2}[\.,]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[\.,]\d{3})/g, function (_, start, end) {
            var seconds = timestampSeconds(end);
            if (seconds > max) max = seconds;
            return _;
        });
        return max;
    }

    function beginDownloadOperation(kind, track) {
        var operation = {
            id: ++state.downloadOperationSequence,
            sessionId: state.playbackSessionId,
            kind: kind || 'track',
            track: track || null,
            baseFilename: '',
            metadataPromise: null,
            progressCompleted: 0,
            progressTotal: 0
        };
        state.activeDownloadOperationId = operation.id;
        state.outputFilename = 'Resolving title metadata...';
        state.progressCompleted = 0;
        state.progressTotal = 0;
        state.progressLabel = 'Reading title metadata...';
        captureCoupang('download.started', operation.sessionId, function () {
            return { operationId: operation.id, kind: operation.kind, track: fixtureTrackSummary(operation.track) };
        });
        return operation;
    }

    function ensureOperationBaseFilename(operation) {
        assertDownloadOperationCurrent(operation);
        if (operation.baseFilename) return Promise.resolve(operation.baseFilename);
        if (operation.metadataPromise) return operation.metadataPromise;

        operation.metadataPromise = ensureMediaMetadata().then(function () {
            assertDownloadOperationCurrent(operation);
            operation.baseFilename = safeBaseFilename();
            state.outputFilename = operation.baseFilename;
            state.progressLabel = 'Preparing download...';
            captureCoupangSnapshot('filename.resolved', operation.sessionId, function () {
                return { operationId: operation.id, filename: operation.baseFilename, metadata: fixtureMetadataState() };
            });
            updateUi();
            return operation.baseFilename;
        });
        return operation.metadataPromise;
    }

    function isDownloadOperationCurrent(operation) {
        return !!operation && operation.id === state.activeDownloadOperationId && isPlaybackSessionCurrent(operation.sessionId);
    }

    function assertDownloadOperationCurrent(operation) {
        if (!isDownloadOperationCurrent(operation)) throw new Error('Playback changed while downloading subtitles.');
    }

    function invalidateDownloadOperation() {
        state.activeDownloadOperationId = 0;
        state.wait = false;
        state.zip = null;
    }

    function finishDownloadOperation(operation) {
        if (!isDownloadOperationCurrent(operation)) return false;
        captureCoupang('download.finished', operation.sessionId, function () {
            return {
                operationId: operation.id,
                kind: operation.kind,
                filename: operationOutputFilename(operation),
                status: state.status || '',
                errorCode: fixtureErrorCode(state.lastError),
                progressCompleted: state.progressCompleted,
                progressTotal: state.progressTotal
            };
        });
        state.activeDownloadOperationId = 0;
        state.wait = false;
        state.zip = null;
        return true;
    }

    function downloadAllTracks() {
        if (state.wait || state.tracks.length === 0) return;
        var operation = beginDownloadOperation('all');
        var tracks = state.tracks.slice();
        var zip = new JSZip();
        state.zip = zip;
        state.wait = true;
        state.lastError = '';
        updateUi();

        runSequential(tracks, function (track) {
            assertDownloadOperationCurrent(operation);
            state.status = 'Downloading ' + track.NAME + '...';
            updateUi();
            return buildSubtitleFile(track, operation).then(function (file) {
                assertDownloadOperationCurrent(operation);
                zip.file(file.name, file.content);
            });
        }).then(function () {
            assertDownloadOperationCurrent(operation);
            state.progressLabel = 'Creating ZIP...';
            updateUi();
            return zip.generateAsync({ type: 'blob' });
        }).then(function (blob) {
            assertDownloadOperationCurrent(operation);
            saveAs(blob, operationOutputFilename(operation));
            state.status = 'Downloaded all subtitles.';
            state.progressLabel = 'Complete';
        }).catch(function (err) {
            if (isDownloadOperationCurrent(operation)) {
                state.lastError = 'Download failed: ' + err.message;
                state.progressLabel = 'Failed';
            }
        }).then(function () {
            if (finishDownloadOperation(operation)) updateUi();
        });
    }

    function downloadTrack(track) {
        if (state.wait) return;
        var operation = beginDownloadOperation('track', track);
        state.wait = true;
        state.lastError = '';
        state.selectedTrackKey = track.key;
        state.status = 'Downloading ' + track.NAME + '...';
        updateUi();

        buildSubtitleFile(track, operation).then(function (file) {
            assertDownloadOperationCurrent(operation);
            saveAs(new Blob([file.content], { type: 'text/vtt;charset=utf-8' }), file.name);
            state.status = 'Downloaded ' + track.NAME + '.';
            state.progressLabel = 'Complete';
        }).catch(function (err) {
            if (isDownloadOperationCurrent(operation)) {
                state.lastError = 'Download failed: ' + err.message;
                state.progressLabel = 'Failed';
            }
        }).then(function () {
            if (finishDownloadOperation(operation)) updateUi();
        });
    }

    function downloadPreferredTrack(language) {
        var track = findPreferredTrack(language);
        if (!track) {
            state.lastError = (language === 'ko' ? 'Korean' : 'English') + ' subtitle was not detected yet.';
            updateUi();
            return;
        }
        state.selectedTrackKey = track.key;
        state.userSelectedTrack = true;
        downloadTrack(track);
    }

    function downloadEnglishAndKorean() {
        if (state.wait) return;
        var english = findPreferredTrack('en');
        var korean = findPreferredTrack('ko');
        if (!english || !korean) {
            state.lastError = 'English and Korean subtitles must both be detected before downloading together.';
            updateUi();
            return;
        }

        var operation = beginDownloadOperation('en-ko');
        var tracks = uniqueTracks([english, korean]);
        var zip = new JSZip();
        state.wait = true;
        state.lastError = '';
        state.status = 'Downloading English + Korean subtitles...';
        updateUi();

        Promise.all(tracks.map(function (track) {
            return buildSubtitleFile(track, operation).then(function (file) {
                assertDownloadOperationCurrent(operation);
                zip.file(file.name, file.content);
            });
        })).then(function () {
            assertDownloadOperationCurrent(operation);
            state.progressLabel = 'Creating ZIP...';
            updateUi();
            return zip.generateAsync({ type: 'blob' });
        }).then(function (blob) {
            assertDownloadOperationCurrent(operation);
            saveAs(blob, operationOutputFilename(operation));
            state.status = 'Downloaded English + Korean subtitles.';
            state.progressLabel = 'Complete';
        }).catch(function (err) {
            if (isDownloadOperationCurrent(operation)) {
                state.lastError = 'Download failed: ' + err.message;
                state.progressLabel = 'Failed';
            }
        }).then(function () {
            if (finishDownloadOperation(operation)) updateUi();
        });
    }

    function uniqueTracks(tracks) {
        var seen = {};
        var output = [];
        tracks.forEach(function (track) {
            if (!track) return;
            var key = track.key || trackIdentity(track);
            if (seen[key]) return;
            seen[key] = true;
            output.push(track);
        });
        return output;
    }

    function buildSubtitleFile(track, operation) {
        assertDownloadOperationCurrent(operation);
        return ensureOperationBaseFilename(operation).then(function () {
            assertDownloadOperationCurrent(operation);
            return getTrackVtt(track, operation);
        }).then(function (vtt) {
            assertDownloadOperationCurrent(operation);
            var output = normalizeVttForDownload(vtt);
            if (!output.trim()) throw new Error('No subtitle cues found.');
            return {
                name: operation.baseFilename + '.' + safeTrackName(track) + '.vtt',
                content: output
            };
        });
    }

    function getTrackVtt(track, operation) {
        var sessionId = state.playbackSessionId;
        assertDownloadOperationCurrent(operation);
        captureCoupang('download.track-source', sessionId, function () {
            return {
                operationId: operation.id,
                track: fixtureTrackSummary(track),
                sourceKind: track.text ? 'inline' : (track.segments && track.segments.length ? 'segments' : 'uri')
            };
        });
        if (track.text) {
            addDownloadProgressTotal(operation, 1, 'Processing ' + track.NAME + '...');
            advanceDownloadProgress(operation, 'Processing ' + track.NAME + '...');
            return Promise.resolve(textToVtt(track.text, track));
        }
        if (track.segments && track.segments.length) return mergeSegments(track, operation);

        state.progressLabel = 'Reading ' + track.NAME + ' playlist...';
        updateUi();

        return getText(track.URI).then(function (text) {
            if (!isPlaybackSessionCurrent(sessionId)) throw new Error('Playback changed while downloading subtitles.');
            assertDownloadOperationCurrent(operation);
            if (/^\s*WEBVTT/i.test(text)) {
                addDownloadProgressTotal(operation, 1, 'Processing ' + track.NAME + '...');
                advanceDownloadProgress(operation, 'Processing ' + track.NAME + '...');
                return text;
            }
            if (looksLikeTtmlText(text)) {
                addDownloadProgressTotal(operation, 1, 'Processing ' + track.NAME + '...');
                advanceDownloadProgress(operation, 'Processing ' + track.NAME + '...');
                return ttmlToVtt(text);
            }
            if (looksLikeSrt(text)) {
                addDownloadProgressTotal(operation, 1, 'Processing ' + track.NAME + '...');
                advanceDownloadProgress(operation, 'Processing ' + track.NAME + '...');
                return srtToVtt(text);
            }
            if (/^\s*#EXTM3U/i.test(text)) {
                var hlsSegments = extractHlsSegmentEntries(text, track.URI);
                track.playlistDuration = playlistDurationSeconds(text) || track.playlistDuration;
                if (!hlsSegments.length) throw new Error('No subtitle segments found for ' + track.NAME + '.');
                track.hlsSegments = hlsSegments;
                track.segments = hlsSegments.map(function (segment) { return segment.url; });
                return mergeSegments(track, operation);
            }
            if (/^\s*<MPD[\s>]/i.test(text)) {
                parseDashManifest(track.URI, text);
                throw new Error('DASH manifest was parsed. Select a detected text track and retry.');
            }
            addDownloadProgressTotal(operation, 1, 'Processing ' + track.NAME + '...');
            advanceDownloadProgress(operation, 'Processing ' + track.NAME + '...');
            return textToVtt(text, track);
        });
    }

    function mergeSegments(track, operation) {
        var segments = track.hlsSegments && track.hlsSegments.length ? track.hlsSegments : (track.segments || []).map(function (url) {
            return { url: url, map: null };
        });
        var merged = '';
        var headerState = createHlsVttHeaderState();
        var timestampState = createHlsTimestampState();
        var mapCache = {};
        var seenBlocks = {};
        var failedSegments = [];
        var cueCount = 0;
        addDownloadProgressTotal(operation, segments.length, 'Downloading ' + track.NAME + ' segments...');
        return runSequential(segments, function (segment) {
            assertDownloadOperationCurrent(operation);
            return Promise.all([
                getHlsResourceText(segment.url, segment.byterange),
                getHlsInitText(segment.map, mapCache)
            ]).then(function (values) {
                var converted = textToVtt(values[0], track);
                collectHlsVttHeaderMetadata(values[1], headerState);
                collectHlsVttHeaderMetadata(values[0], headerState);
                var cleaned = normalizeHlsVttSegment(converted, timestampState, values[1]);
                var uniqueBody = uniqueHlsVttBody(cleaned, seenBlocks);
                if (uniqueBody) {
                    merged += uniqueBody + '\n\n';
                    cueCount += countHlsVttCues(uniqueBody);
                }
            }).catch(function (err) {
                failedSegments.push(segment.url);
                debuglog('Segment failed: ' + err.message);
            }).then(function () {
                advanceDownloadProgress(operation, 'Downloading ' + track.NAME + ' segments...');
            });
        }).then(function () {
            if (failedSegments.length) {
                throw new Error('Failed to download ' + failedSegments.length + ' of ' + segments.length + ' subtitle segments; refusing to save an incomplete subtitle.');
            }
            if (cueCount === 0) throw new Error('No subtitle cues found in downloaded segments.');
            return buildMergedHlsVtt(headerState, merged);
        });
    }

    function textToVtt(text, track) {
        var value = String(text || '').replace(/^\uFEFF/, '');
        if (/^\s*WEBVTT/i.test(value)) return value;
        if (looksLikeTtmlText(value) || track.contentType === 'ttml') return ttmlToVtt(value);
        if (looksLikeSrt(value) || track.contentType === 'srt') return srtToVtt(value);
        return value;
    }

    function createHlsVttHeaderState() {
        return { blocks: [], seen: {}, locked: false };
    }

    function hlsVttBlocks(text) {
        var value = String(text || '')
            .replace(/^\uFEFF/, '')
            .replace(/\r\n|\r/g, '\n')
            .replace(/^WEBVTT[^\n]*(?:\n|$)/i, '')
            .replace(/^X-TIMESTAMP-MAP\s*=\s*[^\n]*(?:\n|$)/gmi, '')
            .trim();
        return value ? value.split(/\n{2,}/) : [];
    }

    function isHlsVttCueBlock(block) {
        return /(?:^|\n)[ \t]*(?:(?:\d{2,}:)?\d{2}:\d{2}\.\d{3})[ \t]+-->/.test(block || '');
    }

    function isHlsVttHeaderMetadataBlock(block) {
        return /^(?:STYLE|REGION)(?:[ \t]|\n|$)/i.test(String(block || '').trim());
    }

    function collectHlsVttHeaderMetadata(text, state) {
        if (!state || state.locked) return;
        var beforeFirstCue = true;
        var sawCue = false;
        hlsVttBlocks(text).forEach(function (block) {
            block = block.trim();
            if (!block) return;
            if (isHlsVttCueBlock(block)) {
                beforeFirstCue = false;
                sawCue = true;
            }
            if (!beforeFirstCue || !isHlsVttHeaderMetadataBlock(block) || state.seen[block]) return;
            state.seen[block] = true;
            state.blocks.push(block);
        });
        if (sawCue) state.locked = true;
    }

    function buildMergedHlsVtt(headerState, body) {
        var metadata = headerState && headerState.blocks.length ? headerState.blocks.join('\n\n') + '\n\n' : '';
        return 'WEBVTT\n\n' + metadata + String(body || '');
    }

    function cleanVttSegment(text) {
        var output = [];
        var beforeFirstCue = true;
        hlsVttBlocks(text).forEach(function (block) {
            block = block.trim();
            if (!block) return;
            if (isHlsVttCueBlock(block)) beforeFirstCue = false;
            if (beforeFirstCue && isHlsVttHeaderMetadataBlock(block)) return;
            output.push(block);
        });
        return output.join('\n\n');
    }

    function createHlsTimestampState() {
        return { baseOffsetSeconds: null };
    }

    function normalizeHlsVttSegment(text, timestampState, initText) {
        var value = String(text || '').replace(/\r\n|\r/g, '\n');
        var initValue = String(initText || '').replace(/\r\n|\r/g, '\n');
        var timestampMap = parseHlsTimestampMap(value) || parseHlsTimestampMap(initValue);
        var offsetSeconds = timestampMap ? timestampMap.mpegTimestamp / 90000 - timestampMap.localSeconds : 0;
        if (timestampState.baseOffsetSeconds === null) {
            timestampState.baseOffsetSeconds = offsetSeconds;
        }
        var shiftSeconds = normalizeHlsTimestampOffset(offsetSeconds - timestampState.baseOffsetSeconds);
        if (Math.abs(shiftSeconds) >= 0.0005) {
            value = shiftHlsVttCueTimes(value, shiftSeconds);
        }
        return cleanVttSegment(value);
    }

    function getHlsResourceText(url, byterange, retryCount) {
        if (!byterange) return getText(url);
        retryCount = retryCount || 0;
        var end = byterange.offset + byterange.length - 1;
        var rangeHeader = 'bytes=' + byterange.offset + '-' + end;
        return new Promise(function (resolve, reject) {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                headers: { Range: rangeHeader },
                responseType: 'text',
                onload: function (response) {
                    if (response.status === 206) {
                        if (!hlsContentRangeMatches(response.responseHeaders, byterange)) {
                            reject(new Error('Missing or unexpected Content-Range for ' + url));
                            return;
                        }
                        resolve(response.responseText || '');
                        return;
                    }
                    if (shouldRetryHttpStatus(response.status) && scheduleRetry(retryCount, response.responseHeaders, function () {
                        return getHlsResourceText(url, byterange, retryCount + 1);
                    }, resolve, reject)) return;
                    if (response.status === 200) {
                        reject(new Error('Server ignored HLS byte range for ' + url));
                        return;
                    }
                    reject(new Error('HTTP ' + response.status + ' for HLS byte range ' + url));
                },
                onerror: function () {
                    if (scheduleRetry(retryCount, '', function () {
                        return getHlsResourceText(url, byterange, retryCount + 1);
                    }, resolve, reject)) return;
                    reject(new Error('Network error for HLS byte range ' + url));
                },
                ontimeout: function () {
                    if (scheduleRetry(retryCount, '', function () {
                        return getHlsResourceText(url, byterange, retryCount + 1);
                    }, resolve, reject)) return;
                    reject(new Error('Timeout for HLS byte range ' + url));
                }
            });
        });
    }

    function hlsContentRangeMatches(headers, byterange) {
        var match = String(headers || '').match(/(?:^|\r?\n)\s*Content-Range\s*:\s*bytes\s+(\d+)-(\d+)\/(?:\d+|\*)/i);
        if (!match) return false;
        return Number(match[1]) === byterange.offset &&
            Number(match[2]) === byterange.offset + byterange.length - 1;
    }

    function hlsByteRangeCacheKey(url, byterange) {
        return url + '|' + (byterange ? byterange.offset + ':' + byterange.length : 'all');
    }

    function getHlsInitText(mapInfo, cache) {
        if (!mapInfo || !mapInfo.url) return Promise.resolve('');
        var key = hlsByteRangeCacheKey(mapInfo.url, mapInfo.byterange);
        if (!cache[key]) {
            cache[key] = getHlsResourceText(mapInfo.url, mapInfo.byterange);
        }
        return cache[key];
    }

    function parseHlsTimestampMap(text) {
        var line = String(text || '').match(/^X-TIMESTAMP-MAP\s*=\s*([^\n]+)$/mi);
        if (!line) return null;
        var local = line[1].match(/(?:^|,)\s*LOCAL:([^,\s]+)/i);
        var mpeg = line[1].match(/(?:^|,)\s*MPEGTS:(\d+)/i);
        if (!local || !mpeg) return null;
        var localSeconds = hlsTimestampSeconds(local[1]);
        var mpegTimestamp = Number(mpeg[1]);
        if (!isFinite(localSeconds) || !isFinite(mpegTimestamp)) return null;
        return { localSeconds: localSeconds, mpegTimestamp: mpegTimestamp };
    }

    function normalizeHlsTimestampOffset(seconds) {
        var wrapSeconds = Math.pow(2, 33) / 90000;
        return ((seconds + wrapSeconds / 2) % wrapSeconds + wrapSeconds) % wrapSeconds - wrapSeconds / 2;
    }

    function shiftHlsVttCueTimes(text, shiftSeconds) {
        return String(text || '').replace(
            /^([ \t]*)((?:\d{2,}:)?\d{2}:\d{2}\.\d{3})([ \t]+-->[ \t]+)((?:\d{2,}:)?\d{2}:\d{2}\.\d{3})(.*)$/gm,
            function (_, prefix, start, arrow, end, settings) {
                return prefix +
                    formatHlsTimestamp(hlsTimestampSeconds(start) + shiftSeconds) +
                    arrow +
                    formatHlsTimestamp(hlsTimestampSeconds(end) + shiftSeconds) +
                    settings;
            }
        );
    }

    function hlsTimestampSeconds(value) {
        var parts = String(value || '').split(':');
        if (parts.length === 3) {
            return (parseInt(parts[0], 10) || 0) * 3600 +
                (parseInt(parts[1], 10) || 0) * 60 +
                (parseFloat(parts[2]) || 0);
        }
        if (parts.length === 2) {
            return (parseInt(parts[0], 10) || 0) * 60 + (parseFloat(parts[1]) || 0);
        }
        return NaN;
    }

    function formatHlsTimestamp(seconds) {
        var totalMs = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
        var hours = Math.floor(totalMs / 3600000);
        var minutes = Math.floor((totalMs % 3600000) / 60000);
        var secs = Math.floor((totalMs % 60000) / 1000);
        var ms = totalMs % 1000;
        return String(hours).padStart(2, '0') + ':' +
            String(minutes).padStart(2, '0') + ':' +
            String(secs).padStart(2, '0') + '.' +
            String(ms).padStart(3, '0');
    }

    function uniqueHlsVttBody(text, seenBlocks) {
        var output = [];
        String(text || '').replace(/\r\n|\r/g, '\n').split(/\n{2,}/).forEach(function (block) {
            block = block.trim();
            if (!block || seenBlocks[block]) return;
            seenBlocks[block] = true;
            output.push(block);
        });
        return output.join('\n\n');
    }

    function countHlsVttCues(text) {
        var count = 0;
        String(text || '').split(/\r\n|\r|\n/).forEach(function (line) {
            if (line.indexOf('-->') >= 0) count++;
        });
        return count;
    }

    function normalizeVttForDownload(vtt) {
        var text = String(vtt || '')
            .replace(/^\uFEFF/, '')
            .replace(/\r\n|\r|\n/g, '\n')
            .trim();
        if (!text) return '';
        if (!/^\s*WEBVTT\b/i.test(text)) text = 'WEBVTT\n\n' + cleanVttSegment(text).trim();
        return text.replace(/\n/g, '\r\n') + '\r\n';
    }

    function looksLikeSrt(text) {
        return /\d+\s*\n\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}/.test(text || '');
    }

    function srtToVtt(srt) {
        return 'WEBVTT\n\n' + String(srt || '')
            .replace(/^\uFEFF/, '')
            .replace(/\r\n|\r/g, '\n')
            .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
            .replace(/^\d+\s*\n/gm, '')
            .trim() + '\n';
    }

    function looksLikeTtmlText(text) {
        var value = String(text || '').replace(/^\uFEFF/, '').trim();
        if (!value) return false;
        value = value.replace(/^<\?xml[\s\S]*?\?>\s*/i, '');
        value = value.replace(/^(?:<!--[\s\S]*?-->\s*)+/, '');
        return /^<(?:[A-Za-z_][\w.-]*:)?tt(?:\s|>)/i.test(value);
    }

    function ttmlToVtt(ttml) {
        var doc;
        try {
            doc = new DOMParser().parseFromString(ttml, 'application/xml');
        } catch (err) {
            return '';
        }
        if (!doc || ttmlHasParserError(doc)) return '';

        var context = ttmlTimingContext(doc);
        if (!context) return '';
        var paragraphs = Array.prototype.slice.call(doc.getElementsByTagName('*')).filter(function (node) {
            return localName(node) === 'p';
        });
        var cues = [];
        paragraphs.forEach(function (p) {
            var intervals = ttmlParagraphCueIntervals(p, doc, context);
            intervals.forEach(function (cue) {
                cues.push(formatVttTime(cue.begin) + ' --> ' + formatVttTime(cue.end) + (cue.settings ? ' ' + cue.settings : '') + '\n' + cue.text);
            });
        });
        return ttmlVttDocument(cues);
    }

    function ttmlVttDocument(cues) {
        var body = (cues || []).join('\n\n');
        var header = 'WEBVTT\n\n';
        if (body.indexOf('<c.ttml-combine>') >= 0) {
            header += 'STYLE\n::cue(.ttml-combine) { text-combine-upright: all; }\n\n';
        }
        return header + body + '\n';
    }

    function ttmlHasParserError(doc) {
        return Array.prototype.slice.call(doc.getElementsByTagName('*')).some(function (node) {
            return localName(node) === 'parsererror';
        });
    }

    function ttmlAttribute(node, name) {
        if (!node || !node.attributes) return '';
        for (var i = 0; i < node.attributes.length; i++) {
            var attribute = node.attributes[i];
            if (localName(attribute) === name) return attribute.value || '';
        }
        return '';
    }

    function ttmlRootElement(doc) {
        var nodes = Array.prototype.slice.call(doc.getElementsByTagName('*'));
        for (var i = 0; i < nodes.length; i++) {
            if (localName(nodes[i]) === 'tt') return nodes[i];
        }
        return null;
    }

    function ttmlTimingContext(doc) {
        var root = ttmlRootElement(doc);
        if (!root) return null;
        var timeBase = String(ttmlAttribute(root, 'timeBase') || 'media').toLowerCase();
        if (timeBase !== 'media') return null;

        var frameRateText = ttmlAttribute(root, 'frameRate').trim();
        var frameRateSpecified = frameRateText !== '';
        var frameRate = 30;
        if (frameRateSpecified) {
            if (!/^\d+$/.test(frameRateText)) return null;
            frameRate = Number(frameRateText);
            if (!isFinite(frameRate) || frameRate <= 0) return null;
        }

        var multiplierText = ttmlAttribute(root, 'frameRateMultiplier').trim();
        var multiplierNumerator = 1;
        var multiplierDenominator = 1;
        if (multiplierText) {
            var multiplier = multiplierText.split(/\s+/);
            if (multiplier.length !== 2 || !/^\d+$/.test(multiplier[0]) || !/^\d+$/.test(multiplier[1])) return null;
            multiplierNumerator = Number(multiplier[0]);
            multiplierDenominator = Number(multiplier[1]);
            if (!isFinite(multiplierNumerator) || multiplierNumerator <= 0 ||
                !isFinite(multiplierDenominator) || multiplierDenominator <= 0) return null;
        }

        var effectiveFrameRate = frameRate * multiplierNumerator / multiplierDenominator;
        var subFrameRateText = ttmlAttribute(root, 'subFrameRate').trim();
        var subFrameRate = 1;
        if (subFrameRateText) {
            if (!/^\d+$/.test(subFrameRateText)) return null;
            subFrameRate = Number(subFrameRateText);
            if (!isFinite(subFrameRate) || subFrameRate <= 0) return null;
        }

        var tickRateText = ttmlAttribute(root, 'tickRate').trim();
        var tickRate;
        if (tickRateText) {
            if (!/^\d+$/.test(tickRateText)) return null;
            tickRate = Number(tickRateText);
            if (!isFinite(tickRate) || tickRate <= 0) return null;
        } else {
            tickRate = frameRateSpecified ? effectiveFrameRate * subFrameRate : 1;
        }

        return {
            frameRate: frameRate,
            effectiveFrameRate: effectiveFrameRate,
            subFrameRate: subFrameRate,
            tickRate: tickRate
        };
    }

    function ttmlTimeContainer(node) {
        return String(ttmlAttribute(node, 'timeContainer') || 'par').toLowerCase() === 'seq' ? 'seq' : 'par';
    }

    function ttmlIsTimedElement(node) {
        return !!node && node.nodeType === 1 && /^(?:body|div|p|span|set)$/.test(localName(node));
    }

    function ttmlTimingParent(node) {
        var current = node && node.parentNode;
        while (current) {
            if (ttmlIsTimedElement(current)) return current;
            current = current.parentNode;
        }
        return null;
    }

    function ttmlPreviousTimedSibling(node) {
        var parent = node && node.parentNode;
        if (!parent || !parent.childNodes) return null;
        var previous = null;
        for (var i = 0; i < parent.childNodes.length; i++) {
            var child = parent.childNodes[i];
            if (child === node) return previous;
            if (ttmlIsTimedElement(child)) previous = child;
        }
        return null;
    }

    function ttmlResolveTiming(node, context, depth) {
        if (!node || depth > 64) return null;
        var parent = ttmlTimingParent(node);
        var parentTiming = parent ? ttmlResolveTiming(parent, context, depth + 1) : { begin: 0, end: Infinity };
        if (!parentTiming) return null;

        var referenceBegin = parentTiming.begin;
        if (parent && ttmlTimeContainer(parent) === 'seq') {
            var previous = ttmlPreviousTimedSibling(node);
            if (previous) {
                if (!ttmlAttribute(previous, 'end') && !ttmlAttribute(previous, 'dur')) return null;
                var previousTiming = ttmlResolveTiming(previous, context, depth + 1);
                if (!previousTiming || !isFinite(previousTiming.end)) return null;
                referenceBegin = previousTiming.end;
            }
        }

        var beginText = ttmlAttribute(node, 'begin') || ttmlAttribute(node, 'start');
        var beginOffset = beginText ? ttmlTimeSeconds(beginText, context) : 0;
        if (!isFinite(beginOffset) || beginOffset < 0) return null;
        var begin = referenceBegin + beginOffset;
        var end = parentTiming.end;

        var endText = ttmlAttribute(node, 'end');
        if (endText) {
            var endOffset = ttmlTimeSeconds(endText, context);
            if (!isFinite(endOffset) || endOffset < 0) return null;
            end = Math.min(end, referenceBegin + endOffset);
        }

        var durText = ttmlAttribute(node, 'dur');
        if (durText) {
            var duration = ttmlTimeSeconds(durText, context);
            if (!isFinite(duration) || duration < 0) return null;
            end = Math.min(end, begin + duration);
        }

        if (isFinite(parentTiming.end)) end = Math.min(end, parentTiming.end);
        if (end < begin) return null;
        return { begin: begin, end: end };
    }

    function ttmlTimeSeconds(value, context) {
        value = String(value || '').trim();
        if (!value) return NaN;
        context = context || { frameRate: 30, effectiveFrameRate: 30, subFrameRate: 1, tickRate: 1 };

        var frameClock = value.match(/^(\d+):([0-5]?\d):([0-5]?\d):(\d+)(?:\.(\d+))?$/);
        if (frameClock) {
            var frames = Number(frameClock[4]);
            var subFrames = Number(frameClock[5] || '0');
            if (frames >= context.frameRate || subFrames >= context.subFrameRate) return NaN;
            return Number(frameClock[1]) * 3600 +
                Number(frameClock[2]) * 60 +
                Number(frameClock[3]) +
                (frames + subFrames / context.subFrameRate) / context.effectiveFrameRate;
        }

        var clock = value.match(/^(\d+):([0-5]?\d):([0-5]?\d(?:\.\d+)?)$/);
        if (clock) {
            return Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
        }

        var offset = value.match(/^(\d+(?:\.\d+)?)(ms|h|m|s|f|t)$/i);
        if (!offset) return NaN;
        var amount = Number(offset[1]);
        var unit = offset[2].toLowerCase();
        if (unit === 'h') return amount * 3600;
        if (unit === 'm') return amount * 60;
        if (unit === 's') return amount;
        if (unit === 'ms') return amount / 1000;
        if (unit === 'f') return amount / context.effectiveFrameRate;
        if (unit === 't') return amount / context.tickRate;
        return NaN;
    }

    function ttmlStyleMap(doc) {
        var styles = {};
        Array.prototype.slice.call(doc.getElementsByTagName('*')).forEach(function (node) {
            if (localName(node) !== 'style' || !ttmlHasAncestor(node, 'styling')) return;
            var id = ttmlAttribute(node, 'id');
            if (id) styles[id] = node;
        });
        return styles;
    }

    function ttmlHasAncestor(node, name) {
        var current = node && node.parentNode;
        while (current) {
            if (localName(current) === name) return true;
            current = current.parentNode;
        }
        return false;
    }

    function ttmlSpecifiedPresentationStyle(node, styleMap, resolving) {
        var specified = {};
        if (!node || node.nodeType !== 1) return specified;
        resolving = resolving || {};

        var references = String(node.getAttribute('style') || '')
            .trim()
            .split(/\s+/)
            .filter(Boolean);
        references.forEach(function (id) {
            var referenced = styleMap[id];
            if (!referenced || resolving[id]) return;
            var nextResolving = {};
            Object.keys(resolving).forEach(function (key) {
                nextResolving[key] = true;
            });
            nextResolving[id] = true;
            ttmlMergePresentationStyle(specified, ttmlSpecifiedPresentationStyle(referenced, styleMap, nextResolving));
        });

        ['fontWeight', 'fontStyle', 'textDecoration', 'ruby', 'fontSize', 'textCombine', 'textOrientation', 'origin', 'extent', 'position', 'textAlign', 'displayAlign', 'writingMode'].forEach(function (name) {
            var value = ttmlAttribute(node, name);
            if (value) specified[name] = value;
        });
        return specified;
    }

    function ttmlMergePresentationStyle(target, source) {
        Object.keys(source || {}).forEach(function (key) {
            target[key] = source[key];
        });
        return target;
    }

    function ttmlComputedPresentationStyle(node, styleMap) {
        var inherited = {
            bold: false,
            italic: false,
            underline: false,
            ruby: 'none',
            textCombine: 'none',
            textOrientation: 'mixed'
        };
        var parent = node && node.parentNode;
        if (parent && parent.nodeType === 1) {
            var parentStyle = ttmlComputedPresentationStyle(parent, styleMap);
            inherited.bold = parentStyle.bold;
            inherited.italic = parentStyle.italic;
            inherited.underline = parentStyle.underline;
            inherited.textCombine = parentStyle.textCombine;
            inherited.textOrientation = parentStyle.textOrientation;
        }

        var specified = ttmlSpecifiedPresentationStyle(node, styleMap);
        if (specified.fontWeight) {
            inherited.bold = String(specified.fontWeight).toLowerCase() === 'bold';
        }
        if (specified.fontStyle) {
            var fontStyle = String(specified.fontStyle).toLowerCase();
            inherited.italic = fontStyle === 'italic' || fontStyle === 'oblique';
        }
        if (specified.textDecoration) {
            inherited.underline = ttmlUnderlineFromDecoration(specified.textDecoration, inherited.underline);
        }
        inherited.ruby = specified.ruby ? String(specified.ruby) : 'none';
        if (specified.textCombine) inherited.textCombine = String(specified.textCombine).toLowerCase() === 'all' ? 'all' : 'none';
        if (specified.textOrientation) {
            var textOrientation = String(specified.textOrientation).toLowerCase();
            inherited.textOrientation = /^(?:mixed|upright|sideways)$/.test(textOrientation) ? textOrientation : 'mixed';
        }
        return inherited;
    }

    function ttmlSetAppliesAtTime(node, timingContext, activeTime) {
        if (!node || localName(node) !== 'set' || typeof activeTime !== 'number' || !isFinite(activeTime)) return false;
        if (ttmlAttribute(node, 'repeatCount')) return false;
        var timing = ttmlResolveTiming(node, timingContext, 0);
        if (!timing) return false;
        if (activeTime >= timing.begin && activeTime < timing.end) return true;
        var fill = String(ttmlAttribute(node, 'fill') || 'remove').toLowerCase();
        return fill === 'freeze' && activeTime >= timing.end;
    }

    function ttmlActiveSetStyle(node, styleMap, timingContext, activeTime, propertyNames) {
        var animated = {};
        Array.prototype.slice.call(node && node.childNodes || []).forEach(function (child) {
            if (child.nodeType !== 1 || localName(child) !== 'set') return;
            if (!ttmlSetAppliesAtTime(child, timingContext, activeTime)) return;
            var specified = ttmlSpecifiedPresentationStyle(child, styleMap);
            (propertyNames || []).forEach(function (name) {
                if (specified[name]) animated[name] = specified[name];
            });
        });
        return animated;
    }

    function ttmlActiveInlineSetStyle(node, styleMap, timingContext, activeTime) {
        return ttmlActiveSetStyle(node, styleMap, timingContext, activeTime,
            ['fontWeight', 'fontStyle', 'textDecoration', 'textCombine', 'textOrientation']);
    }

    function ttmlComputedPresentationStyleAtTime(node, styleMap, timingContext, activeTime) {
        var inherited = {
            bold: false,
            italic: false,
            underline: false,
            ruby: 'none',
            textCombine: 'none',
            textOrientation: 'mixed'
        };
        var parent = node && node.parentNode;
        if (parent && parent.nodeType === 1) {
            var parentStyle = ttmlComputedPresentationStyleAtTime(parent, styleMap, timingContext, activeTime);
            inherited.bold = parentStyle.bold;
            inherited.italic = parentStyle.italic;
            inherited.underline = parentStyle.underline;
            inherited.textCombine = parentStyle.textCombine;
            inherited.textOrientation = parentStyle.textOrientation;
        }

        var specified = ttmlSpecifiedPresentationStyle(node, styleMap);
        var animated = ttmlActiveInlineSetStyle(node, styleMap, timingContext, activeTime);
        ttmlMergePresentationStyle(specified, animated);
        if (specified.fontWeight) inherited.bold = String(specified.fontWeight).toLowerCase() === 'bold';
        if (specified.fontStyle) {
            var fontStyle = String(specified.fontStyle).toLowerCase();
            inherited.italic = fontStyle === 'italic' || fontStyle === 'oblique';
        }
        if (specified.textDecoration) inherited.underline = ttmlUnderlineFromDecoration(specified.textDecoration, inherited.underline);
        inherited.ruby = specified.ruby ? String(specified.ruby) : 'none';
        if (specified.textCombine) inherited.textCombine = String(specified.textCombine).toLowerCase() === 'all' ? 'all' : 'none';
        if (specified.textOrientation) {
            var textOrientation = String(specified.textOrientation).toLowerCase();
            inherited.textOrientation = /^(?:mixed|upright|sideways)$/.test(textOrientation) ? textOrientation : 'mixed';
        }
        return inherited;
    }

    function ttmlUnderlineFromDecoration(value, inherited) {
        var tokens = String(value || '')
            .toLowerCase()
            .split(/\s+/);
        if (tokens.indexOf('none') >= 0 || tokens.indexOf('nounderline') >= 0) return false;
        if (tokens.indexOf('underline') >= 0) return true;
        return inherited;
    }

    function ttmlRegionMap(doc) {
        var regions = {};
        Array.prototype.slice.call(doc.getElementsByTagName('*')).forEach(function (node) {
            if (localName(node) !== 'region' || !ttmlHasAncestor(node, 'layout')) return;
            var id = ttmlAttribute(node, 'id');
            if (id) regions[id] = node;
        });
        return regions;
    }

    function ttmlCueRegion(node, doc) {
        var regions = ttmlRegionMap(doc);
        var current = node;
        while (current && current.nodeType === 1) {
            var regionId = String(current.getAttribute('region') || '').trim();
            if (regionId) return regions[regionId] || null;
            current = current.parentNode;
        }
        return null;
    }

    function ttmlRegionPresentationStyle(region, styleMap) {
        var resolved = ttmlSpecifiedPresentationStyle(region, styleMap);
        Array.prototype.slice.call(region && region.childNodes || []).forEach(function (child) {
            if (child.nodeType !== 1 || localName(child) !== 'style') return;
            ttmlMergePresentationStyle(resolved, ttmlSpecifiedPresentationStyle(child, styleMap));
        });
        return resolved;
    }

    function ttmlRegionPresentationStyleAtTime(region, styleMap, timingContext, activeTime) {
        var resolved = ttmlRegionPresentationStyle(region, styleMap);
        ttmlMergePresentationStyle(resolved, ttmlActiveSetStyle(region, styleMap, timingContext, activeTime,
            ['fontSize', 'origin', 'extent', 'position', 'textAlign', 'displayAlign', 'writingMode']));
        return resolved;
    }

    function ttmlPercentagePair(value) {
        var match = String(value || '').trim().match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+))%\s+([+-]?(?:\d+(?:\.\d+)?|\.\d+))%$/);
        if (!match) return null;
        var first = Number(match[1]);
        var second = Number(match[2]);
        if (!isFinite(first) || !isFinite(second)) return null;
        return [first, second];
    }

    function ttmlRootPixelExtent(doc) {
        var root = ttmlRootElement(doc);
        if (!root) return null;
        var match = String(ttmlAttribute(root, 'extent') || '').trim().match(/^([+]?(?:\d+(?:\.\d+)?|\.\d+))px\s+([+]?(?:\d+(?:\.\d+)?|\.\d+))px$/i);
        if (!match) return null;
        var width = Number(match[1]);
        var height = Number(match[2]);
        if (!isFinite(width) || !isFinite(height) || width <= 0 || height <= 0) return null;
        return [width, height];
    }

    function ttmlCellResolution(doc) {
        var root = ttmlRootElement(doc);
        if (!root) return null;
        var value = String(ttmlAttribute(root, 'cellResolution') || '').trim();
        if (!value) return [32, 15];
        var match = value.match(/^(\d+)\s+(\d+)$/);
        if (!match) return null;
        var columns = Number(match[1]);
        var rows = Number(match[2]);
        if (!isFinite(columns) || !isFinite(rows) || columns <= 0 || rows <= 0) return null;
        return [columns, rows];
    }

    function ttmlLayoutContext(doc, fontSize) {
        return {
            rootPixelExtent: ttmlRootPixelExtent(doc),
            cellResolution: ttmlCellResolution(doc),
            fontSize: fontSize || null
        };
    }

    function ttmlConvertPercentageAxis(value, fromAxis, toAxis, context) {
        value = Number(value);
        if (!isFinite(value)) return null;
        if (fromAxis === toAxis) return value;
        var root = context && context.rootPixelExtent;
        if (!root || root[0] <= 0 || root[1] <= 0) return null;
        if (fromAxis === 'h' && toAxis === 'v') return value * root[0] / root[1];
        if (fromAxis === 'v' && toAxis === 'h') return value * root[1] / root[0];
        return null;
    }

    function ttmlInitialFontSizeValue(doc) {
        var value = '';
        Array.prototype.slice.call(doc && doc.getElementsByTagName('*') || []).forEach(function (node) {
            if (localName(node) !== 'initial') return;
            var candidate = ttmlAttribute(node, 'fontSize');
            if (candidate) value = candidate;
        });
        return value || '1c';
    }

    function ttmlFontSizeRelativeFactor(value) {
        var match = String(value || '').trim().match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+))(em|%)$/i);
        if (!match) return null;
        var amount = Number(match[1]);
        if (!isFinite(amount) || amount < 0) return null;
        return match[2].toLowerCase() === 'em' ? amount : amount / 100;
    }

    function ttmlResolveFontSize(value, parentSize, context) {
        var tokens = String(value || '').trim().split(/\s+/).filter(Boolean);
        if (tokens.length < 1 || tokens.length > 2) return null;
        var baseContext = {
            rootPixelExtent: context && context.rootPixelExtent || null,
            cellResolution: context && context.cellResolution || null,
            fontSize: null
        };

        function component(token, axis, parentComponent) {
            var relative = ttmlFontSizeRelativeFactor(token);
            if (relative !== null) {
                if (!parentSize || !isFinite(parentComponent)) return null;
                return parentComponent * relative;
            }
            return ttmlLengthToPercentage(token, axis, baseContext);
        }

        if (tokens.length === 2) {
            var width = component(tokens[0], 'h', parentSize && parentSize[0]);
            var height = component(tokens[1], 'v', parentSize && parentSize[1]);
            if (width === null || height === null || width < 0 || height < 0) return null;
            return [width, height];
        }

        var relative = ttmlFontSizeRelativeFactor(tokens[0]);
        var height;
        if (relative !== null) {
            if (!parentSize) return null;
            height = parentSize[1] * relative;
        } else {
            height = ttmlLengthToPercentage(tokens[0], 'v', baseContext);
        }
        if (height === null || height < 0) return null;
        var width = ttmlConvertPercentageAxis(height, 'v', 'h', context);
        if (width === null) return null;
        return [width, height];
    }

    function ttmlInitialFontSize(doc, context) {
        var specificationDefault = ttmlResolveFontSize('1c', null, context);
        if (!specificationDefault) return null;
        var value = ttmlInitialFontSizeValue(doc);
        if (value === '1c') return specificationDefault;
        return ttmlResolveFontSize(value, specificationDefault, context);
    }

    function ttmlCellFontSizeReference(context) {
        var cells = context && context.cellResolution;
        if (!cells || cells[0] <= 0 || cells[1] <= 0) return null;
        return [100 / cells[0], 100 / cells[1]];
    }

    function ttmlRegionFontSize(regionStyle, doc, context) {
        var value = regionStyle && regionStyle.fontSize || '';
        if (value) {
            var cellReference = ttmlCellFontSizeReference(context);
            if (!cellReference) return null;
            return ttmlResolveFontSize(value, cellReference, context);
        }
        return ttmlInitialFontSize(doc, context);
    }

    function ttmlContentFontSize(node, doc, styleMap, regionFontSize, context, depth, timingContext, activeTime) {
        if (!node || depth > 64) return regionFontSize;
        var parent = node.parentNode;
        while (parent && parent.nodeType === 1 && !/^(?:body|div|p|span)$/.test(localName(parent))) {
            parent = parent.parentNode;
        }
        var parentSize = parent && parent.nodeType === 1
            ? ttmlContentFontSize(parent, doc, styleMap, regionFontSize, context, depth + 1, timingContext, activeTime)
            : regionFontSize;
        if (!parentSize) return null;
        var specified = ttmlSpecifiedPresentationStyle(node, styleMap);
        ttmlMergePresentationStyle(specified, ttmlActiveSetStyle(node, styleMap, timingContext, activeTime, ['fontSize']));
        return specified.fontSize ? ttmlResolveFontSize(specified.fontSize, parentSize, context) : parentSize;
    }

    function ttmlLengthToPercentage(value, axis, context) {
        var match = String(value || '').trim().match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+))(px|c|rw|rh|em)$/i);
        if (!match) {
            var percent = String(value || '').trim().match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+))%$/);
            if (!percent) return null;
            var percentValue = Number(percent[1]);
            return isFinite(percentValue) ? percentValue : null;
        }

        var amount = Number(match[1]);
        var unit = match[2].toLowerCase();
        if (!isFinite(amount)) return null;
        context = context || {};

        if (unit === 'em') {
            var fontSize = context.fontSize;
            if (!fontSize) return null;
            var component = axis === 'h' ? fontSize[0] : fontSize[1];
            return isFinite(component) ? amount * component : null;
        }
        if (unit === 'c') {
            var cells = context.cellResolution;
            if (!cells) return null;
            var divisor = axis === 'h' ? cells[0] : cells[1];
            return divisor > 0 ? amount * 100 / divisor : null;
        }

        var root = context.rootPixelExtent;
        if (unit === 'px') {
            if (!root) return null;
            var dimension = axis === 'h' ? root[0] : root[1];
            return dimension > 0 ? amount * 100 / dimension : null;
        }
        if (unit === 'rw') {
            if (axis === 'h') return amount;
            if (!root || root[1] <= 0) return null;
            return amount * root[0] / root[1];
        }
        if (unit === 'rh') {
            if (axis === 'v') return amount;
            if (!root || root[0] <= 0) return null;
            return amount * root[1] / root[0];
        }
        return null;
    }

    function ttmlLengthPairToPercentage(value, context) {
        var tokens = String(value || '').trim().split(/\s+/).filter(Boolean);
        if (tokens.length !== 2) return null;
        var first = ttmlLengthToPercentage(tokens[0], 'h', context);
        var second = ttmlLengthToPercentage(tokens[1], 'v', context);
        if (first === null || second === null) return null;
        return [first, second];
    }

    function ttmlLayoutPercentage(value) {
        var rounded = Math.round(Number(value) * 1000) / 1000;
        if (!isFinite(rounded)) return '';
        return String(rounded).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1') + '%';
    }

    function ttmlPositionPercentFactor(value) {
        var match = String(value || '').trim().match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+))%$/);
        if (!match) return null;
        var percent = Number(match[1]);
        if (!isFinite(percent) || percent < 0 || percent > 100) return null;
        return percent / 100;
    }

    function ttmlPositionKeywordOffset(value, axis, extent) {
        value = String(value || '').toLowerCase();
        var remaining = 100 - extent;
        if (value === 'center') return remaining / 2;
        if (axis === 'h') {
            if (value === 'left') return 0;
            if (value === 'right') return remaining;
        } else {
            if (value === 'top') return 0;
            if (value === 'bottom') return remaining;
        }
        return null;
    }

    function ttmlPositionLengthOffset(value, axis, extent, context) {
        var factor = ttmlPositionPercentFactor(value);
        if (factor !== null) return factor * (100 - extent);
        return ttmlLengthToPercentage(value, axis, context);
    }

    function ttmlPositionEdgeOffset(edge, value, axis, extent, context) {
        var offset = ttmlPositionLengthOffset(value, axis, extent, context);
        if (offset === null) return null;
        edge = String(edge || '').toLowerCase();
        var remaining = 100 - extent;
        if ((axis === 'h' && edge === 'left') || (axis === 'v' && edge === 'top')) return offset;
        if ((axis === 'h' && edge === 'right') || (axis === 'v' && edge === 'bottom')) return remaining - offset;
        return null;
    }

    function ttmlPositionOrigin(value, extent, context) {
        if (!extent) return null;
        var width = extent[0];
        var height = extent[1];
        if (width <= 0 || height <= 0 || width > 100 || height > 100) return null;

        var tokens = String(value || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
        if (!tokens.length || tokens.length > 4) return null;
        var x;
        var y;
        var hKeyword = function (token) { return ttmlPositionKeywordOffset(token, 'h', width); };
        var vKeyword = function (token) { return ttmlPositionKeywordOffset(token, 'v', height); };
        var hLength = function (token) { return ttmlPositionLengthOffset(token, 'h', width, context); };
        var vLength = function (token) { return ttmlPositionLengthOffset(token, 'v', height, context); };

        if (tokens.length === 1) {
            var singleH = hLength(tokens[0]);
            if (singleH !== null) return [singleH, vKeyword('center')];
            if (tokens[0] === 'top' || tokens[0] === 'bottom') return [hKeyword('center'), vKeyword(tokens[0])];
            if (tokens[0] === 'center' || tokens[0] === 'left' || tokens[0] === 'right') return [hKeyword(tokens[0]), vKeyword('center')];
            return null;
        }

        if (tokens.length === 2) {
            var firstHLength = hLength(tokens[0]);
            var secondVLength = vLength(tokens[1]);
            if (firstHLength !== null && secondVLength !== null) return [firstHLength, secondVLength];

            if (tokens[0] === 'bottom' || tokens[0] === 'top') {
                y = vKeyword(tokens[0]);
                x = hKeyword(tokens[1]);
                return x === null || y === null ? null : [x, y];
            }

            x = hKeyword(tokens[0]);
            if (x !== null) {
                y = vKeyword(tokens[1]);
                if (y === null) y = vLength(tokens[1]);
                return y === null ? null : [x, y];
            }

            x = hLength(tokens[0]);
            y = vKeyword(tokens[1]);
            return x === null || y === null ? null : [x, y];
        }

        if (tokens.length === 3) {
            if (tokens[0] === 'left' || tokens[0] === 'right') {
                x = ttmlPositionEdgeOffset(tokens[0], tokens[1], 'h', width, context);
                y = vKeyword(tokens[2]);
                if (x !== null && y !== null) return [x, y];
            }
            if (tokens[0] === 'top' || tokens[0] === 'bottom') {
                y = ttmlPositionEdgeOffset(tokens[0], tokens[1], 'v', height, context);
                x = hKeyword(tokens[2]);
                if (x !== null && y !== null) return [x, y];
            }
            if (tokens[1] === 'left' || tokens[1] === 'right') {
                y = vKeyword(tokens[0]);
                x = ttmlPositionEdgeOffset(tokens[1], tokens[2], 'h', width, context);
                if (x !== null && y !== null) return [x, y];
            }
            if (tokens[1] === 'top' || tokens[1] === 'bottom') {
                x = hKeyword(tokens[0]);
                y = ttmlPositionEdgeOffset(tokens[1], tokens[2], 'v', height, context);
                if (x !== null && y !== null) return [x, y];
            }
            return null;
        }

        if ((tokens[0] === 'left' || tokens[0] === 'right') && (tokens[2] === 'top' || tokens[2] === 'bottom')) {
            x = ttmlPositionEdgeOffset(tokens[0], tokens[1], 'h', width, context);
            y = ttmlPositionEdgeOffset(tokens[2], tokens[3], 'v', height, context);
            return x === null || y === null ? null : [x, y];
        }
        if ((tokens[0] === 'top' || tokens[0] === 'bottom') && (tokens[2] === 'left' || tokens[2] === 'right')) {
            y = ttmlPositionEdgeOffset(tokens[0], tokens[1], 'v', height, context);
            x = ttmlPositionEdgeOffset(tokens[2], tokens[3], 'h', width, context);
            return x === null || y === null ? null : [x, y];
        }
        return null;
    }

    function ttmlContentPresentationValueAtTime(node, name, styleMap, timingContext, activeTime) {
        var chain = [];
        var current = node;
        while (current && current.nodeType === 1) {
            if (/^(?:body|div|p|span)$/.test(localName(current))) chain.push(current);
            current = current.parentNode;
        }
        var value = '';
        for (var i = chain.length - 1; i >= 0; i--) {
            var specified = ttmlSpecifiedPresentationStyle(chain[i], styleMap);
            ttmlMergePresentationStyle(specified, ttmlActiveSetStyle(chain[i], styleMap, timingContext, activeTime, [name]));
            if (specified[name]) value = specified[name];
        }
        return value;
    }

    function ttmlNodeLayoutPresentationStyleAtTime(node, styleMap, timingContext, activeTime) {
        var resolved = ttmlSpecifiedPresentationStyle(node, styleMap);
        ttmlMergePresentationStyle(resolved, ttmlActiveSetStyle(node, styleMap, timingContext, activeTime,
            ['fontSize', 'origin', 'extent', 'position', 'textAlign', 'displayAlign']));
        return resolved;
    }

    function ttmlSetAffectsCuePresentation(node, styleMap) {
        var specified = ttmlSpecifiedPresentationStyle(node, styleMap);
        return ['fontWeight', 'fontStyle', 'textDecoration', 'textCombine', 'textOrientation', 'fontSize',
            'origin', 'extent', 'position', 'textAlign', 'displayAlign', 'writingMode'].some(function (name) {
            return !!specified[name];
        });
    }

    function ttmlCueExternalTimedSets(node, doc, styleMap) {
        var result = [];
        var seen = [];
        function addDirectSets(container) {
            Array.prototype.slice.call(container && container.childNodes || []).forEach(function (child) {
                if (child.nodeType !== 1 || localName(child) !== 'set' || !ttmlSetAffectsCuePresentation(child, styleMap)) return;
                if (seen.indexOf(child) >= 0) return;
                seen.push(child);
                result.push(child);
            });
        }
        var current = node && node.parentNode;
        while (current && current.nodeType === 1) {
            if (/^(?:body|div|span)$/.test(localName(current))) addDirectSets(current);
            current = current.parentNode;
        }
        addDirectSets(ttmlCueRegion(node, doc));
        return result;
    }

    function ttmlCueTextAlign(node, regionStyle, styleMap, writingMode, timingContext, activeTime) {
        var value = ttmlContentPresentationValueAtTime(node, 'textAlign', styleMap, timingContext, activeTime) || regionStyle.textAlign || '';
        if (!value && ttmlWebVttVertical(writingMode)) value = 'start';
        return ttmlWebVttAlign(value, writingMode);
    }

    function ttmlWebVttVertical(writingMode) {
        writingMode = String(writingMode || '').toLowerCase();
        if (writingMode === 'tbrl' || writingMode === 'tb') return 'rl';
        if (writingMode === 'tblr') return 'lr';
        return '';
    }

    function ttmlWebVttAlign(value, writingMode) {
        value = String(value || '').toLowerCase();
        writingMode = String(writingMode || 'lrtb').toLowerCase();
        if (ttmlWebVttVertical(writingMode)) {
            if (/^(?:start|center|end|left|right)$/.test(value)) return value;
            return '';
        }
        if (/^(?:left|center|right)$/.test(value)) return value;
        if (value === 'start') return /^(?:rltb|rl)$/.test(writingMode) ? 'right' : 'left';
        if (value === 'end') return /^(?:rltb|rl)$/.test(writingMode) ? 'left' : 'right';
        return '';
    }

    function ttmlCueSettings(node, doc, timingContext, activeTime, styleMap) {
        styleMap = styleMap || ttmlStyleMap(doc);
        var region = ttmlCueRegion(node, doc);
        var regionStyle = region ? ttmlRegionPresentationStyleAtTime(region, styleMap, timingContext, activeTime) : {};
        var writingMode = String(regionStyle.writingMode || 'lrtb').toLowerCase();
        var horizontalWriting = /^(?:lrtb|rltb|lr|rl)$/.test(writingMode);
        var verticalWriting = ttmlWebVttVertical(writingMode);
        var supportedWriting = horizontalWriting || !!verticalWriting;
        var settings = [];
        if (verticalWriting) settings.push('vertical:' + verticalWriting);
        var align = supportedWriting ? ttmlCueTextAlign(node, regionStyle, styleMap, writingMode, timingContext, activeTime) : '';
        if (align) settings.push('align:' + align);
        if (!region || !supportedWriting) return settings.join(' ');

        var nodeStyle = ttmlNodeLayoutPresentationStyleAtTime(node, styleMap, timingContext, activeTime);
        var baseLayoutContext = ttmlLayoutContext(doc);
        var regionFontSize = ttmlRegionFontSize(regionStyle, doc, baseLayoutContext);
        var nodeFontSize = ttmlContentFontSize(node, doc, styleMap, regionFontSize, baseLayoutContext, 0, timingContext, activeTime);
        var regionLayoutContext = ttmlLayoutContext(doc, regionFontSize);
        var nodeLayoutContext = ttmlLayoutContext(doc, nodeFontSize);
        var extentFromNode = !!nodeStyle.extent;
        var positionFromNode = !!nodeStyle.position;
        var originFromNode = !!nodeStyle.origin;
        var extentValue = nodeStyle.extent || regionStyle.extent || '';
        var positionValue = nodeStyle.position || regionStyle.position || '';
        var originValue = nodeStyle.origin || regionStyle.origin || '';
        var extentContext = extentFromNode ? nodeLayoutContext : regionLayoutContext;
        var positionContext = positionFromNode ? nodeLayoutContext : regionLayoutContext;
        var originContext = originFromNode ? nodeLayoutContext : regionLayoutContext;
        var extent = ttmlLengthPairToPercentage(extentValue, extentContext);
        var origin = positionValue ? ttmlPositionOrigin(positionValue, extent, positionContext) : ttmlLengthPairToPercentage(originValue, originContext);
        if (!origin || !extent) return settings.join(' ');

        var x = origin[0];
        var y = origin[1];
        var width = extent[0];
        var height = extent[1];
        if (x < 0 || y < 0 || width <= 0 || height <= 0 || x > 100 || y > 100 || x + width > 100 || y + height > 100) {
            return settings.join(' ');
        }

        var displayAlign = String(nodeStyle.displayAlign || regionStyle.displayAlign || 'before').toLowerCase();
        var linePosition;
        var lineAlign;
        if (horizontalWriting) {
            if (displayAlign === 'before') {
                linePosition = y;
                lineAlign = 'start';
            } else if (displayAlign === 'center') {
                linePosition = y + height / 2;
                lineAlign = 'center';
            } else if (displayAlign === 'after') {
                linePosition = y + height;
                lineAlign = 'end';
            } else {
                return settings.join(' ');
            }

            settings.unshift('size:' + ttmlLayoutPercentage(width));
            settings.unshift('position:' + ttmlLayoutPercentage(x) + ',line-left');
            settings.unshift('line:' + ttmlLayoutPercentage(linePosition) + ',' + lineAlign);
            return settings.join(' ');
        }

        if (displayAlign === 'before') {
            linePosition = verticalWriting === 'rl' ? x + width : x;
            lineAlign = 'start';
        } else if (displayAlign === 'center') {
            linePosition = x + width / 2;
            lineAlign = 'center';
        } else if (displayAlign === 'after') {
            linePosition = verticalWriting === 'rl' ? x : x + width;
            lineAlign = 'end';
        } else {
            return settings.join(' ');
        }

        settings.push('line:' + ttmlLayoutPercentage(linePosition) + ',' + lineAlign);
        settings.push('position:' + ttmlLayoutPercentage(y) + ',line-left');
        settings.push('size:' + ttmlLayoutPercentage(height));
        return settings.join(' ');
    }

    function ttmlSpaceMode(node, inherited) {
        var value = String(ttmlAttribute(node, 'space') || '').toLowerCase();
        if (value === 'preserve' || value === 'default') return value;
        return inherited || 'default';
    }

    function ttmlParagraphCueIntervals(node, doc, timingContext) {
        var timing = ttmlResolveTiming(node, timingContext, 0);
        if (!timing || !isFinite(timing.begin) || !isFinite(timing.end) || timing.end <= timing.begin) return [];

        var boundaries = [timing.begin, timing.end];
        var styleMap = ttmlStyleMap(doc);
        var descendants = node.getElementsByTagName ? node.getElementsByTagName('*') : [];
        for (var i = 0; i < descendants.length; i++) {
            var descendant = descendants[i];
            if (!ttmlIsTimedElement(descendant)) continue;
            var descendantTiming = ttmlResolveTiming(descendant, timingContext, 0);
            if (!descendantTiming) return [];
            if (isFinite(descendantTiming.begin) && descendantTiming.begin > timing.begin && descendantTiming.begin < timing.end) {
                boundaries.push(descendantTiming.begin);
            }
            if (isFinite(descendantTiming.end) && descendantTiming.end > timing.begin && descendantTiming.end < timing.end) {
                boundaries.push(descendantTiming.end);
            }
            if (boundaries.length > MAX_TTML_CUE_BOUNDARIES) return [];
        }

        var externalSets = ttmlCueExternalTimedSets(node, doc, styleMap);
        for (var externalIndex = 0; externalIndex < externalSets.length; externalIndex++) {
            var externalTiming = ttmlResolveTiming(externalSets[externalIndex], timingContext, 0);
            if (!externalTiming) return [];
            if (isFinite(externalTiming.begin) && externalTiming.begin > timing.begin && externalTiming.begin < timing.end) boundaries.push(externalTiming.begin);
            if (isFinite(externalTiming.end) && externalTiming.end > timing.begin && externalTiming.end < timing.end) boundaries.push(externalTiming.end);
            if (boundaries.length > MAX_TTML_CUE_BOUNDARIES) return [];
        }

        boundaries.sort(function (a, b) { return a - b; });
        var unique = [];
        boundaries.forEach(function (value) {
            if (!unique.length || Math.abs(value - unique[unique.length - 1]) > 0.000001) unique.push(value);
        });

        var intervals = [];
        for (var j = 0; j + 1 < unique.length; j++) {
            var begin = unique[j];
            var end = unique[j + 1];
            if (!(end > begin)) continue;
            var sampleTime = begin + (end - begin) / 2;
            var cueText = ttmlCueText(node, doc, timingContext, sampleTime, styleMap);
            if (!cueText.replace(/\s/g, '')) continue;
            var settings = ttmlCueSettings(node, doc, timingContext, sampleTime, styleMap);

            var previous = intervals.length ? intervals[intervals.length - 1] : null;
            if (previous && previous.text === cueText && previous.settings === settings && Math.abs(previous.end - begin) <= 0.000001) {
                previous.end = end;
            } else {
                intervals.push({ begin: begin, end: end, text: cueText, settings: settings });
            }
        }
        return intervals;
    }

    function ttmlCueText(node, doc, timingContext, activeTime, styleMap) {
        var state = { text: '', pendingSpace: false };
        var context = {
            styleMap: styleMap || ttmlStyleMap(doc),
            timingContext: timingContext || null,
            activeTime: typeof activeTime === 'number' && isFinite(activeTime) ? activeTime : null
        };
        ttmlAppendCueText(node, ttmlInheritedSpaceMode(node), state, context);
        return state.text.replace(/\r\n|\r/g, '\n');
    }

    function ttmlInheritedSpaceMode(node) {
        var ancestors = [];
        var current = node;
        while (current && current.nodeType === 1) {
            ancestors.push(current);
            current = current.parentNode;
        }
        var mode = 'default';
        for (var i = ancestors.length - 1; i >= 0; i--) {
            mode = ttmlSpaceMode(ancestors[i], mode);
        }
        return mode;
    }

    function ttmlAppendCueText(node, inheritedSpace, state, context) {
        if (!node) return;
        if (node.nodeType === 1 && context && context.activeTime !== null && context.timingContext && ttmlIsTimedElement(node)) {
            var activeTiming = ttmlResolveTiming(node, context.timingContext, 0);
            if (!activeTiming || context.activeTime < activeTiming.begin || context.activeTime >= activeTiming.end) return;
        }
        var mode = inheritedSpace;
        if (node.nodeType === 1) {
            mode = ttmlSpaceMode(node, inheritedSpace);
            if (localName(node) === 'set') return;
            var presentation = ttmlComputedPresentationStyleAtTime(node, context.styleMap, context.timingContext, context.activeTime);
            if (presentation.ruby === 'container') {
                if (ttmlAppendRuby(node, mode, state, context)) return;
            }
            if (localName(node) === 'br') {
                state.pendingSpace = false;
                state.text += '\n';
                return;
            }
        }

        if (node.nodeType === 3 || node.nodeType === 4) {
            var parentStyle = ttmlComputedPresentationStyleAtTime(node.parentNode, context.styleMap, context.timingContext, context.activeTime);
            ttmlAppendTextValue(String(node.nodeValue || '').replace(/\r\n|\r/g, '\n'), mode, parentStyle, state);
            return;
        }

        var children = node.childNodes || [];
        for (var i = 0; i < children.length; i++) {
            ttmlAppendCueText(children[i], mode, state, context);
        }
    }

    function ttmlAppendTextValue(value, mode, style, state) {
        var output = '';
        if (mode === 'preserve') {
            if (state.pendingSpace && state.text && value && !/^\s/.test(value) && !/\s$/.test(state.text)) output += ' ';
            state.pendingSpace = false;
            output += value;
        } else {
            var normalized = String(value || '').replace(/\s+/g, ' ');
            if (!normalized) return;
            var leadingSpace = normalized.charAt(0) === ' ';
            var trailingSpace = normalized.charAt(normalized.length - 1) === ' ';
            var content = normalized.trim();
            if (leadingSpace && state.text) state.pendingSpace = true;
            if (content) {
                if (state.pendingSpace && state.text && !/\s$/.test(state.text)) output += ' ';
                state.pendingSpace = false;
                output += content;
            }
            if (trailingSpace && (state.text || output)) state.pendingSpace = true;
        }
        if (output) state.text += ttmlWrapVttText(ttmlEscapeVttText(output), style);
    }

    function ttmlEscapeVttText(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;');
    }

    function ttmlWrapVttText(value, style) {
        var open = '';
        var close = '';
        if (style && style.textCombine === 'all') {
            open += '<c.ttml-combine>';
            close = '</c>' + close;
        }
        if (style && style.bold) {
            open += '<b>';
            close = '</b>' + close;
        }
        if (style && style.italic) {
            open += '<i>';
            close = '</i>' + close;
        }
        if (style && style.underline) {
            open += '<u>';
            close = '</u>' + close;
        }
        return open + value + close;
    }

    function ttmlAppendRuby(node, mode, state, context) {
        var pairs = ttmlRubyPairs(node, context.styleMap);
        if (!pairs || !pairs.length) return false;
        state.pendingSpace = false;
        state.text += '<ruby>';
        pairs.forEach(function (pair) {
            state.text += ttmlRenderRubyPart(pair.base, mode, context);
            state.text += '<rt>' + ttmlRenderRubyPart(pair.text, mode, context) + '</rt>';
        });
        state.text += '</ruby>';
        return true;
    }

    function ttmlRubyPairs(container, styleMap) {
        var children = Array.prototype.slice.call(container.childNodes || []).filter(function (node) {
            return node.nodeType === 1;
        });
        var bases = [];
        var texts = [];
        children.forEach(function (child) {
            var ruby = ttmlComputedPresentationStyle(child, styleMap).ruby;
            if (ruby === 'base') bases.push(child);
            if (ruby === 'text') texts.push(child);
            if (ruby === 'baseContainer') {
                Array.prototype.slice.call(child.childNodes || []).forEach(function (nested) {
                    if (nested.nodeType === 1 && ttmlComputedPresentationStyle(nested, styleMap).ruby === 'base') bases.push(nested);
                });
            }
            if (ruby === 'textContainer') {
                Array.prototype.slice.call(child.childNodes || []).forEach(function (nested) {
                    if (nested.nodeType === 1 && ttmlComputedPresentationStyle(nested, styleMap).ruby === 'text') texts.push(nested);
                });
            }
        });
        if (!bases.length || bases.length !== texts.length) return null;
        return bases.map(function (base, index) {
            return { base: base, text: texts[index] };
        });
    }

    function ttmlRenderRubyPart(node, inheritedSpace, context) {
        var substate = { text: '', pendingSpace: false };
        var mode = ttmlSpaceMode(node, inheritedSpace);
        var children = node.childNodes || [];
        for (var i = 0; i < children.length; i++) {
            ttmlAppendCueText(children[i], mode, substate, context);
        }
        return substate.text;
    }

    function timestampSeconds(value) {
        var parts = String(value || '').replace(',', '.').split(':');
        if (parts.length === 3) {
            return (parseInt(parts[0], 10) || 0) * 3600 + (parseInt(parts[1], 10) || 0) * 60 + (parseFloat(parts[2]) || 0);
        }
        if (parts.length === 2) {
            return (parseInt(parts[0], 10) || 0) * 60 + (parseFloat(parts[1]) || 0);
        }
        return parseFloat(value) || 0;
    }

    function formatVttTime(seconds) {
        seconds = Math.max(0, Number(seconds) || 0);
        var hours = Math.floor(seconds / 3600);
        var minutes = Math.floor((seconds % 3600) / 60);
        var secs = Math.floor(seconds % 60);
        var ms = Math.round((seconds - Math.floor(seconds)) * 1000);
        if (ms === 1000) {
            ms = 0;
            secs++;
        }
        return pad2(hours) + ':' + pad2(minutes) + ':' + pad2(secs) + '.' + pad3(ms);
    }

    function pad2(value) {
        return value < 10 ? '0' + value : String(value);
    }

    function pad3(value) {
        if (value < 10) return '00' + value;
        if (value < 100) return '0' + value;
        return String(value);
    }

    function runSequential(items, iterator) {
        var index = 0;
        function next() {
            if (index >= items.length) return Promise.resolve();
            var item = items[index++];
            return Promise.resolve(iterator(item, index - 1)).then(next);
        }
        return next();
    }

    function shouldRetryHttpStatus(status) {
        status = Number(status);
        return status === 408 || status === 425 || status === 429 ||
            status === 500 || status === 502 || status === 503 || status === 504;
    }

    function retryAfterDelayMs(headers, nowMs) {
        var match = String(headers || '').match(/(?:^|\r?\n)\s*Retry-After\s*:\s*([^\r\n]+)/i);
        if (!match) return null;
        var value = match[1].trim();
        if (/^\d+$/.test(value)) {
            var seconds = Number(value);
            var delay = seconds * 1000;
            return isFinite(delay) ? delay : null;
        }
        var when = Date.parse(value);
        if (!isFinite(when)) return null;
        var now = nowMs == null ? Date.now() : Number(nowMs);
        if (!isFinite(now)) now = Date.now();
        return Math.max(0, when - now);
    }

    function retryDelayMs(retryCount, responseHeaders, nowMs) {
        var retryAfter = retryAfterDelayMs(responseHeaders, nowMs);
        if (retryAfter != null) {
            return retryAfter <= RETRY_MAX_DELAY_MS ? retryAfter : null;
        }
        var attempt = Math.max(0, Number(retryCount) || 0);
        return Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * Math.pow(2, attempt));
    }

    function scheduleRetry(retryCount, responseHeaders, retry, resolve, reject) {
        var retryAfter = retryAfterDelayMs(responseHeaders);
        if (retryAfter != null && (retryCount >= MAX_RETRIES || retryAfter > RETRY_MAX_DELAY_MS)) {
            var error = new Error('Server requested retry after ' + Math.ceil(retryAfter / 1000) + 's');
            error.retryAfterMs = retryAfter;
            reject(error);
            return true;
        }
        if (retryCount >= MAX_RETRIES) return false;
        var delay = retryDelayMs(retryCount, responseHeaders);
        if (delay == null) return false;
        setTimeout(function () {
            retry().then(resolve, reject);
        }, delay);
        return true;
    }

    function getText(url, retryCount, headers) {
        retryCount = retryCount || 0;
        return new Promise(function (resolve, reject) {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                headers: headers || undefined,
                responseType: 'text',
                onload: function (response) {
                    if (response.status >= 200 && response.status < 300) {
                        resolve(response.responseText || '');
                        return;
                    }
                    if (shouldRetryHttpStatus(response.status) && scheduleRetry(retryCount, response.responseHeaders, function () {
                        return getText(url, retryCount + 1, headers);
                    }, resolve, reject)) return;
                    reject(new Error('HTTP ' + response.status + ' for ' + url));
                },
                onerror: function () {
                    if (scheduleRetry(retryCount, '', function () {
                        return getText(url, retryCount + 1, headers);
                    }, resolve, reject)) return;
                    reject(new Error('Network error for ' + url));
                },
                ontimeout: function () {
                    if (scheduleRetry(retryCount, '', function () {
                        return getText(url, retryCount + 1, headers);
                    }, resolve, reject)) return;
                    reject(new Error('Timeout for ' + url));
                }
            });
        });
    }

    function resetTracks() {
        captureCoupang('playback.reset', state.playbackSessionId, function () {
            return { previousTrackCount: state.tracks.length, previousMetadata: fixtureMetadataState() };
        });
        state.tracks = [];
        state.trackKeys = {};
        state.seenResourceUrls = {};
        state.seenManifestUrls = {};
        state.playbackScanStartedAt = state.playbackSessionStartedAt || performanceNow();
        state.selectedTrackKey = '';
        state.userSelectedTrack = false;
        state.mediaTitle = '';
        state.mediaTitlePriority = 0;
        state.episodeTag = '';
        state.episodeTitle = '';
        state.seasonNumber = null;
        state.episodeNumber = null;
        state.episodeConfirmed = false;
        state.metadataRequestKey = '';
        state.metadataResolvedKey = '';
        state.metadataFailedKey = '';
        state.metadataPromise = null;
        state.lastError = '';
        state.status = 'Scanning playback...';
        state.outputFilename = '';
        state.progressCompleted = 0;
        state.progressTotal = 0;
        state.progressLabel = 'Idle';
    }

    function refreshMediaMetadataFromDom() {
        mergeMediaMetadata(mediaMetadataFromDom(), 1);
        scheduleDiscoverMetadata();
    }

    function ensureMediaMetadata() {
        var sessionId = state.playbackSessionId;
        refreshMediaMetadataFromDom();
        var identifiers = playbackIdentifiers();
        if (isEpisodePlayback(identifiers) && !state.episodeConfirmed && state.metadataFailedKey) {
            state.metadataFailedKey = '';
            scheduleDiscoverMetadata();
        }
        return (state.metadataPromise || Promise.resolve()).then(function () {
            if (!isPlaybackSessionCurrent(sessionId)) throw new Error('Playback changed while reading metadata.');
            mergeMediaMetadata(mediaMetadataFromDom(), 1);
        });
    }

    function mediaMetadataFromDom() {
        var bodyText = document.body ? document.body.innerText : '';
        var title = displayTitle();
        var fromTitle = episodeMetadataFromTitle(title);
        var fromText = episodeMetadataFromText(bodyText);
        var seasonNumber = fromTitle.seasonNumber || fromText.seasonNumber || null;
        var episodeNumber = fromTitle.episodeNumber || fromText.episodeNumber || null;
        return {
            title: fromTitle.title || fromText.title || title,
            episodeTitle: fromTitle.episodeTitle || fromText.episodeTitle || '',
            seasonNumber: seasonNumber,
            episodeNumber: episodeNumber,
            episodeTag: formatSeasonEpisodeTag(seasonNumber, episodeNumber),
            episodeConfirmed: false
        };
    }

    function mergeMediaMetadata(metadata, priority) {
        if (!metadata) return;
        var fixtureBefore = fixtureCaptureRecording && fixtureCapture ? JSON.stringify(fixtureMetadataState()) : '';
        priority = priority || 1;
        if (metadata.title && priority >= state.mediaTitlePriority) {
            state.mediaTitle = cleanDisplayTitle(metadata.title);
            state.mediaTitlePriority = priority;
        }
        if (metadata.episodeConfirmed) {
            if (metadata.episodeTitle) state.episodeTitle = cleanDisplayTitle(metadata.episodeTitle);
            if (metadata.seasonNumber) state.seasonNumber = metadata.seasonNumber;
            if (metadata.episodeNumber) state.episodeNumber = metadata.episodeNumber;
            state.episodeConfirmed = !!formatSeasonEpisodeTag(state.seasonNumber, state.episodeNumber);
            state.episodeTag = state.episodeConfirmed ? formatSeasonEpisodeTag(state.seasonNumber, state.episodeNumber) : '';
        }
        if (fixtureBefore) {
            var fixtureAfter = fixtureMetadataState();
            if (JSON.stringify(fixtureAfter) !== fixtureBefore) {
                captureCoupang('metadata.accepted', state.playbackSessionId, function () {
                    return { priority: priority, before: JSON.parse(fixtureBefore), after: fixtureAfter };
                });
                captureCoupangSnapshot('metadata', state.playbackSessionId, function () { return fixtureAfter; });
            }
        }
    }

    function scheduleDiscoverMetadata() {
        var identifiers = playbackIdentifiers();
        if (!identifiers.titleId) return null;

        var sessionId = state.playbackSessionId;
        var requestKey = [identifiers.titleId, identifiers.parentId].join('|');
        if (state.metadataResolvedKey === requestKey || state.metadataFailedKey === requestKey) return state.metadataPromise;
        if (state.metadataRequestKey === requestKey && state.metadataPromise) return state.metadataPromise;

        state.metadataRequestKey = requestKey;
        captureCoupang('metadata.discovery-started', sessionId, function () {
            return {
                episodePlayback: isEpisodePlayback(identifiers),
                hasParentId: !!identifiers.parentId
            };
        });
        var promise = fetchDiscoverMetadata(identifiers).then(function (metadata) {
            if (!isPlaybackSessionCurrent(sessionId)) return metadata;
            mergeMediaMetadata(metadata, 2);
            state.metadataResolvedKey = requestKey;
            captureCoupang('metadata.discovery-finished', sessionId, function () {
                return { metadata: fixtureMetadataState() };
            });
            updateUi();
            return metadata;
        }).catch(function (err) {
            if (isPlaybackSessionCurrent(sessionId)) {
                state.metadataFailedKey = requestKey;
                captureCoupang('metadata.discovery-failed', sessionId, function () {
                    return { errorCode: fixtureErrorCode(err) };
                });
                debuglog('Discover metadata failed: ' + err.message);
            }
        }).then(function (metadata) {
            if (state.metadataPromise === promise) state.metadataPromise = null;
            return metadata;
        });
        state.metadataPromise = promise;
        return promise;
    }

    function fetchDiscoverMetadata(identifiers) {
        var metadata = {};
        return loadTitleMetadata(identifiers, metadata)
            .then(function () {
                if (!isEpisodePlayback(identifiers)) return Promise.resolve();
                return loadEpisodeLocationMetadata(identifiers, metadata);
            })
            .then(function () {
                if (!isEpisodePlayback(identifiers)) return Promise.resolve();
                return loadEpisodeListMetadata(identifiers, metadata);
            })
            .then(function () {
                return metadata;
            });
    }

    function loadTitleMetadata(identifiers, metadata) {
        if (!identifiers.titleId) return Promise.resolve();

        if (!isEpisodePlayback(identifiers)) {
            return getJson(discoverTitleUrl(identifiers.titleId)).then(function (json) {
                var data = json && json.data;
                if (data && data.title) metadata.title = cleanDisplayTitle(data.title);
            }).catch(function (err) {
                debuglog('Title metadata failed: ' + err.message);
            });
        }

        return getJson(discoverTitleUrl(identifiers.titleId)).then(function (json) {
            mergeEpisodeDetailMetadata(json && json.data, identifiers, metadata);
        }).catch(function (err) {
            debuglog('Episode title metadata failed: ' + err.message);
        }).then(function () {
            if (!identifiers.parentId) return;
            return getJson(discoverTitleUrl(identifiers.parentId)).then(function (json) {
                var data = json && json.data;
                if (data && data.title) metadata.title = cleanDisplayTitle(data.title);
            }).catch(function (err) {
                debuglog('Parent title metadata failed: ' + err.message);
            });
        });
    }

    function mergeEpisodeDetailMetadata(data, identifiers, metadata) {
        if (!data || typeof data !== 'object') return;

        var parentId = data.parent_id || data.parentId || '';
        if (parentId) identifiers.parentId = String(parentId);

        var season = parseOptionalNumber(data.season);
        var episodeNumber = parseOptionalNumber(data.episode);
        var rawTitle = cleanDisplayTitle(data.title || data.title_canonical || '');
        var parsedTitle = episodeMetadataFromTitle(rawTitle);

        if (season) metadata.seasonNumber = season;
        if (episodeNumber) metadata.episodeNumber = episodeNumber;
        if (!metadata.episodeNumber && parsedTitle.episodeNumber) metadata.episodeNumber = parsedTitle.episodeNumber;
        if (parsedTitle.episodeTitle) {
            metadata.episodeTitle = parsedTitle.episodeTitle;
        } else if (rawTitle) {
            metadata.episodeTitle = rawTitle;
        }
        metadata.episodeConfirmed = !!formatSeasonEpisodeTag(metadata.seasonNumber, metadata.episodeNumber);
    }

    function isEpisodePlayback(identifiers) {
        return identifiers && (identifiers.type === 'episode' || !!identifiers.parentId);
    }

    function loadEpisodeLocationMetadata(identifiers, metadata) {
        if (!identifiers.titleId) return Promise.resolve();
        return getJson(discoverEpisodeLocationUrl(identifiers.titleId)).then(function (json) {
            var targetSeason = json && json.data && json.data.location && json.data.location.targetSeason;
            var season = targetSeason && parseOptionalNumber(targetSeason.season);
            if (season) metadata.seasonNumber = season;
        }).catch(function (err) {
            debuglog('Episode location metadata failed: ' + err.message);
        });
    }

    function loadEpisodeListMetadata(identifiers, metadata) {
        if (!identifiers.parentId || !identifiers.titleId) return Promise.resolve();

        var urls = [];
        if (metadata.seasonNumber) urls.push(discoverEpisodesUrl(identifiers.parentId, metadata.seasonNumber));
        urls.push(discoverEpisodesUrl(identifiers.parentId, null));

        return runSequential(urls, function (url) {
            if (metadata.episodeNumber && metadata.seasonNumber && metadata.episodeTitle) return Promise.resolve();
            return getJson(url).then(function (json) {
                var episode = findEpisodeObject(json, identifiers.titleId);
                if (!episode) return;
                mergeEpisodeObjectMetadata(episode, metadata);
            }).catch(function (err) {
                debuglog('Episode list metadata failed: ' + err.message);
            });
        });
    }

    function mergeEpisodeObjectMetadata(episode, metadata) {
        if (!episode || typeof episode !== 'object') return;
        var season = parseOptionalNumber(episode.season);
        var episodeNumber = parseOptionalNumber(episode.episode);
        var parsedTitle = episodeMetadataFromTitle(episode.title || episode.title_canonical || '');
        if (season) metadata.seasonNumber = season;
        if (episodeNumber) metadata.episodeNumber = episodeNumber;
        if (parsedTitle.episodeNumber && !metadata.episodeNumber) metadata.episodeNumber = parsedTitle.episodeNumber;
        if (parsedTitle.episodeTitle) metadata.episodeTitle = parsedTitle.episodeTitle;
        metadata.episodeConfirmed = !!formatSeasonEpisodeTag(metadata.seasonNumber, metadata.episodeNumber);
    }

    function findEpisodeObject(value, episodeId) {
        if (!value || !episodeId) return null;
        if (Array.isArray(value)) {
            for (var i = 0; i < value.length; i++) {
                var found = findEpisodeObject(value[i], episodeId);
                if (found) return found;
            }
            return null;
        }
        if (typeof value !== 'object') return null;
        if (String(value.id || value.asset_id || '') === episodeId) return value;
        var keys = Object.keys(value);
        for (var j = 0; j < keys.length; j++) {
            var child = value[keys[j]];
            if (child && typeof child === 'object') {
                var nested = findEpisodeObject(child, episodeId);
                if (nested) return nested;
            }
        }
        return null;
    }

    function getJson(url) {
        var sessionId = state.playbackSessionId;
        return getText(url, 0, {
            'accept': 'application/json,text/plain,*/*',
            'x-platform': 'WEBCLIENT'
        }).then(function (text) {
            var projection = fixtureMetadataProjection(text);
            var artifact = projection ? captureCoupangArtifact('metadata-structure', projection, function () {
                return { format: 'json', url: url };
            }) : null;
            captureCoupang('metadata.request-completed', sessionId, function () {
                return { url: url, artifact: artifact || '' };
            });
            return JSON.parse(text || '{}');
        });
    }

    function discoverTitleUrl(titleId) {
        return 'https://www.coupangplay.com/api-discover/v1/discover/titles/' + encodeURIComponent(titleId) +
            '?platform=WEBCLIENT&locale=ko&filterRestrictedContent=false';
    }

    function discoverEpisodeLocationUrl(episodeId) {
        return 'https://www.coupangplay.com/api-discover/v1/discover/titles/episodes/' + encodeURIComponent(episodeId) +
            '/location?episodeId=' + encodeURIComponent(episodeId) + '&locale=ko&platform=WEBCLIENT';
    }

    function discoverEpisodesUrl(parentId, seasonNumber) {
        var query = 'titleId=' + encodeURIComponent(parentId) +
            '&locale=ko&perPage=100&page=1&includeChannelContents=true&platform=WEBCLIENT&sort=true';
        if (seasonNumber) query += '&seasonRange=' + encodeURIComponent(seasonNumber + '~' + seasonNumber);
        return 'https://www.coupangplay.com/api-discover/v2/discover/titles/' + encodeURIComponent(parentId) + '/episodes?' + query;
    }

    function playbackIdentifiers() {
        var params = new URLSearchParams(location.search || '');
        var pathMatch = location.pathname.match(/\/play\/([^/]+)\/([^/?#]+)/i);
        return {
            titleId: params.get('titleId') || (pathMatch ? pathMatch[1] : ''),
            parentId: params.get('parentId') || '',
            type: (params.get('type') || (pathMatch ? pathMatch[2] : '')).toLowerCase()
        };
    }

    function episodeMetadataFromText(text) {
        var metadata = seasonEpisodeNumbers(text);
        var lines = String(text || '').split(/\n+/);
        for (var i = 0; i < lines.length; i++) {
            if (!isUsableMetadataLine(lines[i])) continue;
            var parsed = episodeMetadataFromTitle(lines[i]);
            if (parsed.title || parsed.episodeTitle || parsed.episodeNumber) {
                return {
                    title: parsed.title,
                    episodeTitle: parsed.episodeTitle,
                    seasonNumber: parsed.seasonNumber || metadata.seasonNumber,
                    episodeNumber: parsed.episodeNumber || metadata.episodeNumber
                };
            }
        }
        return metadata;
    }

    function episodeMetadataFromTitle(title) {
        var text = cleanDisplayTitle(title);
        var match;
        if (!text) return {};
        if (!isUsableMetadataLine(text)) return {};

        match = text.match(/^(.+?)\s+S(?:eason)?\s*(\d{1,3})\s*E(?:pisode)?\s*(\d{1,3})\s*[-:.)]?\s*(.*)$/i) ||
            text.match(/^(.+?)\s+\bS(\d{1,3})E(\d{1,3})\b\s*[-:.)]?\s*(.*)$/i);
        if (match) {
            return {
                title: cleanDisplayTitle(match[1]),
                seasonNumber: parseOptionalNumber(match[2]),
                episodeNumber: parseOptionalNumber(match[3]),
                episodeTitle: cleanDisplayTitle(match[4])
            };
        }

        match = text.match(/^(.+?)\s*[:：]\s*(?:시즌\s*(\d{1,3})\s*)?(\d{1,3})\s*[.\-_:)]\s*(.+)$/i);
        if (match) {
            return {
                title: cleanDisplayTitle(match[1]),
                seasonNumber: parseOptionalNumber(match[2]),
                episodeNumber: parseOptionalNumber(match[3]),
                episodeTitle: cleanDisplayTitle(match[4])
            };
        }

        match = text.match(/^(\d{1,3})\s*[.\-_:)]\s*(.+)$/i);
        if (match) {
            return {
                episodeNumber: parseOptionalNumber(match[1]),
                episodeTitle: cleanDisplayTitle(match[2])
            };
        }

        return {};
    }

    function displayTitle() {
        var candidates = [];
        var selectors = [
            '[class*="title" i]',
            '[data-testid*="title" i]',
            'h1',
            'h2'
        ];
        selectors.forEach(function (selector) {
            Array.prototype.forEach.call(document.querySelectorAll(selector), function (node) {
                var text = cleanDisplayTitle(node.innerText || node.textContent || '');
                if (isUsableTitle(text)) candidates.push(text);
            });
        });

        if (document.body) {
            document.body.innerText.split(/\n+/).forEach(function (line) {
                var text = cleanDisplayTitle(line);
                if (isUsableTitle(text)) candidates.push(text);
            });
        }

        return candidates[0] || titleFromUrl() || 'CoupangPlay';
    }

    function isUsableTitle(text) {
        if (!text || text.length < 2 || text.length > 80) return false;
        if (/쿠팡플레이|coupang play subtitle downloader|subtitle downloader|콘텐츠 제공사|등급분류번호|시청할 수 있습니다|자막|음성|현재 시간|다음화|이전화|duration|loaded|stream type/i.test(text)) return false;
        if (isPlaybackTimeText(text)) return false;
        return true;
    }

    function isUsableMetadataLine(text) {
        text = cleanDisplayTitle(text);
        if (!text || text.length > 100) return false;
        if (isPlaybackTimeText(text)) return false;
        if (/콘텐츠 제공사|등급분류번호|시청할 수 있습니다|자막|음성|현재 시간|duration|loaded|stream type/i.test(text)) return false;
        return true;
    }

    function isPlaybackTimeText(text) {
        return /^\d{1,2}:\d{2}(?::\d{2})?\s*\/\s*\d{1,2}:\d{2}(?::\d{2})?/.test(cleanDisplayTitle(text));
    }

    function titleFromUrl() {
        var match = location.pathname.match(/\/play\/([^/]+)/i);
        return match ? match[1] : '';
    }

    function cleanDisplayTitle(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function seasonEpisodeTag(text) {
        var numbers = seasonEpisodeNumbers(text);
        return formatSeasonEpisodeTag(numbers.seasonNumber, numbers.episodeNumber);
    }

    function seasonEpisodeNumbers(text) {
        text = String(text || '');
        var match = text.match(/시즌\s*(\d{1,3}).{0,20}?(\d{1,3})\s*(?:화|회|episode|에피소드)/i) ||
            text.match(/S(?:eason)?\s*(\d{1,3}).{0,20}?E(?:pisode)?\s*(\d{1,3})/i) ||
            text.match(/\bS(\d{1,3})E(\d{1,3})\b/i);
        if (match) {
            return {
                seasonNumber: parseOptionalNumber(match[1]),
                episodeNumber: parseOptionalNumber(match[2])
            };
        }

        match = text.match(/(?:에피소드|episode)\s*(\d{1,3})/i) ||
            text.match(/(\d{1,3})\s*(?:화|회)\b/i);
        return {
            seasonNumber: null,
            episodeNumber: match ? parseOptionalNumber(match[1]) : null
        };
    }

    function formatSeasonEpisodeTag(seasonNumber, episodeNumber) {
        seasonNumber = parseOptionalNumber(seasonNumber);
        episodeNumber = parseOptionalNumber(episodeNumber);
        if (seasonNumber && episodeNumber) return 'S' + pad2(seasonNumber) + 'E' + pad2(episodeNumber);
        if (episodeNumber) return 'E' + pad2(episodeNumber);
        return '';
    }

    function parseOptionalNumber(value) {
        var number = parseInt(value, 10);
        return Number.isFinite(number) && number > 0 ? number : null;
    }

    function safeBaseFilename() {
        var metadata = mediaMetadataFromDom();
        mergeMediaMetadata(metadata, 1);
        var title = state.mediaTitle || metadata.title || displayTitle();
        var episode = state.episodeConfirmed ? formatSeasonEpisodeTag(state.seasonNumber, state.episodeNumber) : '';
        var episodeTitle = state.episodeConfirmed ? state.episodeTitle : '';
        var filename = sanitizeFilename(uniqueFilenameParts([title, episode, episodeTitle]).join('.')) || 'CoupangPlay.Subtitle';
        captureCoupangSnapshot('filename.preview', state.playbackSessionId, function () {
            return { filename: filename, metadata: fixtureMetadataState() };
        });
        return filename;
    }

    function uniqueFilenameParts(parts) {
        var seen = {};
        var output = [];
        parts.forEach(function (part) {
            part = cleanDisplayTitle(part);
            if (!part) return;
            var key = part.toLowerCase();
            if (seen[key]) return;
            seen[key] = true;
            output.push(part);
        });
        return output;
    }

    function safeTrackName(track) {
        var language = trackLanguage(track) || 'subtitle';
        var parts = [language];
        if (isForcedTrack(track)) parts.push('forced');
        if (isCcTrack(track)) parts.push('cc');
        var label = normalizeTrackLabel(track.NAME);
        if (label && label !== language) parts.push(label);
        return sanitizeFilename(parts.join('.'));
    }

    function sanitizeFilename(value) {
        return String(value || '')
            .replace(/[\\/:*?"<>|]+/g, '_')
            .replace(/\s+/g, ' ')
            .replace(/^\.+|\.+$/g, '')
            .trim()
            .slice(0, 180);
    }

    function normalizeUrl(url) {
        if (!url) return '';
        try {
            return new URL(String(url), location.href).href;
        } catch (err) {
            return String(url || '');
        }
    }

    function absoluteUrl(url, baseUrl) {
        if (!url) return '';
        try {
            return new URL(url, baseUrl || location.href).href;
        } catch (err) {
            return url;
        }
    }

    function debuglog(message) {
        if (!debug) return;
        try { console.log(LOG_PREFIX + ' ' + message); } catch (err) {}
    }
})();
