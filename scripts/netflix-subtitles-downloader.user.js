// ==UserScript==
// @name       Netflix Subtitles Downloader
// @namespace  https://github.com/wonmin82/streaming-subtitle-downloaders
// @description Download subtitles from Netflix
// @version    1.0.13
// @author     Tithen-Firion; modifications by Wonmin Jung
// @license    MIT
// @homepageURL https://github.com/wonmin82/streaming-subtitle-downloaders
// @downloadURL https://raw.githubusercontent.com/wonmin82/streaming-subtitle-downloaders/main/scripts/netflix-subtitles-downloader.user.js
// @updateURL  https://raw.githubusercontent.com/wonmin82/streaming-subtitle-downloaders/main/scripts/netflix-subtitles-downloader.user.js
// @match      https://www.netflix.com/*
// @grant      GM_info
// @grant      GM_registerMenuCommand
// @grant      GM_unregisterMenuCommand
// @grant      unsafeWindow
// @require    https://cdn.jsdelivr.net/npm/jszip@3.7.1/dist/jszip.min.js
// @require    https://cdn.jsdelivr.net/npm/file-saver@2.0.5/dist/FileSaver.min.js
// @run-at     document-start
// ==/UserScript==

class ProgressBar {
  constructor(max) {
    this.current = 0;
    this.max = max;

    let container = document.querySelector('#userscript_progress_bars');
    if(container === null) {
      container = document.createElement('div');
      container.id = 'userscript_progress_bars'
      document.body.appendChild(container)
      container.style
      container.style.position = 'fixed';
      container.style.top = 0;
      container.style.left = 0;
      container.style.width = '100%';
      container.style.background = 'red';
      container.style.zIndex = '99999999';
    }

    this.progressElement = document.createElement('div');
    this.progressElement.innerHTML = 'Click to stop';
    this.progressElement.style.cursor = 'pointer';
    this.progressElement.style.fontSize = '16px';
    this.progressElement.style.textAlign = 'center';
    this.progressElement.style.width = '100%';
    this.progressElement.style.height = '20px';
    this.progressElement.style.background = 'transparent';
    this.stop = new Promise(resolve => {
      this.progressElement.addEventListener('click', () => {resolve(STOP_THE_DOWNLOAD)});
    });

    container.appendChild(this.progressElement);
    setMenuDownloadProgress(0, max, 'Downloading subtitle tracks...', true);
  }

  increment() {
    this.current += 1;
    if(this.current <= this.max) {
      let p = this.current / this.max * 100;
      this.progressElement.style.background = `linear-gradient(to right, green ${p}%, transparent ${p}%)`;
    }
    setMenuDownloadProgress(this.current, this.max, 'Downloading subtitle tracks...', true);
  }

  destroy() {
    this.progressElement.remove();
  }
}

const STOP_THE_DOWNLOAD = 'NETFLIX_SUBTITLE_DOWNLOADER_STOP_THE_DOWNLOAD';
const DOWNLOAD_TIMEOUT = 'NETFLIX_SUBTITLE_DOWNLOADER_DOWNLOAD_TIMEOUT';

const WEBVTT = 'webvtt-lssdh-ios8';
const DFXP = 'dfxp-ls-sdh';
const SIMPLE = 'simplesdh';
const IMSC1_1 = 'imsc1.1';
const ALL_FORMATS = [IMSC1_1, DFXP, WEBVTT, SIMPLE];
const ALL_FORMATS_prefer_vtt = [WEBVTT, IMSC1_1, DFXP, SIMPLE];

const FORMAT_NAMES = {};
FORMAT_NAMES[WEBVTT] = 'WebVTT';
FORMAT_NAMES[DFXP] = 'IMSC1.1/DFXP/XML';

const EXTENSIONS = {};
EXTENSIONS[WEBVTT] = 'vtt';
EXTENSIONS[DFXP] = 'dfxp';
EXTENSIONS[SIMPLE] = 'xml';
EXTENSIONS[IMSC1_1] = 'xml';

const DOWNLOAD_MENU = `
<ol>
<li class="header">Netflix subtitle downloader</li>
<li class="download">Download subs for this <span class="series">episode</span><span class="not-series">movie</span></li>
<li class="download-to-end series">Download subs from this ep till last available</li>
<li class="download-season series">Download subs for this season</li>
<li class="download-all series">Download subs for all seasons</li>
<li class="ep-title-in-filename">Add episode title to filename: <span></span></li>
<li class="force-all-lang">Force Netflix to show all languages: <span></span></li>
<li class="pref-locale">Preferred locale: <span></span></li>
<li class="lang-setting">Languages to download: <span></span></li>
<li class="sub-format">Subtitle format: prefer <span></span></li>
<li class="download-info output-filename">Output file: <span>Waiting for title metadata...</span></li>
<li class="download-info download-progress">Progress: <span>Idle</span><progress max="1" value="0"></progress></li>
<li class="batch-delay">Batch delay: <span></span></li>
</ol>
`;

const SCRIPT_CSS = `
#subtitle-downloader-menu {
  position: absolute;
  display: none;
  width: 300px;
  top: 0;
  left: calc( 50% - 150px );
}
#subtitle-downloader-menu ol {
  list-style: none;
  position: relative;
  width: 300px;
  background: #333;
  color: #fff;
  padding: 0;
  margin: auto;
  font-size: 12px;
  z-index: 99999998;
}
body:hover #subtitle-downloader-menu { display: block; }
#subtitle-downloader-menu li { padding: 10px; }
#subtitle-downloader-menu li.header { font-weight: bold; }
#subtitle-downloader-menu li:not(.header):hover { background: #666; }
#subtitle-downloader-menu li:not(.header) {
  display: none;
  cursor: pointer;
}
#subtitle-downloader-menu:hover li { display: block; }
#subtitle-downloader-menu li.download-info { cursor: default; }
#subtitle-downloader-menu li.download-info:hover { background: transparent; }
#subtitle-downloader-menu .output-filename span { color: #ddd; word-break: break-word; }
#subtitle-downloader-menu .download-progress progress { width: 100%; height: 10px; margin-top: 6px; accent-color: #e50914; }

#subtitle-downloader-menu:not(.series) .series{ display: none; }
#subtitle-downloader-menu.series .not-series{ display: none; }
`;

