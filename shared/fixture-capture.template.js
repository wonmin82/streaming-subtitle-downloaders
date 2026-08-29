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
