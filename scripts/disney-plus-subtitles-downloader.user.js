// ==UserScript==
// @name       Disney+ Subtitles Downloader
// @namespace  https://github.com/wonmin82/streaming-subtitle-downloaders
// @description Download subtitles from Disney+
// @version    1.0.0
// @author     stegner; modifications by Wonmin Jung
// @license    MIT
// @homepageURL https://github.com/wonmin82/streaming-subtitle-downloaders
// @downloadURL https://raw.githubusercontent.com/wonmin82/streaming-subtitle-downloaders/main/scripts/disney-plus-subtitles-downloader.user.js
// @updateURL  https://raw.githubusercontent.com/wonmin82/streaming-subtitle-downloaders/main/scripts/disney-plus-subtitles-downloader.user.js
// @match      https://www.disneyplus.com/*
// @grant      GM_xmlhttpRequest
// @grant      unsafeWindow
// @connect    *.dssott.com
// @connect    *.dssedge.com
// @connect    *.disney.com
// @connect    *.disneyplus.com
// @connect    *.bamgrid.com
// @connect    *
// @require    https://cdn.jsdelivr.net/npm/jszip@3.5.0/dist/jszip.min.js
// @require    https://cdn.jsdelivr.net/npm/file-saver@2.0.2/dist/FileSaver.min.js
// @run-at     document-start
// ==/UserScript==