const SUB_TYPES = {
  'subtitles': '',
  'closedcaptions': '[cc]'
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

let idOverrides = {};
let subCache = {};
let titleCache = {};
let domDerivedTitleIds = {};
let subCacheWaitGeneration = 0;
let batchDownloadInProgress = false;
let downloadUiState = {
  active: false,
  filename: '',
  completed: 0,
  total: 0,
  label: 'Idle'
};
let lastPlaybackUiMetadata = null;

let batch = null;
try {
  batch = JSON.parse(sessionStorage.getItem('NSD_batch'));
}
catch(ignore) {}

let batchAll = null;
let batchSeason = null;
let batchToEnd = null;

let epTitleInFilename = localStorage.getItem('NSD_ep-title-in-filename') === 'true';
let forceSubs = localStorage.getItem('NSD_force-all-lang') !== 'false';
let prefLocale = localStorage.getItem('NSD_pref-locale') || '';
let langs = localStorage.getItem('NSD_lang-setting') || '';
let subFormat = localStorage.getItem('NSD_sub-format') || WEBVTT;
let batchDelay = parseFloat(localStorage.getItem('NSD_batch-delay') || '0');

const FIXTURE_CAPTURE_ARM_KEY = 'ssd:fixture-capture:netflix:armed-until';
const FIXTURE_CAPTURE_ARM_TTL_MS = 2 * 60 * 1000;
const fixtureCaptureEnabled = consumeFixtureCaptureArm();
const fixtureCapture = fixtureCaptureEnabled ? createFixtureCapture({
  service: 'netflix',
  scriptVersion: currentUserscriptVersion(),
  page: {
    host: location.host,
    path: /^\/watch\//.test(location.pathname || '') ? '/watch/TOKEN_1' : '/'
  },
  Blob: typeof Blob === 'function' ? Blob : null
}) : null;
let fixtureCaptureRecording = false;
let fixtureCaptureMenuCommandIds = [];
let fixtureSnapshotValues = fixtureCaptureEnabled ? Object.create(null) : null;
let fixtureArtifactCache = fixtureCaptureEnabled ? [] : null;
let fixtureSessionSequence = 0;
let fixtureSessionId = '';
let fixtureVideoKey = '';
let fixtureLastMetadata = null;
let fixtureLastTrackCatalog = [];
let fixtureLastFilename = '';
let fixtureDownloadSequence = 0;
let fixtureActiveDownloadOperation = null;

function currentUserscriptVersion() {
  try {
    if(typeof GM_info === 'object' && GM_info && GM_info.script &&
       typeof GM_info.script.version === 'string' && GM_info.script.version)
      return GM_info.script.version;
  }
  catch(ignore) {}
  return 'unknown';
}

function consumeFixtureCaptureArm() {
  try {
    if(window.top !== window)
      return false;
    const rawExpiry = window.sessionStorage.getItem(FIXTURE_CAPTURE_ARM_KEY);
    if(!rawExpiry)
      return false;
    window.sessionStorage.removeItem(FIXTURE_CAPTURE_ARM_KEY);
    const expiresAt = Number(rawExpiry);
    const remainingMs = expiresAt - Date.now();
    return Number.isFinite(expiresAt) && remainingMs >= 0 && remainingMs <= FIXTURE_CAPTURE_ARM_TTL_MS;
  }
  catch(ignore) {
    return false;
  }
}

function armFixtureCaptureAndReload() {
  try {
    if(window.top !== window)
      return false;
    window.sessionStorage.setItem(FIXTURE_CAPTURE_ARM_KEY, String(Date.now() + FIXTURE_CAPTURE_ARM_TTL_MS));
    location.reload();
    return true;
  }
  catch(ignore) {
    return false;
  }
}

function installFixtureCaptureCommands(skipAutoStart) {
  try {
    if(window.top !== window)
      return;
  }
  catch(ignore) {
    return;
  }

  if(!skipAutoStart && fixtureCapture)
    startFixtureCapture('menu-armed-reload');
  if(typeof GM_registerMenuCommand !== 'function')
    return;

  try {
    if(typeof GM_unregisterMenuCommand === 'function') {
      fixtureCaptureMenuCommandIds.forEach(commandId => {
        try { GM_unregisterMenuCommand(commandId); }
        catch(ignore) {}
      });
    }
    fixtureCaptureMenuCommandIds = [];

    const registerCommand = (label, handler) => {
      const commandId = GM_registerMenuCommand(label, handler);
      if(commandId !== undefined && commandId !== null)
        fixtureCaptureMenuCommandIds.push(commandId);
    };

    if(!fixtureCaptureRecording) {
      registerCommand('[Fixture] Start capture and reload this tab', armFixtureCaptureAndReload);
      return;
    }

    registerCommand('[Fixture] Start/restart capture', () => {
      startFixtureCapture('menu-restart');
      installFixtureCaptureCommands(true);
      printFixtureCaptureStatus();
    });
    registerCommand('[Fixture] Stop and export', () => exportFixtureCapture(true));
    registerCommand('[Fixture] Export snapshot', () => exportFixtureCapture(false));
    registerCommand('[Fixture] Clear capture', () => {
      fixtureCapture.clear();
      fixtureCaptureRecording = false;
      resetFixtureCaptureAdapterState();
      installFixtureCaptureCommands(true);
      printFixtureCaptureStatus();
    });
    registerCommand('[Fixture] Print status', printFixtureCaptureStatus);
  }
  catch(ignore) {}
}

function resetFixtureCaptureAdapterState() {
  fixtureSnapshotValues = fixtureCaptureEnabled ? Object.create(null) : null;
  fixtureArtifactCache = fixtureCaptureEnabled ? [] : null;
  fixtureSessionSequence = 0;
  fixtureSessionId = '';
  fixtureVideoKey = '';
  fixtureLastMetadata = null;
  fixtureLastTrackCatalog = [];
  fixtureLastFilename = '';
  fixtureDownloadSequence = 0;
  fixtureActiveDownloadOperation = null;
}

function startFixtureCapture(reason) {
  if(!fixtureCapture)
    return false;
  try {
    fixtureCapture.clear();
    resetFixtureCaptureAdapterState();
    fixtureCaptureRecording = fixtureCapture.start({reason: reason || 'manual'});
    if(fixtureCaptureRecording) {
      syncFixturePlaybackSession('capture-start');
      captureNetflixSnapshot('configuration', () => fixtureConfigurationState());
    }
    return fixtureCaptureRecording;
  }
  catch(ignore) {
    fixtureCaptureRecording = false;
    return false;
  }
}

function exportFixtureCapture(stopFirst) {
  if(!fixtureCapture)
    return;
  try {
    if(fixtureCaptureRecording) {
      if(stopFirst) {
        fixtureCapture.stop(fixtureSafeCaptureValue(fixtureObservedState(), 'observed', 0));
        fixtureCaptureRecording = false;
        installFixtureCaptureCommands(true);
      }
      else {
        fixtureCapture.setObserved(fixtureSafeCaptureValue(fixtureObservedState(), 'observed', 0));
      }
    }
    const blob = fixtureCapture.exportBlob(true);
    if(!blob) {
      printFixtureCaptureStatus();
      return;
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    saveAs(blob, 'netflix-' + timestamp + '.fixture.local.json');
    printFixtureCaptureStatus();
  }
  catch(ignore) {}
}

function printFixtureCaptureStatus() {
  if(!fixtureCapture)
    return;
  try {
    console.info('[Netflix Subtitle Downloader] Fixture capture status ' + JSON.stringify(fixtureCapture.status()));
  }
  catch(ignore) {}
}

function fixtureCurrentVideoKey() {
  const parts = String(location.pathname || '').split('/');
  return parts[1] === 'watch' ? String(parts[parts.length - 1] || '') : '';
}

function syncFixturePlaybackSession(reason) {
  if(!fixtureCaptureRecording || !fixtureCapture)
    return '';
  const videoKey = fixtureCurrentVideoKey();
  if(videoKey === fixtureVideoKey && fixtureSessionId)
    return fixtureSessionId;

  if(fixtureSessionId) {
    fixtureCapture.event('session.invalidated', {
      reason: reason || 'navigation',
      hadPlayback: !!fixtureVideoKey
    }, {session: fixtureSessionId});
  }

  fixtureVideoKey = videoKey;
  fixtureLastMetadata = null;
  fixtureLastTrackCatalog = [];
  fixtureLastFilename = '';
  fixtureSnapshotValues = Object.create(null);
  fixtureSessionId = 'netflix-session-' + (++fixtureSessionSequence);
  fixtureCapture.event('navigation.changed', {
    playback: !!videoKey,
    path: videoKey ? '/watch/TOKEN_1' : '/'
  }, {session: fixtureSessionId});
  fixtureCapture.event('session.started', {
    reason: reason || 'navigation',
    playback: !!videoKey
  }, {session: fixtureSessionId});
  return fixtureSessionId;
}

function captureNetflix(type, payloadFactory) {
  if(!fixtureCaptureRecording || !fixtureCapture)
    return false;
  try {
    const sessionId = syncFixturePlaybackSession('observation');
    const payload = typeof payloadFactory === 'function' ? payloadFactory() : (payloadFactory || {});
    return fixtureCapture.event(type, fixtureSafeCaptureValue(payload, 'event', 0), {session: sessionId});
  }
  catch(ignore) {
    return false;
  }
}

function captureNetflixSnapshot(kind, payloadFactory) {
  if(!fixtureCaptureRecording || !fixtureCapture)
    return false;
  try {
    const sessionId = syncFixturePlaybackSession('snapshot');
    const payload = fixtureSafeCaptureValue(
      typeof payloadFactory === 'function' ? payloadFactory() : (payloadFactory || {}),
      'snapshot', 0
    );
    const dedupeKey = sessionId + '\n' + JSON.stringify(payload);
    if(fixtureSnapshotValues[kind] === dedupeKey)
      return false;
    fixtureSnapshotValues[kind] = dedupeKey;
    return fixtureCapture.snapshot(kind, payload, {session: sessionId});
  }
  catch(ignore) {
    return false;
  }
}

function captureNetflixArtifact(kind, text, metadataFactory, cacheable) {
  if(!fixtureCaptureRecording || !fixtureCapture || typeof text !== 'string' || !text)
    return null;
  try {
    if(fixtureArtifactHasCriticalRisk(text))
      return null;
    if(cacheable && fixtureArtifactCache) {
      const cached = fixtureArtifactCache.find(entry => entry.kind === kind && entry.text === text);
      if(cached)
        return cached.artifact;
    }
    const metadata = fixtureSafeCaptureValue(
      typeof metadataFactory === 'function' ? metadataFactory() : (metadataFactory || {}),
      'artifactMetadata', 0
    );
    const artifact = fixtureCapture.artifact(kind, text, metadata);
    if(artifact && cacheable && fixtureArtifactCache)
      fixtureArtifactCache.push({kind, text, artifact});
    return artifact;
  }
  catch(ignore) {
    return null;
  }
}

function fixtureSafeCaptureValue(value, key, depth) {
  if(value == null || typeof value === 'boolean' || typeof value === 'number')
    return value;
  if(typeof value === 'string') {
    if(fixtureCriticalString(value, key))
      return /(?:url|uri|href|src|manifest|playlist)/i.test(key || '') || /^(?:https?:)?\/\//i.test(value) ? 'REDACTED_URL' : 'REDACTED';
    return value;
  }
  if(typeof value !== 'object' || depth >= 12)
    return null;
  if(Array.isArray(value))
    return value.slice(0, 200).map(item => fixtureSafeCaptureValue(item, key, depth + 1));

  const result = Object.create(null);
  Object.keys(value).slice(0, 200).forEach(property => {
    result[property] = fixtureSafeCaptureValue(value[property], property, depth + 1);
  });
  return result;
}

function fixtureCriticalString(value, key) {
  const string = String(value == null ? '' : value);
  if(!string)
    return false;
  if(/(?:authorization|cookies?|set-cookie)/i.test(String(key || '')) && string !== 'REDACTED')
    return true;
  if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(string))
    return true;
  if(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+=\/-]{8,}/i.test(string))
    return true;
  if(/\bAKIA[0-9A-Z]{16}\b/.test(string) || /\bgh[pousr]_[A-Za-z0-9]{20,}\b/.test(string))
    return true;
  if(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(string))
    return true;
  if(!/\s/.test(string) && /^(?:[A-Za-z0-9+/]{256,}={0,2})$/.test(string))
    return true;
  if(/\/(?:drm|license|licenses|widevine|fairplay|playready|certificate|cert)(?:\/|[?#]|$)/i.test(string))
    return true;
  return false;
}

function fixtureArtifactHasCriticalRisk(text) {
  if(typeof text !== 'string' || !text)
    return false;
  if(fixtureCriticalString(text, 'artifact'))
    return true;
  return /(?:^|["'=\s>])[A-Za-z0-9+/]{256,}={0,2}(?:$|["'<\s])/m.test(text);
}

function fixtureConfigurationState() {
  return {
    episodeTitleInFilename: !!epTitleInFilename,
    forceAllLanguages: !!forceSubs,
    preferredLocale: prefLocale || '',
    languages: langs ? langs.split(',').map(value => value.trim()).filter(Boolean).slice(0, 50) : [],
    preferredFormat: subFormat || '',
    batchDelay: Number.isFinite(batchDelay) ? batchDelay : 0
  };
}

function fixtureTitleSummary(title) {
  title = title || {};
  return {
    type: title.type || '',
    title: title.title || '',
    season: positiveFixtureNumber(title.season),
    episode: positiveFixtureNumber(title.episode),
    subtitle: title.subtitle || '',
    hiddenNumber: !!title.hiddenNumber
  };
}

function positiveFixtureNumber(value) {
  const number = parseInt(value, 10);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function fixtureTrackCatalogSummary(subs) {
  if(!subs || typeof subs !== 'object')
    return [];
  return Object.keys(subs).slice(0, 200).map(language => {
    const formats = subs[language] || {};
    return {
      language,
      formats: Object.keys(formats).slice(0, 20).map(format => {
        const candidate = formats[format];
        return {
          formatProfile: format,
          mirrorCount: Array.isArray(candidate) && Array.isArray(candidate[0]) ? candidate[0].length : 0,
          extension: Array.isArray(candidate) ? candidate[1] || '' : ''
        };
      })
    };
  });
}

function fixtureObservedState() {
  return {
    metadata: fixtureLastMetadata,
    outputFilename: fixtureLastFilename || downloadUiState.filename || '',
    progress: {
      active: !!downloadUiState.active,
      completed: downloadUiState.completed,
      total: downloadUiState.total,
      label: downloadUiState.label || ''
    },
    tracks: fixtureLastTrackCatalog,
    batch: {
      active: Array.isArray(batch),
      remaining: Array.isArray(batch) ? batch.length : 0,
      allCount: Array.isArray(batchAll) ? batchAll.length : 0,
      seasonCount: Array.isArray(batchSeason) ? batchSeason.length : 0,
      toEndCount: Array.isArray(batchToEnd) ? batchToEnd.length : 0
    }
  };
}

function fixtureMetadataProjection(data) {
  if(!fixtureCaptureRecording || !data || typeof data !== 'object' || !data.video)
    return '';
  const video = data.video;
  const tokens = new Map();
  let tokenSequence = 0;
  let episodeTitleSequence = 0;
  const token = value => {
    const key = String(value == null ? '' : value);
    if(!key)
      return '';
    if(!tokens.has(key))
      tokens.set(key, 'TOKEN_' + (++tokenSequence));
    return tokens.get(key);
  };
  const type = /^(?:show|movie|supplemental)$/.test(String(video.type || '')) ? String(video.type) : 'unknown';
  const projection = {
    video: {
      type,
      title: type === 'show' ? 'SHOW_001' : 'TITLE_001',
      id: token(video.id),
      currentEpisode: token(video.currentEpisode),
      seasons: []
    }
  };
  if(type === 'show' && Array.isArray(video.seasons)) {
    projection.video.seasons = video.seasons.slice(0, 50).map(season => ({
      seq: positiveFixtureNumber(season && season.seq),
      episodes: Array.isArray(season && season.episodes) ? season.episodes.slice(0, 200).map(episode => ({
        seq: positiveFixtureNumber(episode && episode.seq),
        id: token(episode && episode.id),
        title: 'TEXT_' + String(++episodeTitleSequence).padStart(3, '0'),
        hiddenEpisodeNumbers: !!(episode && episode.hiddenEpisodeNumbers)
      })) : []
    }));
  }
  return JSON.stringify(projection, null, 2);
}

function fixtureSubtitleCatalogProjection(result) {
  if(!fixtureCaptureRecording || !result || typeof result !== 'object')
    return '';
  const tracks = result.timedtexttracks || result.textTracks;
  if(!Array.isArray(tracks))
    return '';
  let urlSequence = 0;
  const placeholderUrl = () => 'URL_' + String(++urlSequence).padStart(3, '0');
  const projectedTracks = tracks.slice(0, 200).map(track => {
    track = track || {};
    const projected = {
      language: /^[A-Za-z]{2,3}(?:[-_][A-Za-z]{2})?$/.test(String(track.language || '')) ? String(track.language) : 'und',
      rawTrackType: /^(?:subtitles|closedcaptions)$/.test(String(track.rawTrackType || '')) ? String(track.rawTrackType) : 'other',
      isForcedNarrative: !!track.isForcedNarrative,
      isNoneTrack: !!track.isNoneTrack,
      ttDownloadables: {}
    };
    if(typeof track.trackVariant !== 'undefined') {
      projected.trackVariant = /^[A-Za-z0-9._-]{0,40}$/.test(String(track.trackVariant || '')) ?
        String(track.trackVariant || '') : 'VARIANT';
    }
    const downloadables = track.ttDownloadables || track.downloadables || {};
    ALL_FORMATS.forEach(format => {
      const candidate = downloadables[format];
      if(!candidate || typeof candidate !== 'object')
        return;
      if(candidate.downloadUrls && typeof candidate.downloadUrls === 'object') {
        const output = {};
        Object.keys(candidate.downloadUrls).slice(0, 20).forEach((key, index) => {
          output['MIRROR_' + (index + 1)] = placeholderUrl();
        });
        projected.ttDownloadables[format] = {downloadUrls: output};
      }
      else if(Array.isArray(candidate.urls)) {
        projected.ttDownloadables[format] = {
          urls: candidate.urls.slice(0, 20).map(() => ({url: placeholderUrl()}))
        };
      }
    });
    return projected;
  });
  return JSON.stringify({movieId: 'TOKEN_1', timedtexttracks: projectedTracks}, null, 2);
}

function fixtureSubtitleArtifactFormat(profile, extension) {
  if(profile === WEBVTT || extension === 'vtt')
    return 'vtt';
  if(profile === DFXP || extension === 'dfxp')
    return 'dfxp';
  return 'xml';
}

function fixtureErrorCode(error) {
  const value = String(error && error.message ? error.message : (error || ''));
  if(!value)
    return '';
  if(/timeout/i.test(value))
    return 'timeout';
  if(/HTTP|status/i.test(value))
    return 'http';
  if(/network|fetch/i.test(value))
    return 'network';
  if(/metadata|title|episode/i.test(value))
    return 'metadata';
  if(/empty|subtitle/i.test(value))
    return 'empty-output';
  if(/stop|abort/i.test(value))
    return 'stopped';
  return 'unknown';
}

function beginFixtureDownload(kind) {
  if(!fixtureCaptureRecording)
    return null;
  const operation = {id: ++fixtureDownloadSequence, kind: kind || 'single'};
  fixtureActiveDownloadOperation = operation;
  captureNetflix('download.started', () => ({operationId: operation.id, kind: operation.kind}));
  return operation;
}

function finishFixtureDownload(operation, outcome, details) {
  if(!operation)
    return false;
  const captured = captureNetflix('download.finished', () => ({
    operationId: operation.id,
    kind: operation.kind,
    outcome: outcome || 'unknown',
    filename: details && details.filename || '',
    remaining: details && details.remaining || 0,
    errorCode: fixtureErrorCode(details && details.error)
  }));
  if(fixtureActiveDownloadOperation === operation)
    fixtureActiveDownloadOperation = null;
  return captured;
}

installFixtureCaptureCommands();

const setEpTitleInFilename = () => {
  document.querySelector('#subtitle-downloader-menu .ep-title-in-filename > span').textContent = (epTitleInFilename ? 'on' : 'off');
};
const setForceText = () => {
  document.querySelector('#subtitle-downloader-menu .force-all-lang > span').textContent = (forceSubs ? 'on' : 'off');
};
const setLocaleText = () => {
  document.querySelector('#subtitle-downloader-menu .pref-locale > span').textContent = (prefLocale === '' ? 'disabled' : prefLocale);
};
const setLangsText = () => {
  document.querySelector('#subtitle-downloader-menu .lang-setting > span').textContent = (langs === '' ? 'all' : langs);
};
const setFormatText = () => {
  document.querySelector('#subtitle-downloader-menu .sub-format > span').textContent = FORMAT_NAMES[subFormat];
};
const setBatchDelayText = () => {
  document.querySelector('#subtitle-downloader-menu .batch-delay > span').textContent = batchDelay;
};

const setBatch = b => {
  if(b === null)
    sessionStorage.removeItem('NSD_batch');
  else
    sessionStorage.setItem('NSD_batch', JSON.stringify(b));
};

const toggleEpTitleInFilename = () => {
  epTitleInFilename = !epTitleInFilename;
  if(epTitleInFilename)
    localStorage.setItem('NSD_ep-title-in-filename', epTitleInFilename);
  else
    localStorage.removeItem('NSD_ep-title-in-filename');
  setEpTitleInFilename();
  downloadUiState.filename = '';
  downloadUiState.label = 'Idle';
  downloadUiState.active = false;
  applyDownloadUi();
};
const toggleForceLang = () => {
  forceSubs = !forceSubs;
  if(forceSubs)
    localStorage.removeItem('NSD_force-all-lang');
  else
    localStorage.setItem('NSD_force-all-lang', forceSubs);
  document.location.reload();
};
const setPreferredLocale = () => {
  const result = prompt('Netflix limited "force all subtitles" usage. Now you have to set a preferred locale to show subtitles for that language.\nPossible values (you can enter only one at a time!):\nar, cs, da, de, el, en, es, es-ES, fi, fr, he, hi, hr, hu, id, it, ja, ko, ms, nb, nl, pl, pt, pt-BR, ro, ru, sv, ta, te, th, tr, uk, vi, zh', prefLocale);
  if(result !== null) {
    prefLocale = result;
    if(prefLocale === '')
      localStorage.removeItem('NSD_pref-locale');
    else
      localStorage.setItem('NSD_pref-locale', prefLocale);
    document.location.reload();
  }
};
const setLangToDownload = () => {
  const result = prompt('Languages to download, comma separated. Leave empty to download all subtitles.\nExample: en,de,fr', langs);
  if(result !== null) {
    langs = result;
    if(langs === '')
      localStorage.removeItem('NSD_lang-setting');
    else
      localStorage.setItem('NSD_lang-setting', langs);
    setLangsText();
  }
};
const setSubFormat = () => {
  if(subFormat === WEBVTT) {
    localStorage.setItem('NSD_sub-format', DFXP);
    subFormat = DFXP;
  }
  else {
    localStorage.removeItem('NSD_sub-format');
    subFormat = WEBVTT;
  }
  setFormatText();
};
const setBatchDelay = () => {
  let result = prompt('Delay (in seconds) between switching pages when downloading subs in batch:', batchDelay);
  if(result !== null) {
    result = parseFloat(result.replace(',', '.'));
    if(result < 0 || !Number.isFinite(result))
      result = 0;
    batchDelay = result;
    if(batchDelay == 0)
      localStorage.removeItem('NSD_batch-delay');
    else
      localStorage.setItem('NSD_batch-delay', batchDelay);
    setBatchDelayText();
  }
};

const asyncSleep = (seconds, value) => new Promise(resolve => {
  window.setTimeout(resolve, seconds * 1000, value);
});

const popRandomElement = arr => {
  return arr.splice(arr.length * Math.random() << 0, 1)[0];
};

const isWatchPage = () => document.location.pathname.split('/')[1] === 'watch';

const syncMenuVisibility = menu => {
  if(!menu || !menu.isConnected)
    return;
  const display = (isWatchPage() ? '' : 'none');
  if(menu.style.display !== display)
    menu.style.display = display;
};

let downloaderMenu = null;
const ensureMenu = () => {
  if(!document.body)
    return null;

  let menu = downloaderMenu && downloaderMenu.isConnected ? downloaderMenu :
    document.querySelector('#subtitle-downloader-menu');
  let created = false;
  if(menu === null) {
    menu = document.createElement('div');
    menu.id = 'subtitle-downloader-menu';
    menu.innerHTML = DOWNLOAD_MENU;
    document.body.appendChild(menu);
    created = true;
    menu.querySelector('.download').addEventListener('click', downloadThis);
    menu.querySelector('.download-to-end').addEventListener('click', downloadToEnd);
    menu.querySelector('.download-season').addEventListener('click', downloadSeason);
    menu.querySelector('.download-all').addEventListener('click', downloadAll);
    menu.querySelector('.ep-title-in-filename').addEventListener('click', toggleEpTitleInFilename);
    menu.querySelector('.force-all-lang').addEventListener('click', toggleForceLang);
    menu.querySelector('.pref-locale').addEventListener('click', setPreferredLocale);
    menu.querySelector('.lang-setting').addEventListener('click', setLangToDownload);
    menu.querySelector('.sub-format').addEventListener('click', setSubFormat);
    menu.querySelector('.batch-delay').addEventListener('click', setBatchDelay);
    setEpTitleInFilename();
    setForceText();
    setLocaleText();
    setLangsText();
    setFormatText();
    setBatchDelayText();
  }
  downloaderMenu = menu;
  syncMenuVisibility(menu);
  if(created)
    applyDownloadUi(menu);
  return menu;
};

const handleSubsReady = menu => {
  if(!menu || !menu.isConnected)
    return false;
  syncMenuVisibility(menu);
  if(getSubsFromCache(true) === null || getTitleEntry(true) === null)
    return false;

  if(batch !== null && batch.length > 0)
    downloadBatch(true);
  return true;
};

const processSubInfo = async result => {
  const tracks = result.timedtexttracks || result.textTracks;
  if(!Array.isArray(tracks))
    return;
  const subs = {};
  let reportError = true;
  for(const track of tracks) {
    if(track.isNoneTrack)
      continue;

    let type = SUB_TYPES[track.rawTrackType];
    if(typeof type === 'undefined')
      type = `[${track.rawTrackType}]`;
    const variant = (typeof track.trackVariant === 'undefined' ? '' : `-${track.trackVariant}`);
    const lang = track.language + type + variant + (track.isForcedNarrative ? '-forced' : '');

    const formats = {};
    const trackDownloadables = track.ttDownloadables || track.downloadables || {};
    for(let format of ALL_FORMATS) {
      const downloadables = trackDownloadables[format];
      if(typeof downloadables !== 'undefined') {
        let urls;
        if(typeof downloadables.downloadUrls !== 'undefined')
          urls = Object.values(downloadables.downloadUrls);
        else if(typeof downloadables.urls !== 'undefined')
          urls = downloadables.urls.map(({url}) => url);
        else {
          console.log('processSubInfo:', lang, Object.keys(downloadables));
          if(reportError) {
            reportError = false;
            alert("Can't find subtitle URL, check the console for more information!");
          }
          continue;
        }
        formats[format] = [urls, EXTENSIONS[format]];
      }
    }

    if(Object.keys(formats).length > 0) {
      for(let i = 0; ; ++i) {
        const langKey = lang + (i == 0 ? "" : `-${i}`);
        if(typeof subs[langKey] === "undefined") {
          subs[langKey] = formats;
          break;
        }
      }
    }
  }
  subCache[result.movieId] = subs;
  if(fixtureCaptureRecording) {
    fixtureLastTrackCatalog = fixtureTrackCatalogSummary(subs);
    captureNetflix('tracks.updated', () => ({
      trackCount: fixtureLastTrackCatalog.length,
      tracks: fixtureLastTrackCatalog
    }));
    captureNetflixSnapshot('tracks', () => ({tracks: fixtureLastTrackCatalog}));
  }
  if(handleSubsReady(ensureMenu()))
    subCacheWaitGeneration++;
};

const SUB_CACHE_WAIT_TIMEOUT_MS = 60000;
const checkSubsCache = async menu => {
  const generation = ++subCacheWaitGeneration;
  const videoId = getVideoId();
  const deadline = Date.now() + SUB_CACHE_WAIT_TIMEOUT_MS;

  while(generation === subCacheWaitGeneration &&
        getVideoId() === videoId &&
        getSubsFromCache(true) === null &&
        Date.now() < deadline) {
    await asyncSleep(0.1);
  }

  if(generation !== subCacheWaitGeneration || getVideoId() !== videoId)
    return;

  if(!handleSubsReady(menu)) {
    if(Date.now() >= deadline)
      console.warn('[Netflix Subtitle Downloader] subtitle cache wait timed out for video', videoId);
    return;
  }
};

const processMetadata = data => {
  const menu = ensureMenu();
  if(!data || !data.video)
    return;
  if(!menu)
    return;

  menu.classList.remove('series');

  const result = data.video;
  const {type, title} = result;
  if(type === 'show') {
    batchAll = [];
    batchSeason = [];
    batchToEnd = [];
    const allEpisodes = [];
    let currentSeason = 0;
    menu.classList.add('series');
    for(const season of result.seasons) {
      for(const episode of season.episodes) {
        if(episode.id === result.currentEpisode)
          currentSeason = season.seq;
        allEpisodes.push([season.seq, episode.seq, episode.id]);
        titleCache[episode.id] = {
          type, title,
          season: season.seq,
          episode: episode.seq,
          subtitle: episode.title,
          hiddenNumber: episode.hiddenEpisodeNumbers
        };
        delete domDerivedTitleIds[episode.id];
      }
    }

    allEpisodes.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let toEnd = false;
    for(const [season, episode, id] of allEpisodes) {
      batchAll.push(id);
      if(season === currentSeason)
        batchSeason.push(id);
      if(id === result.currentEpisode)
        toEnd = true;
      if(toEnd)
        batchToEnd.push(id);
    }
  }
  else if(type === 'movie' || type === 'supplemental') {
    titleCache[result.id] = {type, title};
    delete domDerivedTitleIds[result.id];
  }
  else {
    console.debug('[Netflix Subtitle Downloader] unknown video type:', type, result)
    return;
  }
  if(fixtureCaptureRecording) {
    const current = type === 'show' ? titleCache[result.currentEpisode] : titleCache[result.id];
    fixtureLastMetadata = fixtureTitleSummary(current || {type, title});
    captureNetflix('metadata.accepted', () => ({
      metadata: fixtureLastMetadata,
      batchAllCount: Array.isArray(batchAll) ? batchAll.length : 0,
      batchSeasonCount: Array.isArray(batchSeason) ? batchSeason.length : 0,
      batchToEndCount: Array.isArray(batchToEnd) ? batchToEnd.length : 0
    }));
    captureNetflixSnapshot('metadata', () => ({metadata: fixtureLastMetadata}));
  }
  syncPlaybackMetadataState(menu);
  checkSubsCache(menu);
};

const getVideoId = () => window.location.pathname.split('/').pop();

const getXFromCache = (cache, name, silent) => {
  const id = getVideoId();
  if(cache.hasOwnProperty(id))
    return cache[id];

  let newID = undefined;
  try {
    newID = unsafeWindow.netflix.falcorCache.videos[id].current.value[1];
  }
  catch(ignore) {}
  if(typeof newID !== 'undefined' && cache.hasOwnProperty(newID))
    return cache[newID];

  newID = idOverrides[id];
  if(typeof newID !== 'undefined' && cache.hasOwnProperty(newID))
    return cache[newID];

  if(silent === true)
    return null;

  alert("Couldn't find the " + name + ". Wait until the player is loaded. If that doesn't help refresh the page.");
  throw '';
};

const getSubsFromCache = silent => getXFromCache(subCache, 'subs', silent);

const normalizeDomTitle = value => String(value || '').replace(/\s+/g, ' ').trim();
const positiveInteger = value => {
  const number = parseInt(value, 10);
  return Number.isFinite(number) && number > 0 ? number : null;
};

const seasonNumberFromLabel = value => {
  const label = normalizeDomTitle(value);
  let match = label.match(/(?:season|\uC2DC\uC98C)\s*(\d{1,3})/i) ||
    label.match(/(\d{1,3})\s*(?:season|\uC2DC\uC98C)/i);
  if(match)
    return positiveInteger(match[1]);
  if(/limited\s+series|mini\s*series|\uB9AC\uBBF8\uD2F0\uB4DC\s*\uC2DC\uB9AC\uC988|\uBBF8\uB2C8\s*\uC2DC\uB9AC\uC988/i.test(label))
    return 1;
  return null;
};

const episodeNumberFromLabel = value => {
  const label = normalizeDomTitle(value);
  const patterns = [
    /(?:episode|ep\.?|\uC5D0\uD53C\uC18C\uB4DC)\s*(\d{1,4})/i,
    /^\s*E\s*(\d{1,4})(?:\D|$)/i,
    /^\s*(\d{1,4})\s*(?:\uD654|\uD68C)/i,
    /^\s*(\d{1,4})\s*[:.\-\u2013\u2014]/,
    /(\d{1,4})\s*(?:\uD654|\uD68C)\s*$/i,
    /\bE\s*(\d{1,4})\s*$/i
  ];
  for(const pattern of patterns) {
    const match = label.match(pattern);
    if(match)
      return positiveInteger(match[1]);
  }
  return null;
};

const cleanEpisodeSubtitle = (value, episodeNumber) => {
  let subtitle = normalizeDomTitle(value);
  const episode = positiveInteger(episodeNumber);
  if(!subtitle)
    return '';

  if(episode !== null) {
    const number = String(episode);
    const prefixes = [
      new RegExp('^\\s*(?:episode|ep\\.?|e)\\s*0*' + number + '\\s*[:.\\-\\u2013\\u2014]?\\s*', 'i'),
      new RegExp('^\\s*0*' + number + '\\s*(?:\\uD654|\\uD68C)\\s*[:.\\-\\u2013\\u2014]?\\s*', 'i')
    ];
    for(const prefix of prefixes) {
      if(prefix.test(subtitle)) {
        subtitle = subtitle.replace(prefix, '').trim();
        break;
      }
    }

    const suffixes = [
      new RegExp('\\s*[:.\\-\\u2013\\u2014]?\\s*0*' + number + '\\s*(?:\\uD654|\\uD68C)\\s*$', 'i'),
      new RegExp('\\s*[:.\\-\\u2013\\u2014]?\\s*(?:episode|ep\\.?|e)\\s*0*' + number + '\\s*$', 'i')
    ];
    for(const suffix of suffixes) {
      if(suffix.test(subtitle)) {
        subtitle = subtitle.replace(suffix, '').trim();
        break;
      }
    }

    const compact = subtitle.replace(/\s+/g, '');
    const duplicateMarkers = [
      new RegExp('^0*' + number + '(?:\\uD654|\\uD68C)$', 'i'),
      new RegExp('^(?:episode|ep\\.?|e)0*' + number + '$', 'i')
    ];
    if(duplicateMarkers.some(pattern => pattern.test(compact)))
      return '';
  }

  return subtitle;
};

const titleAndEpisodeFromDomContainer = node => {
  if(!node)
    return {title: '', episodeLabel: ''};

  let heading = null;
  try {
    heading = node.querySelector('h1, h2, h3, h4, h5, h6');
  }
  catch(ignore) {}

  const combined = normalizeDomTitle(node.textContent);
  const title = normalizeDomTitle(heading && heading.textContent) || combined;
  let episodeLabel = '';
  if(title && combined.startsWith(title))
    episodeLabel = normalizeDomTitle(combined.slice(title.length));

  return {title, episodeLabel};
};

const playbackMetadataFromDom = () => {
  const player = document.querySelector('[data-uia="watch-video"]') ||
    document.querySelector('.watch-video');
  if(!player)
    return null;

  let overlay = null;
  try {
    overlay = player.querySelector('[data-uia="evidence-overlay"]');
  }
  catch(ignore) {}
  const container = overlay || player;
  const titleSelectors = overlay ? ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', '[data-uia="video-title"]'] : [
    '[data-uia="evidence-overlay"] h1', '[data-uia="evidence-overlay"] h2',
    '[data-uia="evidence-overlay"] h3', '[data-uia="evidence-overlay"] h4',
    '[data-uia="evidence-overlay"] h5', '[data-uia="evidence-overlay"] h6',
    '[data-uia="video-title"]', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'
  ];
  let title = '';
  let adjacentEpisodeLabel = '';

  let titleContainer = null;
  try {
    titleContainer = container.querySelector('[data-uia="video-title"]');
  }
  catch(ignore) {}
  if(titleContainer) {
    const separated = titleAndEpisodeFromDomContainer(titleContainer);
    title = separated.title;
    if(episodeNumberFromLabel(separated.episodeLabel) !== null)
      adjacentEpisodeLabel = separated.episodeLabel;
  }

  for(const selector of titleSelectors) {
    if(title)
      break;
    let node = null;
    try {
      node = container.querySelector(selector);
    }
    catch(ignore) {}
    const nodeUia = normalizeDomTitle(node && node.getAttribute && node.getAttribute('data-uia'));
    if(/evidence-overlay-(?:season|episode)-title/i.test(nodeUia))
      continue;
    title = normalizeDomTitle(node && node.textContent);
    if(title && title.length <= 300 && title.toLowerCase() !== 'netflix')
      break;
  }
  if(!title)
    return null;

  let seasonLabel = '';
  let episodeLabel = '';
  try {
    const seasonNode = container.querySelector('[data-uia="evidence-overlay-season-title"]');
    const episodeNode = container.querySelector('[data-uia="evidence-overlay-episode-title"]');
    seasonLabel = normalizeDomTitle(seasonNode && seasonNode.textContent);
    episodeLabel = normalizeDomTitle(episodeNode && episodeNode.textContent);
  }
  catch(ignore) {}

  if(!episodeLabel)
    episodeLabel = adjacentEpisodeLabel;

  if(!episodeLabel)
    return {type: 'movie', title};

  const episode = episodeNumberFromLabel(episodeLabel);
  return {
    type: 'show',
    title,
    season: seasonNumberFromLabel(seasonLabel) || 1,
    episode,
    subtitle: cleanEpisodeSubtitle(episodeLabel, episode),
    hiddenNumber: false
  };
};

const playbackTitleFromDom = () => {
  const metadata = playbackMetadataFromDom();
  return metadata ? metadata.title : '';
};

const normalizedPlaybackTitle = value => normalizeDomTitle(value).toLowerCase();
const playbackMetadataChanged = (cached, dom, cachedIsDomDerived) => {
  if(!cached || !dom)
    return false;
  const cachedTitle = normalizedPlaybackTitle(cached.title);
  const domTitle = normalizedPlaybackTitle(dom.title);
  if(cachedTitle && domTitle && cachedTitle !== domTitle)
    return cachedIsDomDerived === true;
  if(cached.type !== 'show' || dom.type !== 'show')
    return false;
  const cachedSeason = positiveInteger(cached.season);
  const domSeason = positiveInteger(dom.season);
  const cachedEpisode = positiveInteger(cached.episode);
  const domEpisode = positiveInteger(dom.episode);
  return (cachedSeason !== null && domSeason !== null && cachedSeason !== domSeason) ||
    (cachedEpisode !== null && domEpisode !== null && cachedEpisode !== domEpisode);
};

const currentDomMetadata = (cached, dom) => {
  if(dom.type !== 'show')
    return dom;
  const sameTitle = normalizedPlaybackTitle(cached.title) === normalizedPlaybackTitle(dom.title);
  return {
    ...cached,
    ...dom,
    title: dom.title || cached.title,
    season: positiveInteger(dom.season) || (sameTitle ? positiveInteger(cached.season) : null) || 1,
    episode: positiveInteger(dom.episode),
    subtitle: dom.subtitle || ''
  };
};

const mergeTitleEntryWithDom = (cached, dom) => {
  if(!cached)
    return dom;
  if(!dom)
    return cached;
  if(playbackMetadataChanged(cached, dom))
    return currentDomMetadata(cached, dom);
  if(cached.type !== 'show' && dom.type === 'show')
    return {...cached, ...dom};
  if(cached.type !== 'show')
    return cached;
  return {
    ...cached,
    title: cached.title || dom.title,
    season: positiveInteger(cached.season) || dom.season,
    episode: positiveInteger(cached.episode) || dom.episode,
    subtitle: cached.subtitle || dom.subtitle
  };
};

const getTitleEntry = silent => {
  const videoId = getVideoId();
  const cached = getXFromCache(titleCache, 'title', true);
  const dom = playbackMetadataFromDom();
  const changed = cached !== null && dom !== null &&
    playbackMetadataChanged(cached, dom, domDerivedTitleIds[videoId] === true);
  const resolved = changed ? currentDomMetadata(cached, dom) :
    (cached !== null ? mergeTitleEntryWithDom(cached, dom) : dom);
  if(resolved) {
    titleCache[videoId] = resolved;
    if(cached === null || changed)
      domDerivedTitleIds[videoId] = true;
    return resolved;
  }

  if(silent === true)
    return null;
  return getXFromCache(titleCache, 'title');
};

const playbackUiMetadataChanged = (previous, current) => {
  if(!previous || !current)
    return false;
  const previousTitle = normalizedPlaybackTitle(previous.title);
  const currentTitle = normalizedPlaybackTitle(current.title);
  if(previousTitle && currentTitle && previousTitle !== currentTitle)
    return true;
  if(previous.type !== 'show' || current.type !== 'show')
    return false;
  const previousSeason = positiveInteger(previous.season);
  const currentSeason = positiveInteger(current.season);
  const previousEpisode = positiveInteger(previous.episode);
  const currentEpisode = positiveInteger(current.episode);
  return (previousSeason !== null && currentSeason !== null && previousSeason !== currentSeason) ||
    (previousEpisode !== null && currentEpisode !== null && previousEpisode !== currentEpisode);
};

const resetDownloadUiForPlaybackChange = () => {
  downloadUiState.active = false;
  downloadUiState.filename = '';
  downloadUiState.completed = 0;
  downloadUiState.total = 0;
  downloadUiState.label = 'Idle';
};

const syncPlaybackMetadataState = menu => {
  if(!isWatchPage())
    return null;
  if(typeof fixtureCaptureRecording !== 'undefined' && fixtureCaptureRecording)
    syncFixturePlaybackSession('metadata-sync');
  const title = getTitleEntry(true);
  if(!title) {
    applyDownloadUi(menu);
    return null;
  }
  if(playbackUiMetadataChanged(lastPlaybackUiMetadata, title)) {
    if(typeof fixtureCaptureRecording !== 'undefined' && fixtureCaptureRecording) {
      captureNetflix('playback.reset', () => ({
        previous: fixtureTitleSummary(lastPlaybackUiMetadata),
        current: fixtureTitleSummary(title)
      }));
    }
    resetDownloadUiForPlaybackChange();
  }
  lastPlaybackUiMetadata = {...title};
  if(typeof fixtureCaptureRecording !== 'undefined' && fixtureCaptureRecording) {
    fixtureLastMetadata = fixtureTitleSummary(title);
    captureNetflixSnapshot('metadata', () => ({metadata: fixtureLastMetadata}));
  }
  if(menu && menu.classList) {
    if(title.type === 'show')
      menu.classList.add('series');
    else
      menu.classList.remove('series');
  }
  applyDownloadUi(menu);
  return title;
};

const pad = (number, letter) => `${letter}${number.toString().padStart(2, '0')}`;
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const safeTitle = title => title.trim()
  .replace(/[:*?"<>|\\\/]+/g, '_')
  .replace(/\s+/g, '.')
  .replace(/\.+/g, '.')
  .replace(/_+(?=\.|$)/g, '')
  .replace(/^\.|\.$/g, '');

const TITLE_CACHE_WAIT_TIMEOUT_MS = 5000;
const DOM_MOVIE_STABILITY_MS = 1500;

const waitForTitleEntry = async () => {
  const videoId = getVideoId();
  const deadline = Date.now() + TITLE_CACHE_WAIT_TIMEOUT_MS;
  let movieCandidate = null;
  let movieCandidateSince = 0;

  while(getVideoId() === videoId && Date.now() < deadline) {
    const candidate = getTitleEntry(true);
    if(candidate) {
      if(candidate.type === 'show') {
        if(positiveInteger(candidate.episode) !== null)
          return candidate;
      }
      else if(candidate.type !== 'movie' && candidate.type !== 'supplemental')
        return candidate;

      const fingerprint = JSON.stringify(candidate);
      if(fingerprint !== movieCandidate) {
        movieCandidate = fingerprint;
        movieCandidateSince = Date.now();
      }
      else if(Date.now() - movieCandidateSince >= DOM_MOVIE_STABILITY_MS)
        return candidate;
    }
    await asyncSleep(0.1);
  }

  const finalCandidate = getTitleEntry(true);
  if(finalCandidate && finalCandidate.type === 'show' && positiveInteger(finalCandidate.episode) === null) {
    alert("Couldn't find the episode number. Show the player controls and try again.");
    throw '';
  }
  return getTitleEntry();
};

const getTitleFromCache = titleEntry => {
  const title = titleEntry || getTitleEntry();
  const titleParts = [title.title];
  if(title.type === 'show') {
    const seasonNumber = positiveInteger(title.season) || 1;
    const episodeNumber = positiveInteger(title.episode) || episodeNumberFromLabel(title.subtitle);
    const season = pad(seasonNumber, 'S');
    titleParts.push(season + (episodeNumber === null ? '' : pad(episodeNumber, 'E')));
    const subtitle = cleanEpisodeSubtitle(title.subtitle, episodeNumber);
    if(epTitleInFilename && subtitle)
      titleParts.push(subtitle);
  }
  return [safeTitle(titleParts.join('.')), safeTitle(title.title)];
};

const predictedOutputFilename = () => {
  if(!isWatchPage())
    return 'Waiting for title metadata...';
  const title = getTitleEntry(true);
  if(!title)
    return 'Waiting for title metadata...';
  try {
    return getTitleFromCache(title)[0];
  }
  catch(ignore) {
    return 'Waiting for title metadata...';
  }
};

const applyDownloadUi = menu => {
  menu = menu || document.querySelector('#subtitle-downloader-menu');
  if(!menu || typeof menu.querySelector !== 'function')
    return;

  const filenameNode = menu.querySelector('.output-filename > span');
  const progressText = menu.querySelector('.download-progress > span');
  const progress = menu.querySelector('.download-progress progress');
  const completed = Math.max(0, Number(downloadUiState.completed) || 0);
  const total = Math.max(0, Number(downloadUiState.total) || 0);
  const filenameText = downloadUiState.active && downloadUiState.filename
    ? downloadUiState.filename
    : predictedOutputFilename();
  if(typeof fixtureCaptureRecording !== 'undefined' && fixtureCaptureRecording &&
     filenameText && filenameText !== 'Waiting for title metadata...') {
    fixtureLastFilename = filenameText;
    captureNetflixSnapshot('filename.preview', () => ({
      filename: filenameText,
      metadata: fixtureLastMetadata
    }));
  }
  const progressLabel = total > 0
    ? `${downloadUiState.label} (${completed}/${total}, ${Math.floor(completed * 100 / total)}%)`
    : downloadUiState.label;

  if(filenameNode && filenameNode.textContent !== filenameText)
    filenameNode.textContent = filenameText;
  if(progressText && progressText.textContent !== progressLabel)
    progressText.textContent = progressLabel;
  if(progress) {
    const progressMax = Math.max(1, total);
    const progressValue = Math.min(completed, progressMax);
    if(Number(progress.max) !== progressMax)
      progress.max = progressMax;
    if(downloadUiState.active && total === 0) {
      if(progress.hasAttribute('value'))
        progress.removeAttribute('value');
    }
    else if(Number(progress.value) !== progressValue)
      progress.value = progressValue;
  }
};

const setMenuDownloadProgress = (completed, total, label, active, filename) => {
  downloadUiState.completed = Math.max(0, Number(completed) || 0);
  downloadUiState.total = Math.max(downloadUiState.completed, Number(total) || 0);
  downloadUiState.label = label || (active ? 'Preparing...' : 'Idle');
  downloadUiState.active = active === true;
  if(typeof filename === 'string' && filename.length > 0)
    downloadUiState.filename = filename;
  applyDownloadUi();
};

const isUsableFormatCandidate = candidate => {
  if(!Array.isArray(candidate) || candidate.length < 2 || !Array.isArray(candidate[0]))
    return false;
  if(typeof candidate[1] !== 'string' || candidate[1].length === 0)
    return false;
  return candidate[0].some(url => typeof url === 'string' && url.length > 0);
};

const pickFormat = formats => {
  const preferred = (subFormat === DFXP ? ALL_FORMATS : ALL_FORMATS_prefer_vtt);

  for(let format of preferred) {
    if(typeof formats[format] !== 'undefined' && isUsableFormatCandidate(formats[format]))
      return formats[format];
  }
};

const selectedProfileForCandidate = (formats, candidate) => {
  if(!formats || !candidate)
    return '';
  return Object.keys(formats).find(format => formats[format] === candidate) || '';
};


const _save = async (_zip, title) => {
  const fixtureOperation = fixtureActiveDownloadOperation;
  const filename = title + '.zip';
  captureNetflix('archive.started', () => ({
    operationId: fixtureOperation && fixtureOperation.id || 0,
    filename
  }));
  setMenuDownloadProgress(0, 100, 'Creating ZIP...', true, title);
  try {
    const content = await _zip.generateAsync({type:'blob'}, metadata => {
      setMenuDownloadProgress(Math.round(metadata.percent || 0), 100, 'Creating ZIP...', true, title);
    });
    saveAs(content, filename);
    setMenuDownloadProgress(100, 100, 'Complete', false, title);
    captureNetflix('archive.finished', () => ({
      operationId: fixtureOperation && fixtureOperation.id || 0,
      filename,
      outcome: 'success'
    }));
  }
  catch(error) {
    setMenuDownloadProgress(0, 0, 'Failed', false, title);
    captureNetflix('archive.finished', () => ({
      operationId: fixtureOperation && fixtureOperation.id || 0,
      filename,
      outcome: 'failed',
      errorCode: fixtureErrorCode(error)
    }));
    throw error;
  }
};

const _download = async _zip => {
  const fixtureOperation = fixtureActiveDownloadOperation;
  const titleEntry = await waitForTitleEntry();
  const subs = getSubsFromCache();
  const [title, seriesTitle] = getTitleFromCache(titleEntry);
  const downloaded = [];
  if(fixtureCaptureRecording) {
    fixtureLastMetadata = fixtureTitleSummary(titleEntry);
    fixtureLastFilename = title;
    captureNetflixSnapshot('filename.resolved', () => ({
      operationId: fixtureOperation && fixtureOperation.id || 0,
      filename: title,
      metadata: fixtureLastMetadata
    }));
  }

  let filteredLangs;
  const requestedLangs = langs.split(',').map(value => value.trim()).filter(Boolean);
  if(requestedLangs.length === 0)
    filteredLangs = Object.keys(subs);
  else {
    const regularExpression = new RegExp('^(' + requestedLangs.map(escapeRegExp).join('|') + ')');
    filteredLangs = [];
    for(const lang of Object.keys(subs)) {
      if(regularExpression.test(lang))
        filteredLangs.push(lang);
    }
  }

  captureNetflix('download.selection', () => ({
    operationId: fixtureOperation && fixtureOperation.id || 0,
    requestedLanguages: requestedLangs,
    selectedLanguages: filteredLangs,
    preferredFormat: subFormat
  }));
  setMenuDownloadProgress(0, filteredLangs.length, 'Downloading subtitle tracks...', true, title);
  const progress = new ProgressBar(filteredLangs.length);
  let stop = false;
  for(const lang of filteredLangs) {
    const selectedFormat = pickFormat(subs[lang]);
    if(!selectedFormat) {
      captureNetflix('download.track-skipped', () => ({
        operationId: fixtureOperation && fixtureOperation.id || 0,
        language: lang,
        reason: 'no-usable-format'
      }));
      progress.increment();
      continue;
    }
    const selectedProfile = fixtureCaptureRecording ? selectedProfileForCandidate(subs[lang], selectedFormat) : '';
    const [cachedUrls, extension] = selectedFormat;
    const urls = cachedUrls.filter(url => typeof url === 'string' && url.length > 0);
    const mirrorTotal = urls.length;
    let mirrorAttempt = 0;
    captureNetflix('download.track-selected', () => ({
      operationId: fixtureOperation && fixtureOperation.id || 0,
      language: lang,
      formatProfile: selectedProfile,
      extension,
      mirrorCount: mirrorTotal
    }));
    while(urls.length > 0) {
      const url = popRandomElement(urls);
      mirrorAttempt++;
      let result;
      try {
        result = await Promise.race([
          fetch(url, {mode: "cors"}),
          progress.stop,
          asyncSleep(30, DOWNLOAD_TIMEOUT)
        ]);
      }
      catch(error) {
        captureNetflix('download.mirror-failed', () => ({
          operationId: fixtureOperation && fixtureOperation.id || 0,
          language: lang,
          formatProfile: selectedProfile,
          mirrorAttempt,
          mirrorTotal,
          errorCode: fixtureErrorCode(error)
        }));
        console.warn('[Netflix Subtitle Downloader] subtitle fetch failed, trying another URL', url, error);
        continue;
      }
      if(result === STOP_THE_DOWNLOAD) {
        stop = true;
        captureNetflix('download.stopped', () => ({
          operationId: fixtureOperation && fixtureOperation.id || 0,
          language: lang
        }));
        break;
      }
      if(result === DOWNLOAD_TIMEOUT) {
        captureNetflix('download.mirror-failed', () => ({
          operationId: fixtureOperation && fixtureOperation.id || 0,
          language: lang,
          formatProfile: selectedProfile,
          mirrorAttempt,
          mirrorTotal,
          errorCode: 'timeout'
        }));
        console.warn('[Netflix Subtitle Downloader] subtitle fetch timed out, trying another URL', url);
        continue;
      }
      if(!result || result.ok !== true) {
        captureNetflix('download.mirror-failed', () => ({
          operationId: fixtureOperation && fixtureOperation.id || 0,
          language: lang,
          formatProfile: selectedProfile,
          mirrorAttempt,
          mirrorTotal,
          errorCode: 'http',
          status: result && result.status || 0
        }));
        console.warn('[Netflix Subtitle Downloader] subtitle HTTP request failed, trying another URL', url, result && result.status);
        continue;
      }
      let data;
      try {
        data = await result.text();
      }
      catch(error) {
        captureNetflix('download.mirror-failed', () => ({
          operationId: fixtureOperation && fixtureOperation.id || 0,
          language: lang,
          formatProfile: selectedProfile,
          mirrorAttempt,
          mirrorTotal,
          errorCode: 'body-read'
        }));
        console.warn('[Netflix Subtitle Downloader] subtitle response could not be read, trying another URL', url, error);
        continue;
      }
      if(data.length > 0) {
        const artifact = captureNetflixArtifact('subtitle', data, () => ({
          format: fixtureSubtitleArtifactFormat(selectedProfile, extension),
          formatProfile: selectedProfile,
          language: lang,
          extension
        }), false);
        captureNetflix('subtitle.response-observed', () => ({
          operationId: fixtureOperation && fixtureOperation.id || 0,
          language: lang,
          formatProfile: selectedProfile,
          extension,
          mirrorAttempt,
          mirrorTotal,
          artifact: artifact || ''
        }));
        downloaded.push({lang, data, extension});
        break;
      }
      captureNetflix('download.mirror-failed', () => ({
        operationId: fixtureOperation && fixtureOperation.id || 0,
        language: lang,
        formatProfile: selectedProfile,
        mirrorAttempt,
        mirrorTotal,
        errorCode: 'empty-output'
      }));
    }
    progress.increment();
    if(stop)
      break;
  }

  downloaded.forEach(x => {
    const {lang, data, extension} = x;
    _zip.file(`${title}.WEBRip.Netflix.${lang}.${extension}`, data);
  });

  if(await Promise.race([progress.stop, {}]) === STOP_THE_DOWNLOAD)
    stop = true;
  progress.destroy();
  setMenuDownloadProgress(progress.current, progress.max, 'Preparing ZIP...', true, title);
  captureNetflix('download.tracks-finished', () => ({
    operationId: fixtureOperation && fixtureOperation.id || 0,
    requestedCount: filteredLangs.length,
    downloadedCount: downloaded.length,
    stopped: stop
  }));

  return [title, seriesTitle, stop];
};

const downloadThis = async () => {
  const fixtureOperation = beginFixtureDownload('single');
  try {
    const _zip = new JSZip();
    const [title] = await _download(_zip);
    await _save(_zip, title);
    finishFixtureDownload(fixtureOperation, 'success', {filename: title + '.zip'});
  }
  catch(error) {
    setMenuDownloadProgress(0, 0, 'Failed', false);
    finishFixtureDownload(fixtureOperation, 'failed', {error});
    console.error('[Netflix Subtitle Downloader] download failed', error);
  }
};

const cleanBatch = async () => {
  captureNetflix('batch.cleaned', () => ({hadBatch: Array.isArray(batch)}));
  batch = null;
  setBatch(null);
  try {
    const cache = await caches.open('NSD');
    await cache.delete('/subs.zip');
    await caches.delete('NSD');
  }
  catch(error) {
    console.warn('[Netflix Subtitle Downloader] could not clear batch cache', error);
  }
}

const readAsBinaryString = blob => new Promise(resolve => {
  const reader = new FileReader();
  reader.onload = function(event) {
    resolve(event.target.result);
  };
  reader.readAsBinaryString(blob);
});

const downloadBatch = async auto => {
  if(batchDownloadInProgress)
    return;

  batchDownloadInProgress = true;
  const fixtureOperation = beginFixtureDownload(auto === true ? 'batch-auto' : 'batch');
  let keepLockedForNavigation = false;
  try {
    const cache = await caches.open('NSD');
    let zip, title, stop;
  if(auto === true) {
    try {
      const response = await cache.match('/subs.zip');
      const blob = await response.blob();
      zip = await JSZip.loadAsync(await readAsBinaryString(blob));
    }
    catch(error) {
      console.error(error);
      alert('An error occured when loading the zip file with subs from the cache. More info in the browser console.');
      finishFixtureDownload(fixtureOperation, 'failed', {error});
      await cleanBatch();
      return;
    }
  }
  else
    zip = new JSZip();

  try {
    [, title, stop] = await _download(zip);
  }
  catch(error) {
    title = 'unknown';
    stop = true;
    captureNetflix('batch.episode-failed', () => ({
      operationId: fixtureOperation && fixtureOperation.id || 0,
      errorCode: fixtureErrorCode(error)
    }));
  }

  const id = parseInt(getVideoId());
  batch = batch.filter(x => x !== id);

    if(stop || batch.length == 0) {
      await _save(zip, title);
      finishFixtureDownload(fixtureOperation, stop ? 'stopped' : 'success', {
        filename: title + '.zip',
        remaining: batch.length
      });
      await cleanBatch();
    }
    else {
      setBatch(batch);
      await cache.put('/subs.zip', new Response(await zip.generateAsync({type:'blob'})));
      await asyncSleep(batchDelay);
      captureNetflix('batch.navigation-scheduled', () => ({
        operationId: fixtureOperation && fixtureOperation.id || 0,
        remaining: batch.length
      }));
      finishFixtureDownload(fixtureOperation, 'continued', {remaining: batch.length});
      keepLockedForNavigation = true;
      window.location = window.location.origin + '/watch/' + batch[0];
    }
  }
  finally {
    if(!keepLockedForNavigation)
      batchDownloadInProgress = false;
  }
};

const downloadAll = () => {
  captureNetflix('batch.planned', () => ({kind: 'all', count: Array.isArray(batchAll) ? batchAll.length : 0}));
  batch = batchAll.slice();
  downloadBatch();
};

const downloadSeason = () => {
  captureNetflix('batch.planned', () => ({kind: 'season', count: Array.isArray(batchSeason) ? batchSeason.length : 0}));
  batch = batchSeason.slice();
  downloadBatch();
};

const downloadToEnd = () => {
  captureNetflix('batch.planned', () => ({kind: 'to-end', count: Array.isArray(batchToEnd) ? batchToEnd.length : 0}));
  batch = batchToEnd.slice();
  downloadBatch();
};

const processMessage = e => {
  if(!e || !e.detail)
    return;
  const {type, data} = e.detail;
  if(type === 'subs') {
    if(fixtureCaptureRecording) {
      const projection = fixtureSubtitleCatalogProjection(data);
      const artifact = captureNetflixArtifact('track-catalog', projection, () => ({format: 'json'}), true);
      captureNetflix('subtitle.catalog-observed', () => ({artifact: artifact || ''}));
    }
    processSubInfo(data);
  }
  else if(type === 'id_override') {
    idOverrides[data[0]] = data[1];
    captureNetflix('playback.id-override', () => ({mapped: true}));
  }
  else if(type === 'metadata') {
    if(fixtureCaptureRecording) {
      const projection = fixtureMetadataProjection(data);
      const artifact = captureNetflixArtifact('metadata-structure', projection, () => ({format: 'json'}), true);
      captureNetflix('metadata.response-observed', () => ({artifact: artifact || ''}));
    }
    processMetadata(data);
  }
}

const injection = (ALL_FORMATS) => {
  const MANIFEST_PATTERN = new RegExp('manifest|licensedManifest');
  const forceSubs = localStorage.getItem('NSD_force-all-lang') !== 'false';
  const prefLocale = localStorage.getItem('NSD_pref-locale') || '';

  // hide the menu when we go back to the browse list
  window.addEventListener('popstate', () => {
    const display = (document.location.pathname.split('/')[1] === 'watch' ? '' : 'none');
    const menu = document.querySelector('#subtitle-downloader-menu');
    if(menu)
      menu.style.display = display;
  });

  // hijack JSON.parse and JSON.stringify functions
  ((parse, stringify, open, realFetch) => {
    JSON.parse = function () {
      const data = parse.apply(this, arguments);
      try {
        if (data && data.result && (data.result.timedtexttracks || data.result.textTracks) && data.result.movieId) {
          window.dispatchEvent(new CustomEvent('netflix_sub_downloader_data', {detail: {type: 'subs', data: data.result}}));
        }
      }
      catch(error) {
        console.debug('[Netflix Subtitle Downloader] JSON.parse observer failed:', error);
      }
      return data;
    };

    JSON.stringify = function () {
      const data = arguments[0];
      /*{
        let text = stringify(data);
        if (text.includes('dfxp-ls-sdh'))
          console.log(text, data);
      }*/

      try {
        if (data && typeof data.url === 'string' && data.url.search(MANIFEST_PATTERN) > -1) {
          for (let v of Object.values(data)) {
            try {
              if (v.profiles) {
                for(const profile_name of ALL_FORMATS) {
                  if(!v.profiles.includes(profile_name)) {
                    v.profiles.unshift(profile_name);
                  }
                }
              }
              if (v.showAllSubDubTracks != null && forceSubs)
                v.showAllSubDubTracks = true;
              if (prefLocale !== '')
                v.preferredTextLocale = prefLocale;
            }
            catch (e) {
              if (e instanceof TypeError)
                continue;
              else
                throw e;
            }
          }
        }
        if(data && typeof data.movieId === 'number') {
          try {
            let videoId = data.params.sessionParams.uiplaycontext.video_id;
            if(typeof videoId === 'number' && videoId !== data.movieId)
              window.dispatchEvent(new CustomEvent('netflix_sub_downloader_data', {detail: {type: 'id_override', data: [videoId, data.movieId]}}));
          }
          catch(ignore) {}
        }
      }
      catch(error) {
        console.debug('[Netflix Subtitle Downloader] JSON.stringify observer failed:', error);
      }
      return stringify.apply(this, arguments);
    };

    XMLHttpRequest.prototype.open = function() {
      let requestUrl = '';
      try {
        if(arguments.length > 1)
          requestUrl = String(arguments[1] || '');
      }
      catch(ignore) {}

      if(requestUrl.includes('/metadata?'))
        this.addEventListener('load', () => {
          Promise.resolve().then(async () => {
            let data = this.response;
            if(data instanceof Blob)
              data = JSON.parse(await data.text());
            else if(typeof data === 'string')
              data = JSON.parse(data);
            window.dispatchEvent(new CustomEvent('netflix_sub_downloader_data', {detail: {type: 'metadata', data: data}}));
          }).catch(error => {
            console.debug('[Netflix Subtitle Downloader] XHR metadata observer failed:', error);
          });
        }, false);
      return open.apply(this, arguments);
    };

    const getFetchUrl = input => {
      if(typeof input === 'string')
        return input;
      if(input && typeof input.url === 'string')
        return input.url;
      try {
        return input == null ? '' : String(input);
      }
      catch(ignore) {
        return '';
      }
    };

    window.fetch = function() {
      const args = arguments;
      const requestUrl = getFetchUrl(args[0]);
      const responsePromise = realFetch.apply(this, args);
      if(!requestUrl.includes('/metadata?'))
        return responsePromise;

      responsePromise.then(response => {
        try {
          response.clone().json().then(data => {
            window.dispatchEvent(new CustomEvent('netflix_sub_downloader_data', {detail: {type: 'metadata', data: data}}));
          }).catch(error => {
            console.debug('[Netflix Subtitle Downloader] fetch metadata observer failed:', error);
          });
        }
        catch(error) {
          console.debug('[Netflix Subtitle Downloader] fetch metadata observer failed:', error);
        }
      }).catch(() => {});
      return responsePromise;
    };
  })(JSON.parse, JSON.stringify, XMLHttpRequest.prototype.open, window.fetch);
}

window.addEventListener('netflix_sub_downloader_data', processMessage, false);

const injectPageHooks = () => {
  const parent = document.head || document.documentElement;
  if(!parent) {
    window.setTimeout(injectPageHooks, 0);
    return;
  }
  const sc = document.createElement('script');
  sc.innerHTML = '(' + injection.toString() + ')(' + JSON.stringify(ALL_FORMATS) + ')';
  parent.appendChild(sc);
  parent.removeChild(sc);
};
injectPageHooks();

// add CSS style
const s = document.createElement('style');
s.innerHTML = SCRIPT_CSS;

const PLAYBACK_METADATA_SYNC_DELAY_MS = 250;
let playbackMetadataSyncTimer = null;
const schedulePlaybackMetadataSync = menu => {
  if(!isWatchPage() || playbackMetadataSyncTimer !== null)
    return;
  playbackMetadataSyncTimer = window.setTimeout(() => {
    playbackMetadataSyncTimer = null;
    if(isWatchPage())
      syncPlaybackMetadataState(menu && menu.isConnected ? menu : ensureMenu());
  }, PLAYBACK_METADATA_SYNC_DELAY_MS);
};

const isDownloaderMenuMutation = (mutation, menu) => {
  if(!mutation || !menu)
    return false;
  const target = mutation.target;
  if(target === menu || (target && typeof menu.contains === 'function' && menu.contains(target)))
    return true;
  const addedNodes = mutation.addedNodes || [];
  return addedNodes.length > 0 && Array.prototype.every.call(addedNodes, node =>
    node === menu || (typeof menu.contains === 'function' && menu.contains(node))
  );
};

const observer = new MutationObserver(function(mutations) {
  const menu = ensureMenu();
  if(!isWatchPage())
    return;
  const pageMutations = mutations.filter(mutation => !isDownloaderMenuMutation(mutation, menu));
  if(pageMutations.length === 0)
    return;
  schedulePlaybackMetadataSync(menu);
  pageMutations.forEach(function(mutation) {
    mutation.addedNodes.forEach(function(node) {
      // add scrollbar - Netflix doesn't expect you to have this manu languages to choose from...
      try {
        (node.parentNode || node).querySelector('.watch-video--selector-audio-subtitle').parentNode.style.overflowY = 'scroll';
      }
      catch(ignore) {}
    });
  });
});

let observerStarted = false;
const initializeDom = () => {
  if(!document.body)
    return;
  const parent = document.head || document.documentElement;
  if(parent && !s.isConnected)
    parent.appendChild(s);
  const menu = ensureMenu();
  syncPlaybackMetadataState(menu);
  if(!observerStarted) {
    observer.observe(document.body, { childList: true, subtree: true });
    observerStarted = true;
  }
};

if(document.body)
  initializeDom();
else
  document.addEventListener('DOMContentLoaded', initializeDom, {once: true});
