// ==UserScript==
// @name       Disney+ Subtitles Downloader
// @namespace  https://github.com/wonmin82/streaming-subtitle-downloaders
// @description Download subtitles from Disney+
// @version    1.0.15
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
// @require    https://cdn.jsdelivr.net/npm/jszip@3.7.1/dist/jszip.min.js
// @require    https://cdn.jsdelivr.net/npm/file-saver@2.0.5/dist/FileSaver.min.js
// @run-at     document-start
// ==/UserScript==

(function () {
    'use strict';

    var debug = location.hash === '#debug' || location.hash.indexOf('dpsd_debug') >= 0;
    var MAX_RETRIES = 5;
    var RETRY_BASE_DELAY_MS = 250;
    var RETRY_MAX_DELAY_MS = 4000;
    var LOG_PREFIX = '[Disney+ Subtitles DL]';
    var targetWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    var state = {
        initialized: false,
        installedHooks: false,
        observer: null,
        oldlocation: null,
        playbackSessionSequence: 0,
        playbackSessionId: '',
        playbackSessionStartedAt: 0,
        downloadOperationSequence: 0,
        activeDownloadOperationId: 0,
        langs: [],
        langKeys: {},
        seenManifestUrls: {},
        seenResourceUrls: {},
        playbackScanStartedAt: 0,
        lastPerformanceScanAt: 0,
        performanceEntryCount: 0,
        selectedTrackKey: '',
        userSelectedTrack: false,
        mediaTitle: '',
        seasonNumber: null,
        episodeNumber: null,
        episodeTag: '',
        episodeMetadataTitle: '',
        shadowControlsRoot: null,
        shadowControlsObserver: null,
        shadowTitleRoot: null,
        shadowTitleObserver: null,
        shadowMetadataUiTimer: null,
        wait: false,
        status: 'Waiting for playback...',
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

    init();

    function init() {
        if (state.initialized) return;
        state.initialized = true;

        installStyles();
        installNavigationHooks();
        tick();
        installNetworkHooks();
        startPerformanceObserver();
        scheduleUi();
        setInterval(tick, 1000);
        debuglog('Script loaded');
    }

    function tick() {
        var playbackPage = isPlaybackPage();
        var playbackKey = playbackPage ? location.href.split('#')[0] : '';
        if (state.oldlocation !== playbackKey) {
            state.oldlocation = playbackKey;
            if (playbackPage) {
                beginPlaybackSession();
                state.status = 'Scanning playback...';
                resetSubtitleTracks();
                resetShadowMetadataObservers();
                resetMediaMetadata();
                refreshMediaMetadataFromDom();
                scanPerformanceEntries(true);
                state.lastPerformanceScanAt = Date.now();
                updateUi();
            } else {
                resetShadowMetadataObservers();
                invalidatePlaybackSession();
            }
        }

        if (playbackPage) {
            ensureWidget();
            var now = Date.now();
            if (now - state.lastPerformanceScanAt >= 5000) {
                scanPerformanceEntries();
                state.lastPerformanceScanAt = now;
            }
        } else {
            var root = document.getElementById('dpsd-root');
            if (root) root.style.display = 'none';
        }
    }

    function installNavigationHooks() {
        var historyObject;
        try {
            if (window.top !== window) return;
            historyObject = targetWindow.history || window.history;
        } catch (err) {
            return;
        }

        ['pushState', 'replaceState'].forEach(function (method) {
            try {
                if (!historyObject || typeof historyObject[method] !== 'function') return;
                var original = historyObject[method];
                if (original.__dpsdSessionPatched) return;
                var wrapped = function () {
                    var result = original.apply(this, arguments);
                    try { tick(); } catch (err) { debuglog('Navigation sync failed: ' + err.message); }
                    return result;
                };
                wrapped.__dpsdSessionPatched = true;
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

    function isPlaybackPage() {
        return /(?:^|\/)play(?:\/|$)/i.test(location.pathname || '');
    }

    function beginPlaybackSession(lookbackMs) {
        invalidateDownloadOperation();
        var requestedLookbackMs = Number(lookbackMs);
        var initialLookbackMs = isFinite(requestedLookbackMs) && requestedLookbackMs >= 0
            ? Math.min(requestedLookbackMs, 5000)
            : (state.playbackSessionSequence === 0 ? 5000 : 0);
        state.playbackSessionSequence++;
        state.playbackSessionId = 'disney:' + state.playbackSessionSequence + ':' + Date.now().toString(36) + ':' + Math.random().toString(36).slice(2);
        state.playbackSessionStartedAt = Math.max(0, performanceNow() - initialLookbackMs);
    }

    function invalidatePlaybackSession() {
        invalidateDownloadOperation();
        if (!state.playbackSessionId) return;
        state.playbackSessionId = '';
        state.playbackSessionStartedAt = performanceNow();
    }

    function isPlaybackSessionCurrent(sessionId) {
        return !!sessionId && sessionId === state.playbackSessionId;
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
        if (!isPlaybackPage()) return;
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
                '<li class="dpsd-info">Output file: <span id="dpsd-filename">Waiting for a subtitle track...</span></li>' +
                '<li class="dpsd-info">Progress: <span id="dpsd-progress-text">Idle</span><progress id="dpsd-progress" max="1" value="0"></progress></li>' +
                '<li id="dpsd-rescan" role="button" tabindex="0">Rescan playback resources</li>' +
                '<li class="dpsd-info">Status: <span id="dpsd-status">Waiting for playback...</span></li>' +
            '</ol>';

        document.body.appendChild(root);

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
                    recordResourceUrl(arguments[1], 'xhr', this.__dpsdSessionId);
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
                        inspectMetadataResponse(xhr.__dpsdUrl, responseText, xhr.__dpsdSessionId);
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
                recordResourceUrl(url, 'fetch', sessionId);
                return originalFetch.apply(this, arguments).then(function (response) {
                    inspectFetchMetadataResponse(url || response.url, response, sessionId);
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
        if (isPlaybackPage()) scanPerformanceEntries();
        try {
            if (!targetWindow.PerformanceObserver) return;
            state.observer = new targetWindow.PerformanceObserver(function (list) {
                if (!isPlaybackPage()) return;
                list.getEntries().forEach(function (entry) {
                    if (state.playbackSessionStartedAt && typeof entry.startTime === 'number' && entry.startTime < state.playbackSessionStartedAt) return;
                    if (isDisneyPlaybackResourceUrl(entry.name)) {
                        recordResourceUrl(entry.name, 'performance');
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
            if (!isPlaybackPage()) return;
            var perf = targetWindow.performance || window.performance;
            if (!perf || !perf.getEntriesByType) return;
            var entries = perf.getEntriesByType('resource');
            var start = rescanAll || entries.length < state.performanceEntryCount ? 0 : state.performanceEntryCount;
            for (var i = start; i < entries.length; i++) {
                var entry = entries[i];
                if (state.playbackScanStartedAt && typeof entry.startTime === 'number' && entry.startTime < state.playbackScanStartedAt) continue;
                if (isDisneyPlaybackResourceUrl(entry.name)) {
                    recordResourceUrl(entry.name, 'performance-scan');
                }
            }
            state.performanceEntryCount = entries.length;
        } catch (err) {
            debuglog('Performance scan failed: ' + err.message);
        }
    }

    function isDisneyPlaybackResourceUrl(rawUrl) {
        var url = normalizeUrl(rawUrl);
        return /\.m3u8(?:[?#]|$)/i.test(url || '');
    }

    function recordResourceUrl(rawUrl, source, sessionId) {
        sessionId = sessionId == null ? state.playbackSessionId : sessionId;
        if (!isPlaybackSessionCurrent(sessionId)) return;
        var url = normalizeUrl(rawUrl);
        if (!url || state.seenResourceUrls[url]) return;
        state.seenResourceUrls[url] = true;

        if (/\.m3u8(?:[?#]|$)/i.test(url)) {
            queueManifest(url, source, sessionId);
        }
    }

    function inspectFetchMetadataResponse(url, response, sessionId) {
        if (!isPlaybackSessionCurrent(sessionId)) return;
        if (!shouldInspectMetadataUrl(url) || !response || !response.clone) return;
        try {
            response.clone().text().then(function (text) {
                inspectMetadataResponse(url, text, sessionId);
            }).catch(function () {});
        } catch (err) {}
    }

    function inspectMetadataResponse(url, text, sessionId) {
        if (!isPlaybackSessionCurrent(sessionId)) return;
        if (!shouldInspectMetadataUrl(url) || typeof text !== 'string' || !text) return;
        if (text.length > 2000000) return;

        var metadata = extractMetadataFromText(text);
        var hasEpisodeMetadata = metadata.episodeTag || (metadata.seasonNumber && metadata.episodeNumber);
        if (hasEpisodeMetadata && !metadata.title) {
            delete metadata.episodeTag;
            delete metadata.seasonNumber;
            delete metadata.episodeNumber;
            debuglog('Ignored episode metadata without a matching series title from ' + shortUrl(url));
        }
        if (metadata.title || metadata.episodeTag || (metadata.seasonNumber && metadata.episodeNumber)) {
            updateMediaMetadata(metadata);
        }
    }

    function shouldInspectMetadataUrl(url) {
        url = normalizeUrl(url);
        if (!url) return false;
        if (/\.(m3u8|vtt|mp4|mp4a|m4s|bif|png|jpg|jpeg|webp|woff2?)(?:[?#]|$)/i.test(url)) return false;
        if (/(?:upnext|explore|recommend(?:ation)?s?)/i.test(url)) return false;
        return /disney|bamgrid|dssott|dssedge|graphql|playerExperience|deeplink/i.test(url);
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

        var metadataTitle = metadata.title ? cleanDisplayTitle(metadata.title) : '';

        if (metadataTitle) {
            if (!/\bS\d{1,2}E\d{1,3}\b/i.test(metadataTitle)) state.mediaTitle = metadataTitle;
        }

        if (metadata.seasonNumber && metadata.episodeNumber) {
            state.seasonNumber = metadata.seasonNumber;
            state.episodeNumber = metadata.episodeNumber;
            state.episodeTag = formatSeasonEpisode(metadata.seasonNumber, metadata.episodeNumber);
            if (metadataTitle) state.episodeMetadataTitle = metadataTitle;
        }

        if (metadata.episodeTag) {
            state.episodeTag = metadata.episodeTag;
            if (metadataTitle) state.episodeMetadataTitle = metadataTitle;
        }
    }

    function resetMediaMetadata() {
        state.mediaTitle = '';
        state.seasonNumber = null;
        state.episodeNumber = null;
        state.episodeTag = '';
        state.episodeMetadataTitle = '';
    }

    function resetSubtitleTracks() {
        state.langs = [];
        state.langKeys = {};
        state.seenManifestUrls = {};
        state.seenResourceUrls = {};
        state.playbackScanStartedAt = state.playbackSessionStartedAt || performanceNow();
        state.performanceEntryCount = 0;
        state.lastPerformanceScanAt = 0;
        state.selectedTrackKey = '';
        state.userSelectedTrack = false;
        state.lastError = '';
        state.outputFilename = '';
        state.progressCompleted = 0;
        state.progressTotal = 0;
        state.progressLabel = 'Idle';
    }

    function disconnectShadowObserver(observer) {
        try {
            if (observer) observer.disconnect();
        } catch (err) {}
    }

    function resetShadowMetadataObservers() {
        disconnectShadowObserver(state.shadowControlsObserver);
        disconnectShadowObserver(state.shadowTitleObserver);
        state.shadowControlsRoot = null;
        state.shadowControlsObserver = null;
        state.shadowTitleRoot = null;
        state.shadowTitleObserver = null;
        if (state.shadowMetadataUiTimer) clearTimeout(state.shadowMetadataUiTimer);
        state.shadowMetadataUiTimer = null;
    }

    function shadowMutationObserver() {
        try { return targetWindow.MutationObserver || window.MutationObserver; } catch (err) { return null; }
    }

    function scheduleShadowMetadataRefresh() {
        if (state.shadowMetadataUiTimer) return;
        state.shadowMetadataUiTimer = setTimeout(function () {
            state.shadowMetadataUiTimer = null;
            if (!isPlaybackPage() || !state.playbackSessionId) return;
            refreshMediaMetadataFromDom();
            updateUi();
        }, 0);
    }

    function firstShadowPlaybackTitle(text) {
        var lines = String(text || '').split(/[\r\n]+/);
        for (var i = 0; i < lines.length; i++) {
            var line = String(lines[i] || '').replace(/\s+/g, ' ').trim();
            if (!line || seasonEpisodeTag(line)) continue;
            var title = cleanDisplayTitle(line);
            if (title && title !== 'DisneyPlus') return title;
        }
        return '';
    }

    function shadowPlaybackMetadata(titleRoot) {
        if (!titleRoot) return null;
        var text = '';
        try { text = titleRoot.innerText || titleRoot.textContent || ''; } catch (err) {}
        var episodeTag = seasonEpisodeTag(text);
        if (!episodeTag) return null;
        return {
            title: activePlaybackTitle(activePlaybackContainer()) || firstShadowPlaybackTitle(text) || displayTitle(),
            episodeTag: episodeTag
        };
    }

    function connectShadowTitleObserver() {
        var titleRoot = null;
        try {
            var titleBug = state.shadowControlsRoot && state.shadowControlsRoot.querySelector('title-bug');
            titleRoot = titleBug && titleBug.shadowRoot;
        } catch (err) {}
        if (titleRoot === state.shadowTitleRoot) return false;

        disconnectShadowObserver(state.shadowTitleObserver);
        state.shadowTitleObserver = null;
        state.shadowTitleRoot = titleRoot || null;
        var Observer = shadowMutationObserver();
        if (state.shadowTitleRoot && Observer) {
            try {
                state.shadowTitleObserver = new Observer(scheduleShadowMetadataRefresh);
                state.shadowTitleObserver.observe(state.shadowTitleRoot, {
                    childList: true,
                    subtree: true,
                    characterData: true
                });
            } catch (err) {
                disconnectShadowObserver(state.shadowTitleObserver);
                state.shadowTitleObserver = null;
            }
        }
        return true;
    }

    function observeShadowPlaybackMetadata() {
        var controlsRoot = null;
        try {
            var controls = document.querySelector('main-app-controls-overlay');
            controlsRoot = controls && controls.shadowRoot;
        } catch (err) {}

        if (controlsRoot !== state.shadowControlsRoot) {
            disconnectShadowObserver(state.shadowControlsObserver);
            disconnectShadowObserver(state.shadowTitleObserver);
            state.shadowControlsRoot = controlsRoot || null;
            state.shadowControlsObserver = null;
            state.shadowTitleRoot = null;
            state.shadowTitleObserver = null;
            var Observer = shadowMutationObserver();
            if (state.shadowControlsRoot && Observer) {
                try {
                    state.shadowControlsObserver = new Observer(function () {
                        if (connectShadowTitleObserver()) scheduleShadowMetadataRefresh();
                    });
                    state.shadowControlsObserver.observe(state.shadowControlsRoot, {
                        childList: true,
                        subtree: true
                    });
                } catch (err) {
                    disconnectShadowObserver(state.shadowControlsObserver);
                    state.shadowControlsObserver = null;
                }
            }
        }

        connectShadowTitleObserver();
        return shadowPlaybackMetadata(state.shadowTitleRoot);
    }

    function activePlaybackContainer() {
        var selectors = [
            '[data-testid="disney-web-player-wrapper"]',
            '[data-testid="disney-web-player-container"]',
            '[data-testid="playback-view"]',
            '[data-testid="video-player"]',
            '[data-testid="player-container"]',
            '[data-testid="playback-container"]',
            '[data-testid="player-controls"]'
        ];
        for (var i = 0; i < selectors.length; i++) {
            try {
                var container = document.querySelector(selectors[i]);
                if (container) return container;
            } catch (err) {}
        }
        try {
            var video = document.querySelector('video');
            if (video) return video.closest('main,[role="dialog"]') || video.parentElement;
        } catch (err) {}
        return null;
    }

    function activePlaybackTitle(container) {
        container = container || activePlaybackContainer();
        if (!container) return '';
        var selectors = [
            '[data-testid="player-metadata-title"]',
            '[data-testid="playback-title"]',
            '[data-testid="video-title"]',
            '[data-testid*="player"][data-testid*="title"]',
            'video[aria-label]',
            'h1',
            'h2'
        ];
        for (var i = 0; i < selectors.length; i++) {
            try {
                var node = container.querySelector(selectors[i]);
                var rawTitle = node && (node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent);
                var title = cleanDisplayTitle(rawTitle);
                if (title && title !== 'DisneyPlus' && !/^S\d{1,2}E\d{1,3}$/i.test(title)) return title;
            } catch (err) {}
        }
        return '';
    }

    function activePlaybackInfoText(container) {
        container = container || activePlaybackContainer();
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

    function playbackMetadataChanged(playbackTitle, playbackEpisodeTag) {
        var titleChanged = playbackTitle && state.mediaTitle && !mediaTitlesMatch(playbackTitle, state.mediaTitle);
        var episodeChanged = playbackEpisodeTag && state.episodeTag && playbackEpisodeTag !== state.episodeTag;
        return !!(titleChanged || episodeChanged);
    }

    function restartPlaybackSessionForMetadataChange() {
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
        var shadowMetadata = observeShadowPlaybackMetadata();
        var container = activePlaybackContainer();
        var playbackTitle = (shadowMetadata && shadowMetadata.title) || activePlaybackTitle(container) || displayTitle();
        var scopedPlaybackText = activePlaybackInfoText(container);
        var playbackEpisodeTag = (shadowMetadata && shadowMetadata.episodeTag) ||
            seasonEpisodeTag(scopedPlaybackText || (!container ? playbackInfoText() : ''));
        if (playbackMetadataChanged(playbackTitle, playbackEpisodeTag)) restartPlaybackSessionForMetadataChange();
        updateMediaMetadata({
            title: playbackTitle,
            episodeTag: playbackEpisodeTag
        });
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
        state.status = 'Found manifest via ' + source + '. Reading tracks...';
        updateUi();

        getText(url).then(function (text) {
            if (!isPlaybackSessionCurrent(sessionId)) return;
            state.seenManifestUrls[url] = 'loaded';
            if (/^Could not read manifest:/.test(state.lastError || '')) state.lastError = '';
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
            updateUi();
        });
    }

    function parseManifest(url, text, sessionId) {
        if (!isPlaybackSessionCurrent(sessionId)) return;
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

        if (incomingScore > existingScore) {
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
            if (isMediaPlaylist || /\.(?:vtt|webvtt)(?:[?#]|$)/i.test(line)) {
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
        return operation;
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
        }).catch(function (err) {
            if (isDownloadOperationCurrent(operation)) {
                state.lastError = 'Download failed: ' + err.message;
                state.progressLabel = 'Failed';
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
            if (/^\s*WEBVTT/i.test(playlist)) {
                addDownloadProgressTotal(operation, 1, 'Downloading ' + track.NAME + '...');
                advanceDownloadProgress(operation, 'Downloading ' + track.NAME + '...');
                return playlist;
            }

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
                    var cleaned = normalizeHlsVttSegment(values[0], timestampState, values[1]);
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
        refreshMediaMetadataFromDom();
        var title = state.mediaTitle || displayTitle();
        var episodeTag = state.episodeTag || seasonEpisodeTag(playbackInfoText());
        if (episodeTag && state.episodeMetadataTitle && !mediaTitlesMatch(title, state.episodeMetadataTitle)) {
            debuglog('Ignored episode metadata for a different title: ' + state.episodeMetadataTitle);
            episodeTag = '';
        }
        if (episodeTag && title.toUpperCase().indexOf(episodeTag) < 0) {
            title += '.' + episodeTag;
        }
        return sanitizeFilename(title);
    }

    function normalizedMediaTitleForComparison(title) {
        return cleanDisplayTitle(title)
            .toLowerCase()
            .replace(/[^a-z0-9\u00c0-\uffff]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function mediaTitlesMatch(left, right) {
        var normalizedLeft = normalizedMediaTitleForComparison(left);
        var normalizedRight = normalizedMediaTitleForComparison(right);
        if (!normalizedLeft || !normalizedRight) return false;
        if (normalizedLeft === normalizedRight) return true;
        return Math.min(normalizedLeft.length, normalizedRight.length) >= 4 &&
            (normalizedLeft.indexOf(normalizedRight) >= 0 || normalizedRight.indexOf(normalizedLeft) >= 0);
    }

    function displayTitle() {
        var title = document.title || metaContent('og:title') || metaContent('twitter:title') || 'DisneyPlus';
        return cleanDisplayTitle(title);
    }

    function cleanDisplayTitle(title) {
        return String(title || 'DisneyPlus')
            .replace(/\s*\|\s*(?:Disney(?:\+|\s*Plus)?|\uB514\uC988\uB2C8\+).*$/i, '')
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