(function () {
    'use strict';

    var debug = location.hash === '#debug' || location.hash.indexOf('dpsd_debug') >= 0;
    var MAX_RETRIES = 5;
    var LOG_PREFIX = '[Disney+ Subtitles DL]';
    var targetWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    var state = {
        initialized: false,
        installedHooks: false,
        observer: null,
        oldlocation: null,
        langs: [],
        langKeys: {},
        seenManifestUrls: {},
        seenResourceUrls: {},
        playbackScanStartedAt: 0,
        selectedTrackKey: '',
        userSelectedTrack: false,
        mediaTitle: '',
        seasonNumber: null,
        episodeNumber: null,
        episodeTag: '',
        wait: false,
        status: 'Waiting for playback...',
        lastError: '',
        downloadall: false,
        zip: null
    };

    init();

    function init() {
        if (state.initialized) return;
        state.initialized = true;

        installStyles();
        installNetworkHooks();
        startPerformanceObserver();
        scheduleUi();
        setInterval(tick, 1000);
        debuglog('Script loaded');
    }

    function tick() {
        var playbackPath = location.pathname.indexOf('/play/') >= 0 ? location.pathname : '';
        if (state.oldlocation !== playbackPath) {
            state.oldlocation = playbackPath;
            if (location.pathname.indexOf('/play/') >= 0) {
                state.status = 'Scanning playback...';
                resetSubtitleTracks();
                resetMediaMetadata();
                refreshMediaMetadataFromDom();
                scanPerformanceEntries();
                updateUi();
            }
        }

        if (location.pathname.indexOf('/play/') >= 0) {
            ensureWidget();
            scanPerformanceEntries();
        } else {
            var root = document.getElementById('dpsd-root');
            if (root) root.style.display = 'none';
        }
    }

    function scheduleUi() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', ensureWidget, false);
        } else {
            ensureWidget();
        }
    }

    function installStyles() {
        var style = document.createElement('style');
        style.id = 'dpsd-styles';
        style.textContent = [
            '#dpsd-root{position:fixed;display:none;width:300px;top:0;left:calc(50% - 150px);z-index:2147483647;font-family:Arial,sans-serif;color:#fff;font-size:10px}',
            '#dpsd-root *{box-sizing:border-box}',
            'body:hover #dpsd-root{display:block}',
            '#dpsd-menu{list-style:none;position:relative;width:300px;background:#333;color:#fff;padding:0;margin:auto;font-size:12px;z-index:99999998}',
            '#dpsd-menu li{padding:10px;min-height:34px;line-height:14px;white-space:normal}',
            '#dpsd-menu li.dpsd-header{font-weight:bold;cursor:default}',
            '#dpsd-menu li:not(.dpsd-header){display:none;cursor:pointer}',
            '#dpsd-root:hover #dpsd-menu li{display:block}',
            '#dpsd-menu li:not(.dpsd-header):hover{background:#666}',
            '#dpsd-menu li.dpsd-info{cursor:default}',
            '#dpsd-menu li.dpsd-info:hover{background:transparent}',
            '#dpsd-menu li.dpsd-disabled{opacity:.45;cursor:not-allowed}',
            '#dpsd-menu li.dpsd-disabled:hover{background:transparent}',
            '#dpsd-track{width:100%;margin-top:6px;border:1px solid #555;background:#222;color:#fff;padding:4px;font-size:12px}',
            '#dpsd-status{color:#ddd;word-break:break-word}',
            '#dpsd-count,#dpsd-selected-name,#dpsd-format{font-weight:normal}'
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
        if (location.pathname.indexOf('/play/') < 0) return;
        if (!document.body) {
            setTimeout(ensureWidget, 100);
            return;
        }

        var root = document.getElementById('dpsd-root');
        if (root) {
            root.style.display = '';
            updateUi();
            return;
        }

        root = document.createElement('div');
        root.id = 'dpsd-root';
        root.innerHTML =
            '<ol id="dpsd-menu">' +
                '<li class="dpsd-header">Disney+ subtitle downloader</li>' +
                '<li id="dpsd-download" role="button" tabindex="0">Download selected subtitle</li>' +
                '<li id="dpsd-download-en" role="button" tabindex="0">Download English subtitle</li>' +
                '<li id="dpsd-download-ko" role="button" tabindex="0">Download Korean subtitle</li>' +
                '<li id="dpsd-download-en-ko" role="button" tabindex="0">Download English + Korean subtitles</li>' +
                '<li id="dpsd-download-all" role="button" tabindex="0">Download all detected subtitles</li>' +
                '<li class="dpsd-info">Selected track: <span id="dpsd-selected-name">none</span><select id="dpsd-track"></select></li>' +
                '<li class="dpsd-info">Detected subtitles: <span id="dpsd-count">0 tracks</span></li>' +
                '<li class="dpsd-info">Subtitle format: <span id="dpsd-format">WebVTT</span></li>' +
                '<li id="dpsd-rescan" role="button" tabindex="0">Rescan playback resources</li>' +
                '<li class="dpsd-info">Status: <span id="dpsd-status">Waiting for playback...</span></li>' +
            '</ol>';

        document.body.appendChild(root);

        bindMenuAction('dpsd-rescan', function () {
            state.status = 'Rescanning playback resources...';
            scanPerformanceEntries();
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

        var select = document.getElementById('dpsd-track');
        var count = document.getElementById('dpsd-count');
        var status = document.getElementById('dpsd-status');
        var download = document.getElementById('dpsd-download');
        var downloadAll = document.getElementById('dpsd-download-all');
        var downloadEn = document.getElementById('dpsd-download-en');
        var downloadKo = document.getElementById('dpsd-download-ko');
        var downloadEnKo = document.getElementById('dpsd-download-en-ko');
        var selectedName = document.getElementById('dpsd-selected-name');
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
                    recordResourceUrl(arguments[1], 'xhr');
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
                        inspectMetadataResponse(xhr.__dpsdUrl, responseText);
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
                recordResourceUrl(url, 'fetch');
                return originalFetch.apply(this, arguments).then(function (response) {
                    inspectFetchMetadataResponse(url || response.url, response);
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
        scanPerformanceEntries();
        try {
            if (!targetWindow.PerformanceObserver) return;
            state.observer = new targetWindow.PerformanceObserver(function (list) {
                list.getEntries().forEach(function (entry) {
                    recordResourceUrl(entry.name, 'performance');
                });
            });
            state.observer.observe({ entryTypes: ['resource'] });
            debuglog('PerformanceObserver installed');
        } catch (err) {
            debuglog('PerformanceObserver failed: ' + err.message);
        }
    }

    function scanPerformanceEntries() {
        try {
            var perf = targetWindow.performance || window.performance;
            if (!perf || !perf.getEntriesByType) return;
            perf.getEntriesByType('resource').forEach(function (entry) {
                if (state.playbackScanStartedAt && typeof entry.startTime === 'number' && entry.startTime < state.playbackScanStartedAt) return;
                recordResourceUrl(entry.name, 'performance-scan');
            });
        } catch (err) {
            debuglog('Performance scan failed: ' + err.message);
        }
    }

    function recordResourceUrl(rawUrl, source) {
        var url = normalizeUrl(rawUrl);
        if (!url || state.seenResourceUrls[url]) return;
        state.seenResourceUrls[url] = true;

        if (/\.m3u8(?:[?#]|$)/i.test(url)) {
            queueManifest(url, source);
        }
    }

    function inspectFetchMetadataResponse(url, response) {
        if (!shouldInspectMetadataUrl(url) || !response || !response.clone) return;
        try {
            response.clone().text().then(function (text) {
                inspectMetadataResponse(url, text);
            }).catch(function () {});
        } catch (err) {}
    }

    function inspectMetadataResponse(url, text) {
        if (!shouldInspectMetadataUrl(url) || typeof text !== 'string' || !text) return;
        if (text.length > 2000000) return;

        var metadata = extractMetadataFromText(text);
        if (metadata.title || metadata.episodeTag || (metadata.seasonNumber && metadata.episodeNumber)) {
            updateMediaMetadata(metadata);
        }
    }

    function shouldInspectMetadataUrl(url) {
        url = normalizeUrl(url);
        if (!url) return false;
        if (/\.(m3u8|vtt|mp4|mp4a|m4s|bif|png|jpg|jpeg|webp|woff2?)(?:[?#]|$)/i.test(url)) return false;
        return /disney|bamgrid|dssott|dssedge|graphql|playerExperience|deeplink|upNext|explore/i.test(url);
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

    function updateMediaMetadata(metadata) {
        if (!metadata) return;

        if (metadata.title) {
            var title = cleanDisplayTitle(metadata.title);
            if (title && !/\bS\d{1,2}E\d{1,3}\b/i.test(title)) state.mediaTitle = title;
        }

        if (metadata.seasonNumber && metadata.episodeNumber) {
            state.seasonNumber = metadata.seasonNumber;
            state.episodeNumber = metadata.episodeNumber;
            state.episodeTag = formatSeasonEpisode(metadata.seasonNumber, metadata.episodeNumber);
        }

        if (metadata.episodeTag) {
            state.episodeTag = metadata.episodeTag;
        }
    }

    function resetMediaMetadata() {
        state.mediaTitle = '';
        state.seasonNumber = null;
        state.episodeNumber = null;
        state.episodeTag = '';
    }

    function resetSubtitleTracks() {
        state.langs = [];
        state.langKeys = {};
        state.seenManifestUrls = {};
        state.seenResourceUrls = {};
        state.playbackScanStartedAt = performanceNow() - 5000;
        state.selectedTrackKey = '';
        state.userSelectedTrack = false;
        state.lastError = '';
    }

    function refreshMediaMetadataFromDom() {
        updateMediaMetadata({
            title: displayTitle(),
            episodeTag: seasonEpisodeTag(playbackInfoText())
        });
    }

    function queueManifest(url, source) {
        if (state.seenManifestUrls[url]) return;
        state.seenManifestUrls[url] = true;
        state.status = 'Found manifest via ' + source + '. Reading tracks...';
        updateUi();

        getText(url).then(function (text) {
            parseManifest(url, text || '');
            updateUi();
        }).catch(function (err) {
            state.lastError = 'Could not read manifest: ' + err.message;
            updateUi();
        });
    }

    function parseManifest(url, text) {
        if (!text) return;
        if (text.indexOf('#EXTM3U') < 0 && text.indexOf('WEBVTT') < 0) return;

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
                source: 'master'
            });
        });

        if (looksLikeSubtitlePlaylist(url, text)) {
            addTrack({
                NAME: inferTrackName(url),
                LANGUAGE: inferLanguage(url),
                FORCED: /forced/i.test(url) ? 'YES' : 'NO',
                URI: url,
                source: 'playlist',
                segments: extractSegmentUrls(text, url)
            });
        }

        if (state.langs.length > 0) {
            state.status = 'Ready. Select a subtitle track.';
        }
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

    function addTrack(track) {
        if (!track.URI) return;
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
        debuglog('Track added: ' + track.NAME);
    }

    function mergeTrack(existing, incoming) {
        if (!incoming || !incoming.URI) return;
        var incomingScore = trackSourceScore(incoming);
        var existingScore = trackSourceScore(existing);

        if (incomingScore >= existingScore) {
            existing.URI = incoming.URI;
            existing.source = incoming.source || existing.source;
            existing.segments = incoming.segments || existing.segments;
        } else if (incoming.segments && incoming.segments.length && (!existing.segments || !existing.segments.length)) {
            existing.segments = incoming.segments;
        }

        if (!existing.LANGUAGE && incoming.LANGUAGE) existing.LANGUAGE = incoming.LANGUAGE;
        if (!existing.FORCED && incoming.FORCED) existing.FORCED = incoming.FORCED;
        if (!existing.CHARACTERISTICS && incoming.CHARACTERISTICS) existing.CHARACTERISTICS = incoming.CHARACTERISTICS;
        if (!existing.TYPE && incoming.TYPE) existing.TYPE = incoming.TYPE;
        if (isBetterTrackName(incoming.NAME, existing.NAME)) existing.NAME = incoming.NAME;
        debuglog('Track merged: ' + existing.NAME);
    }

    function trackSourceScore(track) {
        var score = 0;
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
        return /\.vtt(?:[?#\s]|$)/i.test(text) ||
            /WEBVTT|SUBTITLE|caption|timedtext/i.test(text) ||
            /subtitle|webvtt|_sdh_|_cc_|forced/i.test(url);
    }

    function extractSegmentUrls(text, baseUrl) {
        var urls = [];
        text.split(/\r\n|\r|\n/).forEach(function (line) {
            line = line.trim();
            if (!line || line.charAt(0) === '#') return;
            if (/\.vtt(?:[?#]|$)/i.test(line) || /WEBVTT/i.test(line)) {
                urls.push(absoluteUrl(line, baseUrl));
            }
        });
        return urls;
    }

    function downloadAllTracks() {
        if (state.wait || state.langs.length === 0) return;
        state.downloadall = true;
        state.zip = new JSZip();
        state.wait = true;
        state.lastError = '';
        updateUi();

        runSequential(state.langs, function (track) {
            state.status = 'Downloading ' + track.NAME + '...';
            updateUi();
            return buildSubtitleFile(track).then(function (file) {
                state.zip.file(file.name, file.content);
            });
        }).then(function () {
            return state.zip.generateAsync({ type: 'blob' });
        }).then(function (blob) {
            saveAs(blob, safeBaseFilename() + '.subtitles.zip');
            state.status = 'Downloaded all subtitles.';
        }).catch(function (err) {
            state.lastError = 'Download failed: ' + err.message;
        }).then(function () {
            state.wait = false;
            state.downloadall = false;
            updateUi();
        });
    }

    function downloadTrack(track) {
        if (state.wait) return;
        var tracks = tracksWithForcedCompanion(track);
        state.wait = true;
        state.lastError = '';
        state.selectedTrackKey = track.key;
        state.status = 'Downloading ' + downloadTrackNames(tracks) + '...';
        updateUi();

        downloadTrackFiles(tracks, safeBaseFilename() + '.' + safeTrackName(track) + '.with-forced.zip').then(function () {
            state.status = 'Downloaded ' + downloadTrackNames(tracks) + '.';
        }).catch(function (err) {
            state.lastError = 'Download failed: ' + err.message;
        }).then(function () {
            state.wait = false;
            updateUi();
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
        var zip = new JSZip();

        state.wait = true;
        state.lastError = '';
        state.status = 'Downloading English + Korean subtitles' + forcedSummary(tracks) + '...';
        updateUi();

        Promise.all(tracks.map(function (track) {
            return buildSubtitleFile(track).then(function (file) {
                zip.file(file.name, file.content);
            });
        })).then(function () {
            return zip.generateAsync({ type: 'blob' });
        }).then(function (blob) {
            saveAs(blob, safeBaseFilename() + '.en-ko.subtitles.zip');
            state.status = 'Downloaded English + Korean subtitles' + forcedSummary(tracks) + '.';
        }).catch(function (err) {
            state.lastError = 'Download failed: ' + err.message;
        }).then(function () {
            state.wait = false;
            updateUi();
        });
    }

    function downloadTrackFiles(tracks, zipName) {
        tracks = uniqueTracks(tracks);
        if (tracks.length === 1) {
            return buildSubtitleFile(tracks[0]).then(function (file) {
                saveAs(new Blob([file.content], { type: 'text/vtt;charset=utf-8' }), file.name);
            });
        }

        var zip = new JSZip();
        return Promise.all(tracks.map(function (track) {
            return buildSubtitleFile(track).then(function (file) {
                zip.file(file.name, file.content);
            });
        })).then(function () {
            return zip.generateAsync({ type: 'blob' });
        }).then(function (blob) {
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

    function buildSubtitleFile(track) {
        return getTrackVtt(track).then(function (vtt) {
            var output = normalizeVttForDownload(vtt);
            if (!output.trim()) throw new Error('No subtitle cues found.');
            return {
                name: safeBaseFilename() + '.' + safeTrackName(track) + '.vtt',
                content: output
            };
        });
    }

    function getTrackVtt(track) {
        return getText(track.URI).then(function (playlist) {
            if (/^\s*WEBVTT/i.test(playlist)) return playlist;

            var segments = track.segments && track.segments.length ? track.segments : extractSegmentUrls(playlist, track.URI);
            if (!segments.length) throw new Error('No VTT segments found for ' + track.NAME + '.');

            var merged = 'WEBVTT\n\n';
            var successCount = 0;
            return runSequential(segments, function (segmentUrl) {
                return getText(segmentUrl).then(function (segmentText) {
                    var cleaned = cleanVttSegment(segmentText);
                    if (cleaned.trim()) {
                        merged += cleaned.trim() + '\n\n';
                        successCount++;
                    }
                }).catch(function (err) {
                    debuglog('Segment failed: ' + err.message);
                });
            }).then(function () {
                if (successCount === 0) throw new Error('Failed to download subtitle segments.');
                return merged;
            });
        });
    }

    function cleanVttSegment(text) {
        return text
            .replace(/^\uFEFF/, '')
            .replace(/^WEBVTT[^\n]*(?:\n|$)/i, '')
            .replace(/^X-TIMESTAMP-MAP:[^\n]*(?:\n|$)/gmi, '')
            .replace(/\n{3,}/g, '\n\n');
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

    function getText(url, retryCount) {
        retryCount = retryCount || 0;
        return new Promise(function (resolve, reject) {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                onload: function (response) {
                    if (response.status >= 200 && response.status < 300) {
                        resolve(response.responseText || '');
                    } else if (retryCount < MAX_RETRIES) {
                        setTimeout(function () {
                            getText(url, retryCount + 1).then(resolve, reject);
                        }, 150);
                    } else {
                        reject(new Error('HTTP ' + response.status + ' for ' + shortUrl(url)));
                    }
                },
                onerror: function () {
                    if (retryCount < MAX_RETRIES) {
                        setTimeout(function () {
                            getText(url, retryCount + 1).then(resolve, reject);
                        }, 150);
                    } else {
                        reject(new Error('Network error for ' + shortUrl(url)));
                    }
                },
                ontimeout: function () {
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
        refreshMediaMetadataFromDom();
        var title = state.mediaTitle || displayTitle();
        var episodeTag = state.episodeTag || seasonEpisodeTag(playbackInfoText());
        if (episodeTag && title.toUpperCase().indexOf(episodeTag) < 0) {
            title += '.' + episodeTag;
        }
        return sanitizeFilename(title);
    }

    function displayTitle() {
        var title = document.title || metaContent('og:title') || metaContent('twitter:title') || 'DisneyPlus';
        return cleanDisplayTitle(title);
    }

    function cleanDisplayTitle(title) {
        return String(title || 'DisneyPlus')
            .replace(/\s*\|\s*Disney.*$/i, '')
            .replace(/\bS\d{1,2}E\d{1,3}\b/ig, '')
            .replace(/\s+/g, ' ')
            .trim() || 'DisneyPlus';
    }

    function seasonEpisodeTag(text) {
        text = text || playbackInfoText();
        var match;
        var patterns = [
            /\bS(?:eason)?\s*(\d{1,2})\s*[:._ -]*E(?:p(?:isode)?)?\s*(\d{1,3})\b/i,
            /\bSeason\s*(\d{1,2}).{0,24}\bEpisode\s*(\d{1,3})\b/i,
            /\bSeason\s*(\d{1,2}).{0,24}\bEp\.?\s*(\d{1,3})\b/i,
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
