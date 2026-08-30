// ==UserScript==
// @name       Apple TV+ Subtitles Downloader
// @namespace  https://github.com/wonmin82/streaming-subtitle-downloaders
// @description Download subtitles from Apple TV+
// @version    1.0.23
// @author     Wonmin Jung
// @license    MIT
// @homepageURL https://github.com/wonmin82/streaming-subtitle-downloaders
// @downloadURL https://raw.githubusercontent.com/wonmin82/streaming-subtitle-downloaders/main/scripts/apple-tv-plus-subtitles-downloader.user.js
// @updateURL  https://raw.githubusercontent.com/wonmin82/streaming-subtitle-downloaders/main/scripts/apple-tv-plus-subtitles-downloader.user.js
// @match      https://tv.apple.com/*
// @match      https://*.tv.apple.com/*
// @match      https://*.itunes.apple.com/*
// @grant      GM_info
// @grant      GM_registerMenuCommand
// @grant      GM_unregisterMenuCommand
// @grant      GM_xmlhttpRequest
// @grant      unsafeWindow
// @connect    *.apple.com
// @connect    *.apple.co
// @connect    *.itunes.apple.com
// @connect    *.mzstatic.com
// @connect    *.aaplimg.com
// @connect    *.cdn-apple.com
// @connect    *.apple-dns.net
// @connect    *
// @require    https://cdn.jsdelivr.net/npm/jszip@3.7.1/dist/jszip.min.js
// @require    https://cdn.jsdelivr.net/npm/file-saver@2.0.5/dist/FileSaver.min.js
// @run-at     document-start
// ==/UserScript==

(function () {
    'use strict';

    var debug = location.hash === '#debug' || location.hash.indexOf('atvsd_debug') >= 0;
    var MAX_RETRIES = 5;
    var RETRY_BASE_DELAY_MS = 250;
    var RETRY_MAX_DELAY_MS = 4000;
    var LOG_PREFIX = '[Apple TV+ Subtitles DL]';
    var targetWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    var MESSAGE_TYPE_TRACK = 'atvsd-subtitle-track';
    var MESSAGE_TYPE_SESSION = 'atvsd-playback-session';
    var MESSAGE_TYPE_SESSION_REQUEST = 'atvsd-playback-session-request';
    var MAX_SESSION_CLIENTS = 32;
    var MAX_MESSAGE_TRACK_SEGMENTS = 10000;
    var FIXTURE_CAPTURE_ARM_KEY = 'ssd:fixture-capture:apple:armed-until';
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
        sessionClients: [],
        pendingSessionObservations: [],
        pendingSessionObservationBytes: 0,
        replayingSessionObservations: false,
        downloadOperationSequence: 0,
        activeDownloadOperationId: 0,
        langs: [],
        langKeys: {},
        seenManifestUrls: {},
        seenResourceUrls: {},
        manifestMeta: {},
        playbackScanStartedAt: 0,
        playbackActive: false,
        lastPerformanceScanAt: 0,
        performanceEntryCount: 0,
        lastDeepPlaybackScanAt: 0,
        lastDeepPlaybackResult: false,
        selectedTrackKey: '',
        userSelectedTrack: false,
        mediaTitle: '',
        mediaTitlePriority: 0,
        seasonNumber: null,
        episodeNumber: null,
        episodeTag: '',
        wait: false,
        status: 'Start playback, then wait for tracks...',
        lastError: '',
        outputFilename: '',
        progressCompleted: 0,
        progressTotal: 0,
        progressLabel: 'Idle',
        progressUiTimer: null,
        lastProgressUiAt: 0,
        downloadall: false,
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
                if (inNote) return '';
                if (/^NOTE(?:\s|$)/i.test(trimmed)) {
                    inNote = true;
                    textSequence++;
                    if (data) data.sanitization.redactions++;
                    return 'NOTE TEXT_' + textSequence;
                }
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
        service: 'apple',
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
        } else if (!state.observer) {
            setInterval(function () {
                if (isAppleTvPage()) scanPerformanceEntries();
            }, 5000);
        }
        debuglog('Script loaded');
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
            tracks: state.langs.map(fixtureTrackSummary)
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
            saveAs(blob, 'apple-' + timestamp + '.fixture.local.json');
            printFixtureCaptureStatus();
        } catch (err) {
            debuglog('Fixture export failed.');
        }
    }

    function printFixtureCaptureStatus() {
        if (!fixtureCapture) return;
        try { console.info(LOG_PREFIX + ' Fixture capture status', fixtureCapture.status()); } catch (err) {}
    }

    function captureApple(type, sessionId, payloadFactory) {
        if (!fixtureCaptureRecording || !fixtureCapture) return false;
        try {
            var payload = typeof payloadFactory === 'function' ? payloadFactory() : (payloadFactory || {});
            return fixtureCapture.event(type, payload, { session: sessionId || '' });
        } catch (err) {
            return false;
        }
    }

    function captureAppleArtifact(kind, text, metadataFactory) {
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

    function captureAppleSnapshot(kind, sessionId, payloadFactory) {
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
            cc: /sdh|caption|transcribes-spoken-dialog/i.test(String(track.CHARACTERISTICS || '') + ' ' + String(track.NAME || '')),
            source: track.source || '',
            uri: track.URI || '',
            activePlayback: !!track.activePlayback,
            segmentCount: track.segments && track.segments.length ? track.segments.length : 0
        };
    }

    function fixtureResourceKind(url) {
        url = String(url || '');
        if (/\.m3u8(?:[?#]|$)/i.test(url)) return 'manifest';
        if (/\.(?:vtt|webvtt)(?:[?#]|$)/i.test(url)) return 'subtitle';
        if (/\.(?:mp4|mp4a|m4s|bif)(?:[?#]|$)/i.test(url)) return 'media';
        if (/(?:\/api\/|metadata|playback|contents|shelves|canvases|account|fpsrequest)/i.test(url)) return 'metadata';
        return 'other';
    }

    function fixtureMetadataState() {
        var mediaKind = state.episodeTag || (state.seasonNumber && state.episodeNumber) ? 'episode' : (state.mediaTitle ? 'movie' : 'unknown');
        return {
            title: state.mediaTitle || '',
            seasonNumber: state.seasonNumber,
            episodeNumber: state.episodeNumber,
            episodeTag: state.episodeTag || '',
            mediaKind: mediaKind,
            ready: !!state.mediaTitle,
            priority: state.mediaTitlePriority || 0
        };
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
            if (/(?:^|_)(?:id|(?:movie|content|playable|episode|asset|account|profile|subscriber|customer|user|viewer|device)_?id)(?:$|_)/.test(normalized)) return 'TOKEN_001';
            var episodeTag = value ? seasonEpisodeTag(value) : '';
            if (episodeTag) return episodeTag;
            if (/(?:^|_)(?:content|media|program|entity)_?type(?:$|_)/.test(normalized) &&
                /^(?:movie|film|feature|episode)$/i.test(value)) return String(value).toLowerCase();
            if (/(?:season|episode)/.test(normalizedPath) && /^\d{1,3}$/.test(value)) return value;
            if (/(?:^|_)(?:language|locale)(?:$|_)/.test(normalized) && /^[A-Za-z]{2,3}(?:[-_][A-Za-z]{2})?$/.test(value)) return value;
            if (/(?:series|show|program|collection|franchise)/.test(normalizedPath) && /(?:title|name)/.test(normalized)) return 'SHOW_001';
            stringSequence++;
            return 'STRING_' + stringSequence;
        }

        function project(value, key, path, depth) {
            if (value == null || typeof value === 'boolean') return value;
            if (typeof value === 'string') return placeholderString(value, key, path);
            var normalizedPath = normalizedKey(path || key);
            if (typeof value === 'number') {
                return /(?:season|episode)/.test(normalizedPath) && /(?:number|sequence|seq|index|position)/.test(normalizedKey(key)) &&
                    isFinite(value) && value > 0 && value < 1000 ? value : 0;
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

    function fixtureManifestProjection(url, text) {
        var empty = { text: '', relevant: false, projected: false, originalLineCount: 0, projectedLineCount: 0 };
        if (!fixtureCaptureRecording || typeof text !== 'string' || text.indexOf('#EXTM3U') < 0) return empty;

        var lines = text.split(/\r\n|\r|\n/);
        var subtitleMediaLines = lines.filter(function (line) {
            return /^#EXT-X-MEDIA:/i.test(line.trim()) && /TYPE=(SUBTITLES|CLOSED-CAPTIONS)/i.test(line);
        });
        var subtitlePlaylist = looksLikeSubtitlePlaylist(url, text);
        if (!subtitleMediaLines.length && !subtitlePlaylist) {
            empty.originalLineCount = lines.length;
            return empty;
        }

        var projectedLines;
        if (subtitleMediaLines.length) {
            projectedLines = lines.filter(function (line) {
                var trimmed = line.trim();
                return /^#EXTM3U$/i.test(trimmed) ||
                    /^#EXT-X-(?:VERSION|INDEPENDENT-SEGMENTS|DEFINE):/i.test(trimmed) ||
                    (/^#EXT-X-MEDIA:/i.test(trimmed) && /TYPE=(SUBTITLES|CLOSED-CAPTIONS)/i.test(trimmed));
            });
        } else if (lines.length > 500) {
            projectedLines = lines.slice(0, 350);
            projectedLines.push('# SSD_FIXTURE_PROJECTION_OMITTED=' + (lines.length - 500));
            projectedLines = projectedLines.concat(lines.slice(-150));
        } else {
            projectedLines = lines.slice();
        }

        var projectedText = projectedLines.join('\n');
        if (projectedText.length > 750000) {
            projectedLines = projectedLines.slice(0, 250).concat([
                '# SSD_FIXTURE_PROJECTION_SIZE_LIMIT'
            ], projectedLines.slice(-100));
            projectedText = projectedLines.join('\n');
        }

        return {
            text: projectedText,
            relevant: true,
            projected: projectedText !== text,
            originalLineCount: lines.length,
            projectedLineCount: projectedLines.length
        };
    }

    function fixtureErrorCode(error) {
        var value = String(error && error.message ? error.message : (error || ''));
        if (!value) return '';
        if (/stale|playback changed/i.test(value)) return 'stale-session';
        if (/timeout/i.test(value)) return 'timeout';
        if (/network/i.test(value)) return 'network';
        if (/HTTP\s+\d+/i.test(value)) return 'http';
        if (/retry after/i.test(value)) return 'retry-after';
        if (/No subtitle|No VTT|empty/i.test(value)) return 'empty-output';
        return 'unknown';
    }

    function tick() {
        var pageKey = isAppleTvPage() ? location.href.split('#')[0] : '';
        if (state.oldlocation !== pageKey) {
            captureApple('navigation.changed', state.playbackSessionId, function () {
                return {
                    hadPreviousPage: !!state.oldlocation,
                    applePage: !!pageKey,
                    path: location.pathname || '/'
                };
            });
            state.oldlocation = pageKey;
            if (isAppleTvPage()) {
                beginPlaybackSession();
                state.status = 'Scanning playback...';
                resetSubtitleTracks();
                resetMediaMetadata();
                refreshMediaMetadataFromDom();
                scanPerformanceEntries(true);
                state.lastPerformanceScanAt = Date.now();
                updateUi();
            }
        }

        if (isAppleTvPage()) {
            var now = Date.now();
            if (now - state.lastPerformanceScanAt >= 5000) {
                scanPerformanceEntries();
                state.lastPerformanceScanAt = now;
            }
            var playbackActive = hasPlaybackSurface();
            if (playbackActive) {
                if (!state.playbackActive) {
                    state.playbackActive = true;
                    discardShortPreviewTracks();
                    state.status = 'Scanning active playback...';
                    scanPerformanceEntries();
                    state.lastPerformanceScanAt = now;
                }
                ensureWidget();
            } else {
                state.playbackActive = false;
                hideWidget();
            }
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
                if (original.__atvsdSessionPatched) return;
                var wrapped = function () {
                    var result = original.apply(this, arguments);
                    try { tick(); } catch (err) { debuglog('Navigation sync failed: ' + err.message); }
                    return result;
                };
                wrapped.__atvsdSessionPatched = true;
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

    function isAppleTvPage() {
        return isAppleHost(location.hostname);
    }

    function isAppleHost(hostname) {
        return hostname === 'tv.apple.com' ||
            /\.tv\.apple\.com$/i.test(hostname || '') ||
            /\.itunes\.apple\.com$/i.test(hostname || '');
    }

    function isTopFrame() {
        try { return window.top === window; } catch (err) { return false; }
    }

    function hasPlaybackSurface() {
        if (!isTopFrame()) return false;
        return hasVisiblePlaybackView() || hasPlayableLongFormVideo();
    }

    function hasVisiblePlaybackView() {
        var views = document.querySelectorAll('[data-testid="playback-view"], .main-playback-view, .playback-view');
        for (var i = 0; i < views.length; i++) {
            if (isVisiblePlaybackRect(views[i])) return true;
        }
        return false;
    }

    function hasPlayableLongFormVideo() {
        var now = Date.now();
        if (state.lastDeepPlaybackScanAt && now - state.lastDeepPlaybackScanAt < 2000) {
            return state.lastDeepPlaybackResult;
        }

        var videos = collectVideosDeep(document);
        var playable = false;
        for (var i = 0; i < videos.length; i++) {
            var video = videos[i];
            var rect = video.getBoundingClientRect();
            if (isPlayableVideo(video, rect)) {
                playable = true;
                break;
            }
        }
        state.lastDeepPlaybackScanAt = now;
        state.lastDeepPlaybackResult = playable;
        return playable;
    }

    function isVisiblePlaybackRect(element) {
        var rect = element.getBoundingClientRect();
        if (rect.width < 320 || rect.height < 180) return false;
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

    function isPlayableVideo(video, rect) {
        if (!rect || rect.width < 240 || rect.height < 160) return false;
        if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= window.innerHeight || rect.left >= window.innerWidth) return false;
        if (isBackgroundPreviewVideo(video)) return false;

        var style = window.getComputedStyle(video);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;

        var hasMedia = !!(video.currentSrc || video.src || video.readyState > 0);
        var duration = Number(video.duration);
        var knownDuration = isFinite(duration) && duration > 0;
        var longForm = duration === Infinity || (knownDuration && duration > 180) || Number(video.currentTime) > 60;
        return hasMedia && longForm;
    }

    function isPlaybackResourceContext() {
        return hasVisiblePlaybackView() || hasPlayableLongFormVideo();
    }

    function isBackgroundPreviewVideo(video) {
        var node = video;
        while (node) {
            if (node.nodeType === 11 && node.host) {
                node = node.host;
                continue;
            }
            if (node.nodeType !== 1) {
                node = node.parentNode;
                continue;
            }
            var tagName = (node.tagName || '').toLowerCase();
            var marker = [
                tagName,
                node.id || '',
                node.className || '',
                node.getAttribute('data-testid') || '',
                node.getAttribute('aria-hidden') || ''
            ].join(' ');
            if (/amp-background-video|background-video|preview/i.test(marker)) return true;
            node = node.parentNode || (node.getRootNode && node.getRootNode().host);
        }
        return false;
    }

    function playbackMenuParent() {
        var dialog = visiblePlaybackDialog();
        return dialog || document.body;
    }

    function visiblePlaybackDialog() {
        var dialogs = document.querySelectorAll('dialog[data-testid="playback-view"], dialog.playback-view, [data-testid="playback-view"].is-playback-active, .playback-view.is-playback-active');
        for (var i = 0; i < dialogs.length; i++) {
            if (isVisiblePlaybackRect(dialogs[i])) return dialogs[i];
        }
        return null;
    }

    function attachWidgetToPlaybackSurface(root) {
        var parent = playbackMenuParent();
        if (!parent || root.parentNode === parent) return;
        parent.appendChild(root);
    }

    function discardShortPreviewTracks() {
        if (!state.langs.length) return;
        var kept = [];
        state.langKeys = {};
        state.langs.forEach(function (track) {
            if (isShortPreviewTrack(track)) return;
            track.key = trackIdentity(track);
            track.identity = track.key;
            if (!state.langKeys[track.key]) {
                state.langKeys[track.key] = track;
                kept.push(track);
            } else {
                mergeTrack(state.langKeys[track.key], track);
            }
        });
        state.langs = kept;
    }

    function beginPlaybackSession(lookbackMs) {
        invalidateDownloadOperation();
        var nowEpochMs = Date.now();
        var requestedLookbackMs = Number(lookbackMs);
        var initialLookbackMs = isFinite(requestedLookbackMs) && requestedLookbackMs >= 0
            ? Math.min(requestedLookbackMs, 5000)
            : (state.playbackSessionSequence === 0 ? 5000 : 0);
        state.playbackSessionSequence++;
        state.playbackSessionId = 'apple:' + state.playbackSessionSequence + ':' + nowEpochMs.toString(36) + ':' + Math.random().toString(36).slice(2);
        state.playbackSessionEpochMs = nowEpochMs - initialLookbackMs;
        state.playbackSessionStartedAt = Math.max(0, performanceNow() - initialLookbackMs);
        captureApple('session.started', state.playbackSessionId, function () {
            return { lookbackMs: initialLookbackMs };
        });
        broadcastPlaybackSession();
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
        resetSubtitleTracks();
        resetMediaMetadata();
        captureApple('session.adopted', sessionId, function () {
            return { pendingObservationCount: pending.length };
        });
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
            } else if (observation.type === 'metadata') {
                inspectMetadataResponse(observation.url, observation.text, sessionId, observation.observedAt);
            }
        });
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
        return typeof sessionId === 'string' && /^apple\:[A-Za-z0-9:._-]{1,250}$/.test(sessionId);
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
        if (!isTopFrame() || !isDescendantFrameSource(source) || !isTrustedAppleOrigin(origin)) return false;
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
        if (!isTopFrame() || !isDescendantFrameSource(source) || !isTrustedAppleOrigin(origin)) return false;
        for (var i = 0; i < state.sessionClients.length; i++) {
            if (state.sessionClients[i].source === source && state.sessionClients[i].origin === origin) return true;
        }
        return false;
    }

    function installSessionBridge() {
        window.addEventListener('message', function (event) {
            var data = event.data;
            if (!isPlainMessageObject(data) || !isTrustedAppleOrigin(event.origin)) return;

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
            if (!isDescendantFrameSource(client.source) || !isTrustedAppleOrigin(client.origin)) return;
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
            if (!isTrustedAppleOrigin(event.origin)) return;
            if (!isRegisteredSessionClient(event.source, event.origin)) return;
            if (data.sessionId !== state.playbackSessionId) return;
            var track = sanitizeTrackMessage(data.track);
            if (!track) return;
            addTrack(track, true);
            state.status = 'Ready. Select a subtitle track.';
            updateUi();
        });
    }

    function isTrustedAppleOrigin(origin) {
        try {
            var parsed = new URL(origin);
            if (parsed.protocol !== 'https:') return false;
            var host = parsed.hostname;
            return isAppleHost(host);
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

    function sanitizedOptionalUrl(value) {
        if (value == null || value === '') return '';
        return isSafeMessageUrl(value) ? value : null;
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

    function sanitizeTrackMessage(track) {
        if (!isPlainMessageObject(track) || !isSafeMessageUrl(track.URI)) return null;
        var name = sanitizedMessageString(track.NAME, 512);
        var language = sanitizedMessageString(track.LANGUAGE, 64);
        var forced = sanitizedMessageString(track.FORCED, 16);
        var characteristics = sanitizedMessageString(track.CHARACTERISTICS, 1024);
        var type = sanitizedMessageString(track.TYPE, 256);
        var source = sanitizedMessageString(track.source, 128);
        if (name === null || language === null || forced === null || characteristics === null || type === null || source === null) return null;
        if (!isSafeMessageSegments(track.segments)) return null;
        if (track.activePlayback != null && typeof track.activePlayback !== 'boolean') return null;
        if (track.playlistDuration != null && (typeof track.playlistDuration !== 'number' || !isFinite(track.playlistDuration) || track.playlistDuration < 0 || track.playlistDuration > 2592000)) return null;
        var manifestUrl = sanitizedOptionalUrl(track.manifestUrl);
        if (manifestUrl === null) return null;
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
            manifestUrl: manifestUrl
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
            activePlayback: !!track.activePlayback,
            playlistDuration: track.playlistDuration || null,
            manifestUrl: track.manifestUrl || ''
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
        Array.prototype.forEach.call(document.querySelectorAll('style#dpsd-styles'), function (existing) {
            existing.parentNode.removeChild(existing);
        });

        var style = document.createElement('style');
        style.id = 'dpsd-styles';
        style.textContent = [
            '#dpsd-root{position:fixed;display:block;width:300px;top:0;left:calc(50% - 150px);z-index:2147483647;font-family:Arial,sans-serif;color:#fff;font-size:10px;pointer-events:auto}',
            '#dpsd-root *{box-sizing:border-box}',
            '#dpsd-menu{list-style:none;position:relative;width:300px;background:#333;color:#fff;padding:0;margin:auto;font-size:12px;z-index:99999998}',
            '#dpsd-menu li{padding:10px;min-height:34px;line-height:14px;white-space:normal}',
            '#dpsd-menu li.dpsd-header{font-weight:bold;cursor:default}',
            '#dpsd-menu li:not(.dpsd-header){display:none;cursor:pointer}',
            '#dpsd-root:hover #dpsd-menu li,#dpsd-root:focus-within #dpsd-menu li{display:block}',
            '#dpsd-menu li:not(.dpsd-header):hover{background:#666}',
            '#dpsd-menu li.dpsd-info{cursor:default}',
            '#dpsd-menu li.dpsd-info:hover{background:transparent}',
            '#dpsd-menu li.dpsd-disabled{opacity:.45;cursor:not-allowed}',
            '#dpsd-menu li.dpsd-disabled:hover{background:transparent}',
            '#dpsd-track{width:100%;margin-top:6px;border:1px solid #555;background:#222;color:#fff;padding:4px;font-size:12px}',
            '#dpsd-status,#dpsd-filename{color:#ddd;word-break:break-word}',
            '#dpsd-progress{width:100%;height:10px;margin-top:6px;accent-color:#00a8e1}',
            '#dpsd-count,#dpsd-selected-name,#dpsd-format,#dpsd-progress-text{font-weight:normal}'
        ].join('\n');

        appendWhenPossible(style);
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
        if (!isAppleTvPage()) return;
        if (!document.body) {
            setTimeout(ensureWidget, 100);
            return;
        }
        if (!hasPlaybackSurface()) {
            hideWidget();
            return;
        }

        var root = document.getElementById('dpsd-root');
        if (root) {
            attachWidgetToPlaybackSurface(root);
            root.style.display = '';
            updateUi();
            return;
        }

        root = document.createElement('div');
        root.id = 'dpsd-root';
        var menu = document.createElement('ol');
        menu.id = 'dpsd-menu';
        root.appendChild(menu);

        menu.appendChild(createMenuItem('', 'Apple TV+ subtitle downloader', 'dpsd-header'));
        menu.appendChild(createMenuItem('dpsd-download', 'Download selected subtitle'));
        menu.appendChild(createMenuItem('dpsd-download-en', 'Download English subtitle'));
        menu.appendChild(createMenuItem('dpsd-download-ko', 'Download Korean subtitle'));
        menu.appendChild(createMenuItem('dpsd-download-en-ko', 'Download English + Korean subtitles'));
        menu.appendChild(createMenuItem('dpsd-download-all', 'Download all detected subtitles'));

        var selectedItem = createMenuItem('', 'Selected track: ', 'dpsd-info');
        var selectedName = document.createElement('span');
        selectedName.id = 'dpsd-selected-name';
        selectedName.textContent = 'none';
        var trackSelect = document.createElement('select');
        trackSelect.id = 'dpsd-track';
        selectedItem.appendChild(selectedName);
        selectedItem.appendChild(trackSelect);
        menu.appendChild(selectedItem);

        var countItem = createMenuItem('', 'Detected subtitles: ', 'dpsd-info');
        var countValue = document.createElement('span');
        countValue.id = 'dpsd-count';
        countValue.textContent = '0 tracks';
        countItem.appendChild(countValue);
        menu.appendChild(countItem);

        var formatItem = createMenuItem('', 'Subtitle format: ', 'dpsd-info');
        var formatValue = document.createElement('span');
        formatValue.id = 'dpsd-format';
        formatValue.textContent = 'WebVTT';
        formatItem.appendChild(formatValue);
        menu.appendChild(formatItem);

        var filenameItem = createMenuItem('', 'Output file: ', 'dpsd-info');
        var filenameValue = document.createElement('span');
        filenameValue.id = 'dpsd-filename';
        filenameValue.textContent = 'Waiting for a subtitle track...';
        filenameItem.appendChild(filenameValue);
        menu.appendChild(filenameItem);

        var progressItem = createMenuItem('', 'Progress: ', 'dpsd-info');
        var progressValue = document.createElement('span');
        progressValue.id = 'dpsd-progress-text';
        progressValue.textContent = 'Idle';
        var progressBar = document.createElement('progress');
        progressBar.id = 'dpsd-progress';
        progressBar.max = 1;
        progressBar.value = 0;
        progressItem.appendChild(progressValue);
        progressItem.appendChild(progressBar);
        menu.appendChild(progressItem);

        menu.appendChild(createMenuItem('dpsd-rescan', 'Rescan playback resources'));

        var statusItem = createMenuItem('', 'Status: ', 'dpsd-info');
        var statusValue = document.createElement('span');
        statusValue.id = 'dpsd-status';
        statusValue.textContent = 'Start playback, then wait for tracks...';
        statusItem.appendChild(statusValue);
        menu.appendChild(statusItem);

        attachWidgetToPlaybackSurface(root);

        bindMenuAction('dpsd-rescan', function () {
            state.status = 'Rescanning playback resources...';
            scanPerformanceEntries(true);
            state.lastPerformanceScanAt = Date.now();
            updateUi();
        });
        document.getElementById('dpsd-track').addEventListener('change', function () {
            state.selectedTrackKey = this.value;
            state.userSelectedTrack = true;
            updateUi();
        });
        bindMenuAction('dpsd-download', function () {
            if (state.wait || state.langs.length === 0) return;
            var select = document.getElementById('dpsd-track');
            state.selectedTrackKey = select.value;
            state.userSelectedTrack = true;
            var track = findTrackByKey(select.value);
            if (track) downloadTrack(track);
        });
        bindMenuAction('dpsd-download-all', downloadAllTracks);
        bindMenuAction('dpsd-download-en', function () {
            downloadPreferredTrack('en');
        });
        bindMenuAction('dpsd-download-ko', function () {
            downloadPreferredTrack('ko');
        });
        bindMenuAction('dpsd-download-en-ko', downloadEnglishAndKorean);

        updateUi();
    }

    function hideWidget() {
        var root = document.getElementById('dpsd-root');
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
            if (node.classList.contains('dpsd-disabled')) return;
            handler();
        });
        node.addEventListener('keydown', function (event) {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            if (node.classList.contains('dpsd-disabled')) return;
            handler();
        });
    }

    function updateUi() {
        var root = document.getElementById('dpsd-root');
        if (!root) return;
        if (!hasPlaybackSurface()) {
            hideWidget();
            return;
        }

        var select = document.getElementById('dpsd-track');
        var count = document.getElementById('dpsd-count');
        var status = document.getElementById('dpsd-status');
        var download = document.getElementById('dpsd-download');
        var downloadAll = document.getElementById('dpsd-download-all');
        var downloadEn = document.getElementById('dpsd-download-en');
        var downloadKo = document.getElementById('dpsd-download-ko');
        var downloadEnKo = document.getElementById('dpsd-download-en-ko');
        var selectedName = document.getElementById('dpsd-selected-name');
        var filename = document.getElementById('dpsd-filename');
        var progress = document.getElementById('dpsd-progress');
        var progressText = document.getElementById('dpsd-progress-text');
        var preferredEn = findPreferredTrack('en');
        var preferredKo = findPreferredTrack('ko');
        var desiredKey = state.userSelectedTrack ? state.selectedTrackKey : preferredSelectionKey();

        select.innerHTML = '';
        state.langs.forEach(function (track) {
            var option = document.createElement('option');
            option.value = track.key;
            option.textContent = track.NAME;
            select.appendChild(option);
        });

        if (state.langs.length === 0) {
            var empty = document.createElement('option');
            empty.textContent = 'No subtitles detected yet';
            empty.value = '';
            select.appendChild(empty);
        }

        if (!findTrackByKey(desiredKey)) {
            desiredKey = preferredSelectionKey();
        }
        if (desiredKey) {
            select.value = desiredKey;
            state.selectedTrackKey = desiredKey;
        }

        count.textContent = state.langs.length + (state.langs.length === 1 ? ' track' : ' tracks');
        selectedName.textContent = findTrackByKey(select.value) ? findTrackByKey(select.value).NAME : 'none';
        filename.textContent = state.wait && state.outputFilename ? state.outputFilename : previewSelectedFilename(select.value);
        updateProgressElement(progress, progressText);
        status.textContent = state.lastError || state.status;
        setMenuItemDisabled(download, state.wait || state.langs.length === 0);
        setMenuItemDisabled(downloadAll, state.wait || state.langs.length === 0);
        setMenuItemDisabled(downloadEn, state.wait || !preferredEn);
        setMenuItemDisabled(downloadKo, state.wait || !preferredKo);
        setMenuItemDisabled(downloadEnKo, state.wait || !preferredEn || !preferredKo);
        downloadEn.title = preferredEn ? preferredEn.NAME : 'No English subtitle detected yet';
        downloadKo.title = preferredKo ? preferredKo.NAME : 'No Korean subtitle detected yet';
        downloadEnKo.title = preferredEn && preferredKo ? preferredEn.NAME + ' + ' + preferredKo.NAME : 'English and Korean subtitles are both required';
    }

    function setMenuItemDisabled(node, disabled) {
        if (!node) return;
        node.classList.toggle('dpsd-disabled', !!disabled);
        node.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    }

    function previewSelectedFilename(trackKey) {
        return safeBaseFilename();
    }

    function trackDownloadFilename(track, tracks, baseFilename) {
        tracks = uniqueTracks(tracks || [track]);
        if (tracks.length === 1) return baseFilename + '.' + safeTrackName(track) + '.vtt';
        return baseFilename + '.' + safeTrackName(track) + '.with-forced.zip';
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
                document.getElementById('dpsd-progress'),
                document.getElementById('dpsd-progress-text')
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
            if (proto.open && proto.open.__dpsdPatched) return;
            var originalOpen = proto.open;
            var originalSend = proto.send;
            proto.open = function () {
                if (arguments.length >= 2) {
                    this.__dpsdUrl = normalizeUrl(arguments[1]);
                    this.__dpsdSessionId = state.playbackSessionId;
                    this.__dpsdObservedAt = Date.now();
                    recordResourceUrl(arguments[1], 'xhr', this.__dpsdSessionId, this.__dpsdObservedAt);
                }
                return originalOpen.apply(this, arguments);
            };
            proto.send = function () {
                var xhr = this;
                if (!xhr.__dpsdMetaHooked) {
                    xhr.__dpsdMetaHooked = true;
                    xhr.addEventListener('loadend', function () {
                        var responseText = '';
                        try {
                            if (!xhr.responseType || xhr.responseType === 'text') responseText = xhr.responseText;
                        } catch (err) {}
                        inspectMetadataResponse(xhr.__dpsdUrl, responseText, xhr.__dpsdSessionId, xhr.__dpsdObservedAt);
                    }, false);
                }
                return originalSend.apply(this, arguments);
            };
            proto.open.__dpsdPatched = true;
            debuglog('XHR hook installed');
        } catch (err) {
            debuglog('XHR hook failed: ' + err.message);
        }
    }

    function hookFetch(win) {
        try {
            if (!win.fetch || win.fetch.__dpsdPatched) return;
            var originalFetch = win.fetch;
            win.fetch = function () {
                var url = fetchInputUrl(arguments[0]);
                var sessionId = state.playbackSessionId;
                var observedAt = Date.now();
                recordResourceUrl(url, 'fetch', sessionId, observedAt);
                return originalFetch.apply(this, arguments).then(function (response) {
                    inspectFetchMetadataResponse(url || response.url, response, sessionId, observedAt);
                    return response;
                });
            };
            win.fetch.__dpsdPatched = true;
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
        if (isAppleTvPage()) scanPerformanceEntries();
        try {
            if (!targetWindow.PerformanceObserver) return;
            state.observer = new targetWindow.PerformanceObserver(function (list) {
                list.getEntries().forEach(function (entry) {
                    var observedAt = performanceEntryEpochMs(entry);
                    if (state.playbackSessionEpochMs && observedAt < state.playbackSessionEpochMs) return;
                    if (isApplePlaybackResourceUrl(entry.name)) {
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
                var entry = entries[i];
                var observedAt = performanceEntryEpochMs(entry);
                if (state.playbackSessionEpochMs && observedAt < state.playbackSessionEpochMs) continue;
                if (isApplePlaybackResourceUrl(entry.name)) {
                    recordResourceUrl(entry.name, 'performance-scan', state.playbackSessionId, observedAt);
                }
            }
            state.performanceEntryCount = entries.length;
        } catch (err) {
            debuglog('Performance scan failed: ' + err.message);
        }
    }

    function isApplePlaybackResourceUrl(rawUrl) {
        var url = normalizeUrl(rawUrl);
        return /\.(?:m3u8|vtt|webvtt)(?:[?#]|$)/i.test(url || '');
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
        captureApple('resource.observed', sessionId, function () {
            return {
                url: url,
                source: source || '',
                kind: fixtureResourceKind(url)
            };
        });

        if (/\.m3u8(?:[?#]|$)/i.test(url)) {
            queueManifest(url, source, sessionId);
        } else if (/\.(?:vtt|webvtt)(?:[?#]|$)/i.test(url)) {
            addTrack({
                NAME: inferTrackName(url),
                LANGUAGE: inferLanguage(url),
                FORCED: /forced/i.test(url) ? 'YES' : 'NO',
                URI: url,
                source: source || 'direct',
                activePlayback: isPlaybackResourceContext(),
                manifestUrl: ''
            });
            state.status = 'Ready. Select a subtitle track.';
            updateUi();
        }
    }

    function inspectFetchMetadataResponse(url, response, sessionId, observedAt) {
        if (!shouldInspectMetadataUrl(url) || !response || !response.clone) return;
        try {
            response.clone().text().then(function (text) {
                inspectMetadataResponse(url, text, sessionId, observedAt);
            }).catch(function () {});
        } catch (err) {}
    }

    function inspectMetadataResponse(url, text, sessionId, observedAt) {
        if (!shouldInspectMetadataUrl(url) || typeof text !== 'string' || !text) return;
        if (text.length > 2000000) return;
        observedAt = Number(observedAt) || Date.now();
        var shouldDefer = rememberSessionObservation({ type: 'metadata', url: url, text: text }, observedAt);
        sessionId = resolveObservationSession(sessionId, observedAt);
        if (!sessionId && shouldDefer) return;
        if (!isPlaybackSessionCurrent(sessionId)) {
            captureApple('metadata.rejected', sessionId, function () {
                return { reason: 'stale-session', url: url };
            });
            return;
        }

        var metadata = extractMetadataFromText(text);
        var projection = fixtureMetadataProjection(text);
        var artifactId = projection ? captureAppleArtifact('metadata-structure', projection, function () {
            return { format: 'json', url: url };
        }) : null;
        captureApple('metadata.observed', sessionId, function () {
            return {
                artifact: artifactId || '',
                url: url,
                extracted: {
                    titlePresent: !!metadata.title,
                    seasonNumber: metadata.seasonNumber || null,
                    episodeNumber: metadata.episodeNumber || null,
                    episodeTag: metadata.episodeTag || ''
                }
            };
        });
        if (metadata.title || metadata.episodeTag || (metadata.seasonNumber && metadata.episodeNumber)) {
            if (metadataConflictsWithActivePlayback(metadata)) {
                captureApple('metadata.rejected', sessionId, function () {
                    return { reason: 'active-playback-mismatch', artifact: artifactId || '', url: url };
                });
                return;
            }
            updateMediaMetadata(metadata, 3);
            captureApple('metadata.accepted', sessionId, function () {
                return fixtureMetadataState();
            });
        } else {
            captureApple('metadata.rejected', sessionId, function () {
                return { reason: 'no-supported-fields', artifact: artifactId || '', url: url };
            });
        }
    }

    function shouldInspectMetadataUrl(url) {
        url = normalizeUrl(url);
        if (!url) return false;
        if (/\.(m3u8|vtt|mp4|mp4a|m4s|bif|png|jpg|jpeg|webp|woff2?)(?:[?#]|$)/i.test(url)) return false;
        if (/(?:\/(?:shelves|canvases)\/|upnext|up-next|explore|recommend(?:ation)?s?)/i.test(url)) return false;
        if (/\/api\/uts\/v\d+\/shows(?:[/?#]|$)/i.test(url)) return false;
        return /apple|itunes|utscf|tv|playback|video|episode|metadata|uts|umc/i.test(url);
    }

    function metadataConflictsWithActivePlayback(metadata) {
        if (!metadata) return false;
        var playbackEpisodeTag = seasonEpisodeTag(activePlaybackInfoText());
        if (!playbackEpisodeTag) return false;
        var candidateEpisodeTag = metadata.episodeTag ||
            (metadata.seasonNumber && metadata.episodeNumber ? formatSeasonEpisode(metadata.seasonNumber, metadata.episodeNumber) : '');
        if (candidateEpisodeTag && candidateEpisodeTag !== playbackEpisodeTag) return true;
        var playbackTitle = activePlaybackTitle();
        return !!(metadata.title && playbackTitle && !mediaTitlesMatch(metadata.title, playbackTitle));
    }

    function extractMetadataFromText(text) {
        var metadata = {};
        var tag = seasonEpisodeTag(text);
        if (tag) metadata.episodeTag = tag;

        try {
            collectMetadataFromJson(JSON.parse(text), metadata, '', 0);
        } catch (err) {}

        return metadata;
    }

    function collectMetadataFromJson(value, metadata, path, depth) {
        if (value == null || depth > 12) return;

        if (typeof value === 'string') {
            var tag = seasonEpisodeTag(value);
            if (tag && !metadata.episodeTag) metadata.episodeTag = tag;
            return;
        }

        if (typeof value !== 'object') return;

        if (Array.isArray(value)) {
            value.slice(0, 250).forEach(function (item) {
                collectMetadataFromJson(item, metadata, path, depth + 1);
            });
            return;
        }

        Object.keys(value).forEach(function (key) {
            var child = value[key];
            var lower = key.toLowerCase();
            var nextPath = path ? path + '.' + lower : lower;

            if (typeof child === 'number' || (typeof child === 'string' && /^\d{1,4}$/.test(child))) {
                var number = parseInt(child, 10);
                if (number > 0 && number < 1000) {
                    if (/season/.test(nextPath) && /(number|sequence|seq|index|position|season$)/.test(lower)) {
                        metadata.seasonNumber = metadata.seasonNumber || number;
                    }
                    if (/episode/.test(nextPath) && /(number|sequence|seq|index|position|episode$)/.test(lower)) {
                        metadata.episodeNumber = metadata.episodeNumber || number;
                    }
                }
            }

            if (typeof child === 'string') {
                var tag = seasonEpisodeTag(child);
                if (tag && !metadata.episodeTag) metadata.episodeTag = tag;

                if (!metadata.title && /(series|show|program|collection|franchise).*(title|name)|(?:title|name).*(series|show|program|collection|franchise)/.test(nextPath)) {
                    metadata.title = child;
                }
            }

            collectMetadataFromJson(child, metadata, nextPath, depth + 1);
        });
    }

    function isGenericMediaTitle(title) {
        var normalized = String(title || '')
            .replace(/[\u200e\u200f]/g, '')
            .replace(/\u00a0/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
        return normalized === 'apple tv' || normalized === 'apple tv+' || normalized === 'appletvplus';
    }

    function shouldReplaceMediaTitle(title, priority) {
        if (!state.mediaTitle) return true;
        if (isGenericMediaTitle(title) && !isGenericMediaTitle(state.mediaTitle)) return false;
        if (priority > state.mediaTitlePriority) return true;
        if (priority < state.mediaTitlePriority) return false;
        return !isGenericMediaTitle(title) || isGenericMediaTitle(state.mediaTitle);
    }

    function updateMediaMetadata(metadata, priority) {
        if (!metadata) return;
        priority = Number(priority) || 1;

        if (metadata.title) {
            var title = cleanDisplayTitle(metadata.title);
            if (title && !/\bS\d{1,2}E\d{1,3}\b/i.test(title) && shouldReplaceMediaTitle(title, priority)) {
                state.mediaTitle = title;
                state.mediaTitlePriority = priority;
            }
        }

        if (metadata.seasonNumber && metadata.episodeNumber) {
            state.seasonNumber = metadata.seasonNumber;
            state.episodeNumber = metadata.episodeNumber;
            state.episodeTag = formatSeasonEpisode(metadata.seasonNumber, metadata.episodeNumber);
        }

        if (metadata.episodeTag) {
            state.episodeTag = metadata.episodeTag;
        }

        captureAppleSnapshot('metadata-state', state.playbackSessionId, function () {
            return fixtureMetadataState();
        });
    }

    function resetMediaMetadata() {
        state.mediaTitle = '';
        state.mediaTitlePriority = 0;
        state.seasonNumber = null;
        state.episodeNumber = null;
        state.episodeTag = '';
    }

    function resetSubtitleTracks() {
        state.langs = [];
        state.langKeys = {};
        state.seenManifestUrls = {};
        state.seenResourceUrls = {};
        state.manifestMeta = {};
        state.playbackScanStartedAt = state.playbackSessionStartedAt || performanceNow();
        state.performanceEntryCount = 0;
        state.lastPerformanceScanAt = 0;
        state.lastDeepPlaybackScanAt = 0;
        state.lastDeepPlaybackResult = false;
        state.playbackActive = false;
        state.selectedTrackKey = '';
        state.userSelectedTrack = false;
        state.lastError = '';
        state.outputFilename = '';
        state.progressCompleted = 0;
        state.progressTotal = 0;
        state.progressLabel = 'Idle';
    }

    function activePlaybackContainer() {
        var selectors = [
            'dialog[data-testid="playback-view"][open]',
            '[data-testid="playback-view"][open]',
            '.main-playback-view dialog[open]',
            'dialog.playback-view[open]'
        ];
        for (var i = 0; i < selectors.length; i++) {
            try {
                var node = document.querySelector(selectors[i]);
                if (node) return node;
            } catch (err) {}
        }

        try {
            var video = document.querySelector('video');
            if (video && typeof video.closest === 'function') {
                return video.closest('dialog[open], [data-testid*="playback"]');
            }
        } catch (err) {}
        return null;
    }

    function activePlaybackTitle() {
        var container = activePlaybackContainer();
        if (!container) return '';
        var candidates = [];
        try {
            var selectors = [
                '[data-testid="player-metadata-title"]',
                '[data-testid*="player"][data-testid*="title"]',
                '[data-testid="video-title"]',
                'h1',
                'h2'
            ];
            for (var selectorIndex = 0; selectorIndex < selectors.length; selectorIndex++) {
                var titleNode = container.querySelector(selectors[selectorIndex]);
                if (titleNode) candidates.push(titleNode.textContent || '');
            }
        } catch (err) {}
        try {
            var ariaLabel = container.getAttribute('aria-label') || '';
            var infoText = container.innerText || container.textContent || '';
            if (!seasonEpisodeTag(infoText)) candidates.push(ariaLabel);
        } catch (err) {}

        for (var i = 0; i < candidates.length; i++) {
            var title = cleanDisplayTitle(candidates[i]);
            if (title && !isGenericMediaTitle(title)) return title;
        }
        return '';
    }

    function activePlaybackInfoText() {
        var container = activePlaybackContainer();
        if (!container) return '';
        var parts = [];
        try { parts.push(container.getAttribute('aria-label') || ''); } catch (err) {}
        try { parts.push(container.innerText || container.textContent || ''); } catch (err) {}
        try {
            Array.prototype.slice.call(container.querySelectorAll('[aria-label],[title]'), 0, 200).forEach(function (node) {
                parts.push(node.getAttribute('aria-label') || '');
                parts.push(node.getAttribute('title') || '');
            });
        } catch (err) {}
        return parts.filter(Boolean).join('\n');
    }

    function normalizedMediaTitleForComparison(title) {
        return cleanDisplayTitle(title)
            .toLowerCase()
            .replace(/[^a-z0-9\u00c0-\uffff]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function mediaTitlesMatch(first, second) {
        var left = normalizedMediaTitleForComparison(first);
        var right = normalizedMediaTitleForComparison(second);
        if (!left || !right) return false;
        if (left === right) return true;
        return Math.min(left.length, right.length) >= 4 &&
            (left.indexOf(right) >= 0 || right.indexOf(left) >= 0);
    }

    function playbackMetadataChanged(playbackTitle, playbackEpisodeTag) {
        var titleChanged = playbackTitle && state.mediaTitle && !mediaTitlesMatch(playbackTitle, state.mediaTitle);
        var episodeChanged = playbackEpisodeTag && state.episodeTag && playbackEpisodeTag !== state.episodeTag;
        return !!(titleChanged || episodeChanged);
    }

    function restartPlaybackSessionForMetadataChange() {
        captureApple('metadata.playback-changed', state.playbackSessionId, function () {
            return fixtureMetadataState();
        });
        beginPlaybackSession(3000);
        var sessionId = state.playbackSessionId;
        state.status = 'Scanning new playback...';
        resetSubtitleTracks();
        resetMediaMetadata();
        setTimeout(function () {
            if (!isPlaybackSessionCurrent(sessionId)) return;
            scanPerformanceEntries(true);
            state.lastPerformanceScanAt = Date.now();
            updateUi();
        }, 0);
    }

    function refreshMediaMetadataFromDom() {
        var playbackTitle = activePlaybackTitle();
        var playbackText = activePlaybackInfoText();
        var playbackEpisodeTag = seasonEpisodeTag(playbackText || playbackInfoText());
        captureAppleSnapshot('active-player', state.playbackSessionId, function () {
            return {
                title: playbackTitle || '',
                episodeTag: playbackEpisodeTag || '',
                playbackSurface: hasPlaybackSurface()
            };
        });
        if (playbackMetadataChanged(playbackTitle, playbackEpisodeTag)) restartPlaybackSessionForMetadataChange();
        updateMediaMetadata({
            title: playbackTitle || displayTitle(),
            episodeTag: playbackEpisodeTag
        }, playbackTitle ? 4 : 1);
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
        state.manifestMeta[url] = {
            source: source || '',
            activePlayback: isPlaybackResourceContext(),
            queuedAt: performanceNow(),
            sessionId: sessionId
        };
        state.status = 'Found manifest via ' + source + '. Reading tracks...';
        captureApple('artifact.requested', sessionId, function () {
            return { kind: 'manifest', url: url, source: source || '' };
        });
        updateUi();

        getText(url).then(function (text) {
            if (!isPlaybackSessionCurrent(sessionId)) return;
            state.seenManifestUrls[url] = 'loaded';
            if (/^Could not read manifest:/.test(state.lastError || '')) state.lastError = '';
            var directWebVtt = /^\s*WEBVTT/i.test(text || '');
            var hlsManifest = (text || '').indexOf('#EXTM3U') >= 0;
            var manifestProjection = fixtureCaptureRecording && hlsManifest ? fixtureManifestProjection(url, text || '') : null;
            var artifactText = directWebVtt ? (text || '') : (manifestProjection && manifestProjection.relevant ? manifestProjection.text : '');
            var artifactId = artifactText ? captureAppleArtifact('manifest', artifactText, function () {
                return {
                    format: directWebVtt ? 'webvtt' : 'm3u8',
                    url: url,
                    projected: !!(manifestProjection && manifestProjection.projected),
                    originalLineCount: manifestProjection ? manifestProjection.originalLineCount : 0,
                    projectedLineCount: manifestProjection ? manifestProjection.projectedLineCount : 0
                };
            }) : null;
            captureApple('artifact.loaded', sessionId, function () {
                return {
                    kind: 'manifest',
                    artifact: artifactId || '',
                    recognized: directWebVtt || hlsManifest,
                    relevant: directWebVtt || !!(manifestProjection && manifestProjection.relevant),
                    projected: !!(manifestProjection && manifestProjection.projected),
                    responseKind: directWebVtt ? 'webvtt' : (hlsManifest ? 'hls' : 'unrecognized-response'),
                    url: url
                };
            });
            parseManifest(url, text || '', sessionId);
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
            captureApple('artifact.failed', sessionId, function () {
                return { kind: 'manifest', url: url, errorCode: fixtureErrorCode(err) };
            });
            updateUi();
        });
    }

    function parseManifest(url, text, sessionId) {
        if (!isPlaybackSessionCurrent(sessionId)) return;
        if (!text) return;
        if (text.indexOf('#EXTM3U') < 0 && text.indexOf('WEBVTT') < 0) return;

        var meta = state.manifestMeta[url] || {};
        var duration = playlistDurationSeconds(text) || subtitleTextDurationSeconds(text);
        var lines = text.split(/\r\n|\r|\n/);
        var subtitleMediaLines = lines.filter(function (line) {
            return /^#EXT-X-MEDIA:/i.test(line) && /TYPE=(SUBTITLES|CLOSED-CAPTIONS)/i.test(line);
        });

        subtitleMediaLines.forEach(function (line) {
            var attrs = parseAttrList(line.replace(/^#EXT-X-MEDIA:/i, ''));
            if (!attrs.URI) return;
            addTrack({
                NAME: trackLabel(attrs, attrs.URI),
                LANGUAGE: attrs.LANGUAGE || inferLanguage(attrs.URI),
                FORCED: attrs.FORCED || 'NO',
                CHARACTERISTICS: attrs.CHARACTERISTICS || '',
                TYPE: attrs.TYPE || '',
                URI: absoluteUrl(attrs.URI, url),
                source: 'master',
                activePlayback: !!meta.activePlayback,
                manifestUrl: url
            });
        });

        if (looksLikeSubtitlePlaylist(url, text)) {
            var segments = extractSegmentUrls(text, url);
            addTrack({
                NAME: inferTrackName(url),
                LANGUAGE: inferLanguage(url),
                FORCED: /forced/i.test(url) ? 'YES' : 'NO',
                URI: url,
                source: 'playlist',
                segments: segments,
                activePlayback: !!meta.activePlayback,
                playlistDuration: duration || null,
                manifestUrl: url
            });
        }

        if (state.langs.length > 0) {
            state.status = 'Ready. Select a subtitle track.';
        }
        captureApple('manifest.parsed', sessionId, function () {
            return {
                url: url,
                subtitleMediaCount: subtitleMediaLines.length,
                subtitlePlaylist: looksLikeSubtitlePlaylist(url, text),
                trackCount: state.langs.length
            };
        });
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
        var parts = [];
        if (attrs.NAME) parts.push(attrs.NAME);
        if (attrs.LANGUAGE && parts.join(' ').indexOf(attrs.LANGUAGE) < 0) parts.push('[' + attrs.LANGUAGE + ']');
        if (attrs.FORCED === 'YES') parts.push('(forced)');
        if (attrs.CHARACTERISTICS && /sdh|transcribes-spoken-dialog/i.test(attrs.CHARACTERISTICS)) parts.push('(CC)');
        return parts.join(' ') || inferTrackName(uri);
    }

    function inferTrackName(url) {
        var decoded = decodeURIComponent(url);
        var file = decoded.split(/[/?#]/).filter(Boolean).pop() || 'Subtitle';
        var language = inferLanguage(decoded);
        var label = language ? language : file.replace(/\.m3u8.*/i, '').replace(/[_-]+/g, ' ');
        if (/sdh|cc|caption/i.test(decoded) && !/\bcc\b/i.test(label)) label += ' (CC)';
        if (/forced/i.test(decoded)) label += ' (forced)';
        return label || 'Subtitle';
    }

    function inferLanguage(url) {
        var decoded = decodeURIComponent(url);
        var match = decoded.match(/(?:^|[\/_-])([a-z]{2,3})(?:[_-](?:SDH|CC|FORCED|MAIN|PRIMARY))?(?:[_-]|\.m3u8|\/)/i);
        return match ? match[1].toLowerCase() : '';
    }

    function addTrack(track, fromFrameMessage) {
        if (!track.URI) return;
        if (!isTopFrame() && !fromFrameMessage) {
            forwardTrackToTop(track);
            return;
        }
        var key = trackIdentity(track);
        var existing = state.langKeys[key];
        if (existing) {
            mergeTrack(existing, track);
            return;
        }
        track.key = key;
        track.identity = key;
        state.langKeys[key] = track;
        state.langs.push(track);
        state.langs.sort(function (a, b) {
            return a.NAME.localeCompare(b.NAME);
        });
        captureApple('track.added', state.playbackSessionId, function () {
            return {
                track: fixtureTrackSummary(track),
                fromFrame: !!fromFrameMessage,
                trackCount: state.langs.length
            };
        });
        debuglog('Track added: ' + track.NAME);
    }

    function mergeTrack(existing, incoming) {
        if (!incoming || !incoming.URI) return;
        var fixtureTrackBefore = fixtureCaptureRecording && fixtureCapture
            ? JSON.stringify(fixtureTrackSummary(existing))
            : '';
        var incomingScore = trackSourceScore(incoming);
        var existingScore = trackSourceScore(existing);

        if (incomingScore > existingScore) {
            var uriChanged = existing.URI !== incoming.URI;
            existing.URI = incoming.URI;
            existing.source = incoming.source || existing.source;
            existing.segments = incoming.segments || (uriChanged ? null : existing.segments);
            existing.activePlayback = !!incoming.activePlayback;
            existing.playlistDuration = incoming.playlistDuration || (uriChanged ? null : existing.playlistDuration);
            existing.manifestUrl = incoming.manifestUrl || existing.manifestUrl;
        } else if (!isShortPreviewTrack(incoming) && incoming.segments && incoming.segments.length && (!existing.segments || !existing.segments.length)) {
            existing.segments = incoming.segments;
        }

        if (!existing.LANGUAGE && incoming.LANGUAGE) existing.LANGUAGE = incoming.LANGUAGE;
        if (!existing.FORCED && incoming.FORCED) existing.FORCED = incoming.FORCED;
        if (!existing.CHARACTERISTICS && incoming.CHARACTERISTICS) existing.CHARACTERISTICS = incoming.CHARACTERISTICS;
        if (!existing.TYPE && incoming.TYPE) existing.TYPE = incoming.TYPE;
        if (!existing.playlistDuration && incoming.playlistDuration) existing.playlistDuration = incoming.playlistDuration;
        if (!existing.manifestUrl && incoming.manifestUrl) existing.manifestUrl = incoming.manifestUrl;
        if (!existing.activePlayback && incoming.activePlayback && incomingScore >= existingScore) existing.activePlayback = true;
        if (isBetterTrackName(incoming.NAME, existing.NAME)) existing.NAME = incoming.NAME;
        if (fixtureTrackBefore) {
            var fixtureTrackAfter = fixtureTrackSummary(existing);
            if (JSON.stringify(fixtureTrackAfter) !== fixtureTrackBefore) {
                captureApple('track.merged', state.playbackSessionId, function () {
                    return {
                        track: fixtureTrackAfter,
                        incomingSource: incoming.source || '',
                        upgraded: incomingScore > existingScore
                    };
                });
            }
        }
        debuglog('Track merged: ' + existing.NAME);
    }

    function trackSourceScore(track) {
        var score = 0;
        if (track.activePlayback) score += 100;
        if (isShortPreviewTrack(track)) score -= 200;
        if (looksLikePreviewTrack(track)) score -= 50;
        if (Number(track.playlistDuration) >= 120) score += 80;
        if (track.source === 'master') score += 4;
        if (track.source === 'playlist') score += 2;
        if (track.segments && track.segments.length) score += 3;
        if (track.URI) score += 1;
        return score;
    }

    function isBetterTrackName(candidate, current) {
        if (!candidate) return false;
        if (!current) return true;
        if (/subtitle/i.test(current) && !/subtitle/i.test(candidate)) return true;
        if ((current.indexOf('[') < 0) && candidate.indexOf('[') >= 0) return true;
        return candidate.length > current.length && candidate.length < 80;
    }

    function trackIdentity(track) {
        var language = trackLanguage(track);
        var type = isForcedTrack(track) ? 'forced' : 'main';
        var captions = isCcTrack(track) ? 'cc' : 'plain';
        var label = normalizeTrackLabel(track.NAME || inferTrackName(track.URI));
        return (language || label || track.URI.replace(/[?#].*$/, '')) + '|' + type + '|' + captions;
    }

    function findTrackByKey(key) {
        if (!key) return null;
        for (var i = 0; i < state.langs.length; i++) {
            if (state.langs[i].key === key) return state.langs[i];
        }
        return null;
    }

    function preferredSelectionKey() {
        var preferred = findPreferredTrack('ko') || findPreferredTrack('en') || state.langs[0];
        return preferred ? preferred.key : '';
    }

    function findPreferredTrack(language) {
        var candidates = state.langs.filter(function (track) {
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
        if (language === 'ko') {
            return /\b(ko|kor|kr|korean)\b/.test(haystack) || haystack.indexOf('한국') >= 0;
        }
        if (language === 'en') {
            return /\b(en|eng|english)\b/.test(haystack);
        }
        return false;
    }

    function trackScore(track, language) {
        var haystack = ((track.LANGUAGE || '') + ' ' + (track.NAME || '') + ' ' + (track.URI || '')).toLowerCase();
        var score = 0;
        score += trackSourceScore(track);
        if (languagePrimary(trackLanguage(track)) === languagePrimary(language)) score += 100;
        if (language === 'ko') {
            if (haystack.indexOf('korean') >= 0 || haystack.indexOf('한국') >= 0) score += 50;
        }
        if (language === 'en') {
            if (haystack.indexOf('english') >= 0) score += 50;
        }
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
        return /\.(?:vtt|webvtt)(?:[?#\s]|$)/i.test(text) ||
            /WEBVTT|SUBTITLE|caption|timedtext/i.test(text) ||
            /subtitle|webvtt|_sdh_|_cc_|forced/i.test(url);
    }

    function isShortPreviewTrack(track) {
        var duration = Number(track && track.playlistDuration);
        return duration > 0 && duration < 90;
    }

    function looksLikePreviewTrack(track) {
        var text = ((track && track.NAME) || '') + ' ' + ((track && track.URI) || '') + ' ' + ((track && track.manifestUrl) || '');
        return isShortPreviewTrack(track) || /preview|trailer|background-video|autoplay|superhero|teaser|clip/i.test(text);
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
        String(text || '').replace(/(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})/g, function (_, start, end) {
            var seconds = vttTimestampSeconds(end);
            if (seconds > max) max = seconds;
            return _;
        });
        return max;
    }

    function vttTimestampSeconds(value) {
        var parts = String(value || '').split(':');
        if (parts.length !== 3) return 0;
        var hours = parseInt(parts[0], 10) || 0;
        var minutes = parseInt(parts[1], 10) || 0;
        var seconds = parseFloat(parts[2]) || 0;
        return hours * 3600 + minutes * 60 + seconds;
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
        var pendingSegmentDuration = null;
        var previousSegment = null;
        var pendingParts = [];
        var previousPart = null;
        var timelineSeconds = 0;
        var discontinuityOffset = 0;
        var pendingDiscontinuity = false;

        lines.forEach(function (rawLine) {
            var line = rawLine.trim();
            if (!line) return;

            if (/^#EXT-X-DISCONTINUITY$/i.test(line)) {
                pendingDiscontinuity = true;
                return;
            }

            var durationMatch = line.match(/^#EXTINF:([\d.]+)/i);
            if (durationMatch) {
                var segmentDuration = Number(durationMatch[1]);
                pendingSegmentDuration = isFinite(segmentDuration) && segmentDuration > 0 ? segmentDuration : null;
                return;
            }

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
                if (pendingDiscontinuity) {
                    discontinuityOffset = timelineSeconds;
                    pendingDiscontinuity = false;
                }
                var partEntry = {
                    url: partUrl,
                    map: currentMap,
                    byterange: partByteRange,
                    duration: partDuration,
                    discontinuityOffset: discontinuityOffset,
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
            if (isMediaPlaylist || /\.(?:vtt|webvtt)(?:[?#]|$)/i.test(line)) {
                // A completed Parent Segment contains the same media as its preceding PARTs.
                // Prefer the completed segment and retain PARTs only for the unfinished live edge.
                pendingParts = [];
                previousPart = null;
                var segmentUrl = absoluteUrl(line, baseUrl);
                var segmentByteRange = pendingByteRange === null ? null :
                    resolveHlsByteRange(pendingByteRange, segmentUrl, previousSegment);
                if (pendingDiscontinuity) {
                    discontinuityOffset = timelineSeconds;
                    pendingDiscontinuity = false;
                }
                entries.push({
                    url: segmentUrl,
                    map: currentMap,
                    byterange: segmentByteRange,
                    duration: pendingSegmentDuration,
                    discontinuityOffset: discontinuityOffset
                });
                previousSegment = {
                    url: segmentUrl,
                    byterange: segmentByteRange
                };
                pendingByteRange = null;
                if (pendingSegmentDuration !== null) timelineSeconds += pendingSegmentDuration;
                pendingSegmentDuration = null;
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

    function beginDownloadOperation(outputFilename) {
        var operation = {
            id: ++state.downloadOperationSequence,
            sessionId: state.playbackSessionId,
            baseFilename: safeBaseFilename(),
            outputFilename: outputFilename || '',
            progressCompleted: 0,
            progressTotal: 0
        };
        if (!operation.outputFilename) operation.outputFilename = operation.baseFilename + '.subtitles.zip';
        state.activeDownloadOperationId = operation.id;
        state.outputFilename = operation.baseFilename;
        state.progressCompleted = 0;
        state.progressTotal = 0;
        state.progressLabel = 'Preparing...';
        captureApple('download.started', operation.sessionId, function () {
            return {
                operationId: operation.id,
                baseFilename: operation.baseFilename,
                outputFilename: operation.outputFilename,
                trackCount: state.langs.length
            };
        });
        return operation;
    }

    function isDownloadOperationCurrent(operation) {
        return !!operation && operation.id === state.activeDownloadOperationId && isPlaybackSessionCurrent(operation.sessionId);
    }

    function assertDownloadOperationCurrent(operation) {
        if (!isDownloadOperationCurrent(operation)) throw new Error('Playback changed while downloading subtitles.');
    }

    function invalidateDownloadOperation() {
        var invalidatedOperationId = state.activeDownloadOperationId;
        if (invalidatedOperationId) {
            captureApple('download.invalidated', state.playbackSessionId, function () {
                return { operationId: invalidatedOperationId, reason: 'playback-session-change' };
            });
        }
        state.activeDownloadOperationId = 0;
        state.wait = false;
        state.downloadall = false;
        state.zip = null;
    }

    function finishDownloadOperation(operation) {
        if (!isDownloadOperationCurrent(operation)) return false;
        state.activeDownloadOperationId = 0;
        state.wait = false;
        state.downloadall = false;
        state.zip = null;
        return true;
    }

    function downloadAllTracks() {
        if (state.wait || state.langs.length === 0) return;
        var tracks = state.langs.slice();
        var baseFilename = safeBaseFilename();
        var operation = beginDownloadOperation(baseFilename + '.subtitles.zip');
        operation.baseFilename = baseFilename;
        var zip = new JSZip();
        state.downloadall = true;
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
            saveAs(blob, operation.baseFilename + '.subtitles.zip');
            state.status = 'Downloaded all subtitles.';
            state.progressLabel = 'Complete';
            captureApple('download.completed', operation.sessionId, function () {
                return { operationId: operation.id, outputFilename: operation.baseFilename + '.subtitles.zip' };
            });
        }).catch(function (err) {
            if (isDownloadOperationCurrent(operation)) {
                state.lastError = 'Download failed: ' + err.message;
                state.progressLabel = 'Failed';
                captureApple('download.failed', operation.sessionId, function () {
                    return { operationId: operation.id, errorCode: fixtureErrorCode(err) };
                });
            }
        }).then(function () {
            if (finishDownloadOperation(operation)) updateUi();
        });
    }

    function downloadTrack(track) {
        if (state.wait) return;
        var tracks = tracksWithForcedCompanion(track);
        var baseFilename = safeBaseFilename();
        var outputFilename = trackDownloadFilename(track, tracks, baseFilename);
        var operation = beginDownloadOperation(outputFilename);
        operation.baseFilename = baseFilename;
        state.wait = true;
        state.lastError = '';
        state.selectedTrackKey = track.key;
        state.status = 'Downloading ' + downloadTrackNames(tracks) + '...';
        updateUi();

        downloadTrackFiles(tracks, outputFilename, operation).then(function () {
            assertDownloadOperationCurrent(operation);
            state.status = 'Downloaded ' + downloadTrackNames(tracks) + '.';
            state.progressLabel = 'Complete';
            captureApple('download.completed', operation.sessionId, function () {
                return { operationId: operation.id, outputFilename: outputFilename };
            });
        }).catch(function (err) {
            if (isDownloadOperationCurrent(operation)) {
                state.lastError = 'Download failed: ' + err.message;
                state.progressLabel = 'Failed';
                captureApple('download.failed', operation.sessionId, function () {
                    return { operationId: operation.id, errorCode: fixtureErrorCode(err) };
                });
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

        var tracks = uniqueTracks(tracksWithForcedCompanion(english).concat(tracksWithForcedCompanion(korean)));
        var baseFilename = safeBaseFilename();
        var outputFilename = baseFilename + '.en-ko.subtitles.zip';
        var operation = beginDownloadOperation(outputFilename);
        operation.baseFilename = baseFilename;
        var zip = new JSZip();

        state.wait = true;
        state.lastError = '';
        state.status = 'Downloading English + Korean subtitles' + forcedSummary(tracks) + '...';
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
            saveAs(blob, operation.baseFilename + '.en-ko.subtitles.zip');
            state.status = 'Downloaded English + Korean subtitles' + forcedSummary(tracks) + '.';
            state.progressLabel = 'Complete';
            captureApple('download.completed', operation.sessionId, function () {
                return { operationId: operation.id, outputFilename: operation.baseFilename + '.en-ko.subtitles.zip' };
            });
        }).catch(function (err) {
            if (isDownloadOperationCurrent(operation)) {
                state.lastError = 'Download failed: ' + err.message;
                state.progressLabel = 'Failed';
                captureApple('download.failed', operation.sessionId, function () {
                    return { operationId: operation.id, errorCode: fixtureErrorCode(err) };
                });
            }
        }).then(function () {
            if (finishDownloadOperation(operation)) updateUi();
        });
    }

    function downloadTrackFiles(tracks, zipName, operation) {
        tracks = uniqueTracks(tracks);
        if (tracks.length === 1) {
            return buildSubtitleFile(tracks[0], operation).then(function (file) {
                assertDownloadOperationCurrent(operation);
                saveAs(new Blob([file.content], { type: 'text/vtt;charset=utf-8' }), file.name);
            });
        }

        var zip = new JSZip();
        return Promise.all(tracks.map(function (track) {
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
            saveAs(blob, zipName);
        });
    }

    function tracksWithForcedCompanion(track) {
        var tracks = [track];
        if (shouldIncludeForcedCompanion(track)) {
            var forced = findForcedTrackFor(track);
            if (forced) tracks.push(forced);
        }
        return uniqueTracks(tracks);
    }

    function shouldIncludeForcedCompanion(track) {
        if (!track || isForcedTrack(track)) return false;
        var language = languagePrimary(trackLanguage(track));
        return language === 'en' || language === 'ko';
    }

    function findForcedTrackFor(track) {
        var language = languagePrimary(trackLanguage(track));
        if (!language) return null;

        var candidates = state.langs.filter(function (candidate) {
            return candidate.key !== track.key &&
                isForcedTrack(candidate) &&
                languagePrimary(trackLanguage(candidate)) === language;
        });
        if (!candidates.length) return null;

        candidates.sort(function (a, b) {
            return trackScore(b, language) - trackScore(a, language) || a.NAME.localeCompare(b.NAME);
        });
        return candidates[0];
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

    function downloadTrackNames(tracks) {
        return uniqueTracks(tracks).map(function (track) {
            return track.NAME;
        }).join(' + ');
    }

    function forcedSummary(tracks) {
        return uniqueTracks(tracks).some(function (track) {
            return isForcedTrack(track);
        }) ? ' + forced' : '';
    }

    function buildSubtitleFile(track, operation) {
        assertDownloadOperationCurrent(operation);
        return getTrackVtt(track, operation).then(function (vtt) {
            assertDownloadOperationCurrent(operation);
            var output = normalizeVttForDownload(vtt);
            if (!output.trim()) throw new Error('No subtitle cues found.');
            var artifactId = captureAppleArtifact('subtitle-output', output, function () {
                return {
                    format: 'webvtt',
                    url: track.URI,
                    language: track.LANGUAGE || '',
                    forced: isForcedTrack(track)
                };
            });
            captureApple('download.file-built', operation.sessionId, function () {
                return {
                    operationId: operation.id,
                    artifact: artifactId || '',
                    filename: operation.baseFilename + '.' + safeTrackName(track) + '.vtt',
                    cueCount: countHlsVttCues(output)
                };
            });
            return {
                name: operation.baseFilename + '.' + safeTrackName(track) + '.vtt',
                content: output
            };
        });
    }

    function getTrackVtt(track, operation) {
        assertDownloadOperationCurrent(operation);
        state.progressLabel = 'Reading ' + track.NAME + ' playlist...';
        updateUi();
        return getText(track.URI).then(function (playlist) {
            assertDownloadOperationCurrent(operation);
            var directWebVtt = /^\s*WEBVTT/i.test(playlist || '');
            var hlsPlaylist = (playlist || '').indexOf('#EXTM3U') >= 0;
            var playlistProjection = fixtureCaptureRecording && hlsPlaylist ? fixtureManifestProjection(track.URI, playlist || '') : null;
            var playlistArtifactText = directWebVtt ? (playlist || '') : (playlistProjection && playlistProjection.relevant ? playlistProjection.text : '');
            var playlistArtifactId = playlistArtifactText ? captureAppleArtifact('subtitle-playlist', playlistArtifactText, function () {
                return {
                    format: directWebVtt ? 'webvtt' : 'm3u8',
                    url: track.URI,
                    projected: !!(playlistProjection && playlistProjection.projected),
                    originalLineCount: playlistProjection ? playlistProjection.originalLineCount : 0,
                    projectedLineCount: playlistProjection ? playlistProjection.projectedLineCount : 0
                };
            }) : null;
            captureApple('artifact.loaded', operation.sessionId, function () {
                return {
                    kind: 'subtitle-playlist',
                    artifact: playlistArtifactId || '',
                    recognized: directWebVtt || hlsPlaylist,
                    projected: !!(playlistProjection && playlistProjection.projected),
                    responseKind: directWebVtt ? 'webvtt' : (hlsPlaylist ? 'hls' : 'unrecognized-response'),
                    url: track.URI
                };
            });
            if (/^\s*WEBVTT/i.test(playlist)) {
                addDownloadProgressTotal(operation, 1, 'Downloading ' + track.NAME + '...');
                advanceDownloadProgress(operation, 'Downloading ' + track.NAME + '...');
                return playlist;
            }

            var duration = playlistDurationSeconds(playlist) || subtitleTextDurationSeconds(playlist);
            if (duration && !track.playlistDuration) track.playlistDuration = duration;
            var segments = extractHlsSegmentEntries(playlist, track.URI);
            if (!segments.length && track.segments && track.segments.length) {
                segments = track.segments.map(function (url) { return { url: url, map: null }; });
            }
            if (!segments.length) throw new Error('No VTT segments found for ' + track.NAME + '.');
            addDownloadProgressTotal(operation, segments.length, 'Downloading ' + track.NAME + ' segments...');

            var merged = '';
            var headerState = createHlsVttHeaderState();
            var timestampState = createHlsTimestampState();
            var mapCache = {};
            var seenBlocks = {};
            var failedSegments = [];
            var cueCount = 0;
            return runSequential(segments, function (segment) {
                assertDownloadOperationCurrent(operation);
                return Promise.all([
                    getHlsResourceText(segment.url, segment.byterange),
                    getHlsInitText(segment.map, mapCache)
                ]).then(function (values) {
                    collectHlsVttHeaderMetadata(values[1], headerState);
                    collectHlsVttHeaderMetadata(values[0], headerState);
                    var cleaned = normalizeHlsVttSegment(values[0], timestampState, values[1], segment.discontinuityOffset);
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
        });
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

    function normalizeHlsVttSegment(text, timestampState, initText, discontinuityOffset) {
        var value = String(text || '').replace(/\r\n|\r/g, '\n');
        var initValue = String(initText || '').replace(/\r\n|\r/g, '\n');
        var timestampMap = parseHlsTimestampMap(value) || parseHlsTimestampMap(initValue);
        var shiftSeconds = 0;
        if (timestampMap) {
            var offsetSeconds = timestampMap.mpegTimestamp / 90000 - timestampMap.localSeconds;
            if (timestampState.baseOffsetSeconds === null) {
                timestampState.baseOffsetSeconds = offsetSeconds;
            }
            shiftSeconds = normalizeHlsTimestampOffset(offsetSeconds - timestampState.baseOffsetSeconds);
        } else {
            var fallbackOffset = Number(discontinuityOffset);
            if (isFinite(fallbackOffset) && fallbackOffset > 0) shiftSeconds = fallbackOffset;
        }
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

    function isInvisibleHlsVttCueBlock(block) {
        var lines = String(block || '').split(/\r\n|\r|\n/);
        var timingIndex = -1;
        for (var i = 0; i < lines.length; i++) {
            if (lines[i].indexOf('-->') >= 0) {
                timingIndex = i;
                break;
            }
        }
        if (timingIndex < 0) return false;
        var payload = lines.slice(timingIndex + 1).join('\n')
            .replace(/<[^>]*>/g, '')
            .replace(/[\s\u200B\u200C\u200D\u2060\uFEFF]/g, '');
        return payload.length === 0;
    }

    function uniqueHlsVttBody(text, seenBlocks) {
        var output = [];
        String(text || '').replace(/\r\n|\r/g, '\n').split(/\n{2,}/).forEach(function (block) {
            block = block.trim();
            if (!block || seenBlocks[block] || isInvisibleHlsVttCueBlock(block)) return;
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
        if (!/^\s*WEBVTT\b/i.test(text)) {
            text = 'WEBVTT\n\n' + cleanVttSegment(text).trim();
        }

        return text.replace(/\n/g, '\r\n') + '\r\n';
    }

    function vttToSrt(vtt) {
        var blocks = cleanVttSegment(vtt).replace(/\r/g, '').split(/\n{2,}/);
        var output = [];
        var index = 1;

        blocks.forEach(function (block) {
            var lines = block.split('\n').map(function (line) { return line.trim(); }).filter(Boolean);
            if (!lines.length) return;
            if (/^(NOTE|STYLE|REGION)\b/i.test(lines[0])) return;

            var timingIndex = -1;
            for (var i = 0; i < lines.length; i++) {
                if (lines[i].indexOf('-->') >= 0) {
                    timingIndex = i;
                    break;
                }
            }
            if (timingIndex < 0) return;

            var timing = normalizeTiming(lines[timingIndex]);
            var text = lines.slice(timingIndex + 1).map(stripVttTags).join('\n').trim();
            if (!timing || !text) return;

            output.push(String(index++));
            output.push(timing);
            output.push(text);
            output.push('');
        });

        return output.join('\r\n');
    }

    function normalizeTiming(line) {
        var parts = line.split(/\s+-->\s+/);
        if (parts.length < 2) return '';
        var start = normalizeTimestamp(parts[0]);
        var end = normalizeTimestamp(parts[1].split(/\s+/)[0]);
        return start && end ? start + ' --> ' + end : '';
    }

    function normalizeTimestamp(value) {
        value = value.trim();
        var short = value.match(/^(\d{2}):(\d{2})\.(\d{3})$/);
        if (short) return '00:' + short[1] + ':' + short[2] + ',' + short[3];
        var long = value.match(/^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/);
        if (long) return long[1] + ':' + long[2] + ':' + long[3] + ',' + long[4];
        return value.replace('.', ',');
    }

    function stripVttTags(line) {
        return line
            .replace(/<\/?c(?:\.[^>]*)?>/g, '')
            .replace(/<[^>]+>/g, '')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'");
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

    function getText(url, retryCount) {
        retryCount = retryCount || 0;
        return new Promise(function (resolve, reject) {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                onload: function (response) {
                    if (response.status >= 200 && response.status < 300) {
                        resolve(response.responseText || '');
                        return;
                    }
                    if (shouldRetryHttpStatus(response.status) && scheduleRetry(retryCount, response.responseHeaders, function () {
                        return getText(url, retryCount + 1);
                    }, resolve, reject)) return;
                    reject(new Error('HTTP ' + response.status + ' for ' + shortUrl(url)));
                },
                onerror: function () {
                    if (scheduleRetry(retryCount, '', function () {
                        return getText(url, retryCount + 1);
                    }, resolve, reject)) return;
                    reject(new Error('Network error for ' + shortUrl(url)));
                },
                ontimeout: function () {
                    if (scheduleRetry(retryCount, '', function () {
                        return getText(url, retryCount + 1);
                    }, resolve, reject)) return;
                    reject(new Error('Timeout for ' + shortUrl(url)));
                }
            });
        });
    }

    function runSequential(items, worker) {
        return items.reduce(function (promise, item) {
            return promise.then(function () { return worker(item); });
        }, Promise.resolve());
    }

    function performanceNow() {
        try {
            var perf = targetWindow.performance || window.performance;
            if (perf && typeof perf.now === 'function') return perf.now();
        } catch (err) {}
        return 0;
    }

    function normalizeUrl(rawUrl) {
        if (!rawUrl) return '';
        var value = String(rawUrl);
        if (value.indexOf('http') !== 0) return '';
        return value;
    }

    function absoluteUrl(url, baseUrl) {
        try { return new URL(url, baseUrl).href; } catch (err) { return url; }
    }

    function safeBaseFilename() {
        var playbackTitle = activePlaybackTitle();
        var playbackText = activePlaybackInfoText();
        refreshMediaMetadataFromDom();
        var title = playbackTitle || state.mediaTitle || displayTitle();
        var episodeTag = seasonEpisodeTag(playbackText) || state.episodeTag ||
            (playbackText ? '' : seasonEpisodeTag(playbackInfoText()));
        if (episodeTag && title.toUpperCase().indexOf(episodeTag) < 0) {
            title += '.' + episodeTag;
        }
        var filename = sanitizeFilename(title);
        captureAppleSnapshot('filename.resolved', state.playbackSessionId, function () {
            return {
                filename: filename,
                title: title,
                episodeTag: episodeTag || '',
                metadata: fixtureMetadataState()
            };
        });
        return filename;
    }

    function displayTitle() {
        var candidates = [
            metaContent('og:title'),
            metaContent('twitter:title'),
            document.title || ''
        ];
        var fallback = '';
        for (var i = 0; i < candidates.length; i++) {
            if (!candidates[i]) continue;
            var title = cleanDisplayTitle(candidates[i]);
            if (!fallback) fallback = title;
            if (!isGenericMediaTitle(title)) return title;
        }
        return fallback || 'AppleTVPlus';
    }

    function cleanDisplayTitle(title) {
        return String(title || 'AppleTVPlus')
            .replace(/[\u200e\u200f]/g, '')
            .replace(/\u00a0/g, ' ')
            .replace(/\s*보기\s*-\s*Apple.*$/i, '')
            .replace(/\s*-\s*Apple.*$/i, '')
            .replace(/\s*\|\s*Apple.*$/i, '')
            .replace(/\bS\d{1,2}E\d{1,3}\b/ig, '')
            .replace(/\s+/g, ' ')
            .trim() || 'AppleTVPlus';
    }

    function seasonEpisodeTag(text) {
        text = text || playbackInfoText();
        var match;
        var patterns = [
            /\bS(?:eason)?\s*(\d{1,2})\s*[:._ -]*E(?:p(?:isode)?)?\s*(\d{1,3})\b/i,
            /\bSeason\s*(\d{1,2}).{0,24}\bEpisode\s*(\d{1,3})\b/i,
            /\bSeason\s*(\d{1,2}).{0,24}\bEp\.?\s*(\d{1,3})\b/i,
            /\uC2DC\uC98C\s*(\d{1,2}).{0,24}?\uC5D0\uD53C\uC18C\uB4DC\s*(\d{1,3})/i,
            /\uC2DC\uC98C\s*(\d{1,2})\s*[:._ -]*(\d{1,3})\s*(?:\uD68C|\uD654|\uC5D0\uD53C\uC18C\uB4DC)/i,
            /(\d{1,2})\s*\uC2DC\uC98C.{0,24}(\d{1,3})\s*(?:\uD68C|\uD654|\uC5D0\uD53C\uC18C\uB4DC)/i
        ];

        for (var i = 0; i < patterns.length; i++) {
            match = text.match(patterns[i]);
            if (match) return formatSeasonEpisode(match[1], match[2]);
        }

        return '';
    }

    function playbackInfoText() {
        var parts = [
            document.title || '',
            metaContent('og:title'),
            metaContent('twitter:title'),
            metaContent('description'),
            document.body ? document.body.innerText : ''
        ];

        try {
            Array.prototype.slice.call(document.querySelectorAll('[aria-label],[title]'), 0, 200).forEach(function (node) {
                parts.push(node.getAttribute('aria-label') || '');
                parts.push(node.getAttribute('title') || '');
            });
        } catch (err) {}

        return parts.filter(Boolean).join('\n');
    }

    function metaContent(name) {
        var node = document.querySelector('meta[property="' + name + '"],meta[name="' + name + '"]');
        return node ? node.getAttribute('content') || '' : '';
    }

    function formatSeasonEpisode(season, episode) {
        return 'S' + padNumber(season, 2) + 'E' + padNumber(episode, 2);
    }

    function padNumber(value, size) {
        var text = String(parseInt(value, 10) || 0);
        while (text.length < size) text = '0' + text;
        return text;
    }

    function safeTrackName(track) {
        var name = trackLanguage(track) || track.LANGUAGE || track.NAME || 'subtitle';
        if (isCcTrack(track) && !/\bcc\b/i.test(name)) name += '_cc';
        if (isForcedTrack(track) && !/forced/i.test(name)) name += '_forced';
        return sanitizeFilename(String(name).replace(/\s+/g, '_'));
    }

    function sanitizeFilename(value) {
        return String(value || 'subtitle')
            .replace(/[\\/:*?"<>|]+/g, '_')
            .replace(/\s+/g, ' ')
            .replace(/_+/g, '_')
            .trim()
            .slice(0, 120) || 'subtitle';
    }

    function shortUrl(url) {
        return String(url).slice(0, 96);
    }

    function debuglog(message) {
        if (debug) console.log(LOG_PREFIX + ' ' + message);
    }
})();
