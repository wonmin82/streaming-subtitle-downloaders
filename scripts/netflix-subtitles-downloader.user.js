// ==UserScript==
// @name       Netflix Subtitles Downloader
// @namespace  https://github.com/wonmin82/streaming-subtitle-downloaders
// @description Download subtitles from Netflix
// @version    1.0.4
// @author     Tithen-Firion; modifications by Wonmin Jung
// @license    MIT
// @homepageURL https://github.com/wonmin82/streaming-subtitle-downloaders
// @downloadURL https://raw.githubusercontent.com/wonmin82/streaming-subtitle-downloaders/main/scripts/netflix-subtitles-downloader.user.js
// @updateURL  https://raw.githubusercontent.com/wonmin82/streaming-subtitle-downloaders/main/scripts/netflix-subtitles-downloader.user.js
// @match      https://www.netflix.com/*
// @grant      unsafeWindow
// @require    https://cdn.jsdelivr.net/npm/jszip@3.7.1/dist/jszip.min.js
// @require    https://cdn.jsdelivr.net/npm/file-saver-es@2.0.5/dist/FileSaver.min.js
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
  }

  increment() {
    this.current += 1;
    if(this.current <= this.max) {
      let p = this.current / this.max * 100;
      this.progressElement.style.background = `linear-gradient(to right, green ${p}%, transparent ${p}%)`;
    }
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

#subtitle-downloader-menu:not(.series) .series{ display: none; }
#subtitle-downloader-menu.series .not-series{ display: none; }
`;

const SUB_TYPES = {
  'subtitles': '',
  'closedcaptions': '[cc]'
};

let idOverrides = {};
let subCache = {};
let titleCache = {};
let subCacheWaitGeneration = 0;
let batchDownloadInProgress = false;

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
  menu.style.display = (isWatchPage() ? '' : 'none');
};

const ensureMenu = () => {
  if(!document.body)
    return null;

  let menu = document.querySelector('#subtitle-downloader-menu');
  if(menu === null) {
    menu = document.createElement('div');
    menu.id = 'subtitle-downloader-menu';
    menu.innerHTML = DOWNLOAD_MENU;
    document.body.appendChild(menu);
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
  syncMenuVisibility(menu);
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
  }
  else {
    console.debug('[Netflix Subtitle Downloader] unknown video type:', type, result)
    return;
  }
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

const playbackTitleFromDom = () => {
  const player = document.querySelector('[data-uia="watch-video"]') ||
    document.querySelector('.watch-video');
  if(!player)
    return '';
  const selectors = [
    '[data-uia="evidence-overlay"] h2',
    '[data-uia="video-title"]',
    'h1',
    'h2'
  ];

  for(const selector of selectors) {
    let node = null;
    try {
      node = player.querySelector(selector);
    }
    catch(ignore) {}
    const title = normalizeDomTitle(node && node.textContent);
    if(title && title.length <= 300 && title.toLowerCase() !== 'netflix')
      return title;
  }
  return '';
};

const getTitleEntry = silent => {
  const cached = getXFromCache(titleCache, 'title', true);
  if(cached !== null)
    return cached;

  const title = playbackTitleFromDom();
  if(title) {
    const fallback = {type: 'movie', title};
    titleCache[getVideoId()] = fallback;
    return fallback;
  }

  if(silent === true)
    return null;
  return getXFromCache(titleCache, 'title');
};

const pad = (number, letter) => `${letter}${number.toString().padStart(2, '0')}`;
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const safeTitle = title => title.trim().replace(/[:*?"<>|\\\/]+/g, '_').replace(/ /g, '.');

const getTitleFromCache = () => {
  const title = getTitleEntry();
  const titleParts = [title.title];
  if(title.type === 'show') {
    const season = pad(title.season, 'S');
    if(title.hiddenNumber) {
      titleParts.push(season);
      titleParts.push(title.subtitle);
    }
    else {
      titleParts.push(season + pad(title.episode, 'E'));
      if(epTitleInFilename)
        titleParts.push(title.subtitle);
    }
  }
  return [safeTitle(titleParts.join('.')), safeTitle(title.title)];
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


const _save = async (_zip, title) => {
  const content = await _zip.generateAsync({type:'blob'});
  saveAs(content, title + '.zip');
};

const _download = async _zip => {
  const subs = getSubsFromCache();
  const [title, seriesTitle] = getTitleFromCache();
  const downloaded = [];

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

  const progress = new ProgressBar(filteredLangs.length);
  let stop = false;
  for(const lang of filteredLangs) {
    const selectedFormat = pickFormat(subs[lang]);
    if(!selectedFormat) {
      progress.increment();
      continue;
    }
    const [cachedUrls, extension] = selectedFormat;
    const urls = cachedUrls.filter(url => typeof url === 'string' && url.length > 0);
    while(urls.length > 0) {
      const url = popRandomElement(urls);
      let result;
      try {
        result = await Promise.race([
          fetch(url, {mode: "cors"}),
          progress.stop,
          asyncSleep(30, DOWNLOAD_TIMEOUT)
        ]);
      }
      catch(error) {
        console.warn('[Netflix Subtitle Downloader] subtitle fetch failed, trying another URL', url, error);
        continue;
      }
      if(result === STOP_THE_DOWNLOAD) {
        stop = true;
        break;
      }
      if(result === DOWNLOAD_TIMEOUT) {
        console.warn('[Netflix Subtitle Downloader] subtitle fetch timed out, trying another URL', url);
        continue;
      }
      if(!result || result.ok !== true) {
        console.warn('[Netflix Subtitle Downloader] subtitle HTTP request failed, trying another URL', url, result && result.status);
        continue;
      }
      let data;
      try {
        data = await result.text();
      }
      catch(error) {
        console.warn('[Netflix Subtitle Downloader] subtitle response could not be read, trying another URL', url, error);
        continue;
      }
      if(data.length > 0) {
        downloaded.push({lang, data, extension});
        break;
      }
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

  return [seriesTitle, stop];
};

const downloadThis = async () => {
  const _zip = new JSZip();
  const [title, stop] = await _download(_zip);
  _save(_zip, title);
};

const cleanBatch = async () => {
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
      await cleanBatch();
      return;
    }
  }
  else
    zip = new JSZip();

  try {
    [title, stop] = await _download(zip);
  }
  catch(error) {
    title = 'unknown';
    stop = true;
  }

  const id = parseInt(getVideoId());
  batch = batch.filter(x => x !== id);

    if(stop || batch.length == 0) {
      await _save(zip, title);
      await cleanBatch();
    }
    else {
      setBatch(batch);
      await cache.put('/subs.zip', new Response(await zip.generateAsync({type:'blob'})));
      await asyncSleep(batchDelay);
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
  batch = batchAll.slice();
  downloadBatch();
};

const downloadSeason = () => {
  batch = batchSeason.slice();
  downloadBatch();
};

const downloadToEnd = () => {
  batch = batchToEnd.slice();
  downloadBatch();
};

const processMessage = e => {
  if(!e || !e.detail)
    return;
  const {type, data} = e.detail;
  if(type === 'subs')
    processSubInfo(data);
  else if(type === 'id_override')
    idOverrides[data[0]] = data[1];
  else if(type === 'metadata')
    processMetadata(data);
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

const observer = new MutationObserver(function(mutations) {
  ensureMenu();
  mutations.forEach(function(mutation) {
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
  ensureMenu();
  if(!observerStarted) {
    observer.observe(document.body, { childList: true, subtree: true });
    observerStarted = true;
  }
};

if(document.body)
  initializeDom();
else
  document.addEventListener('DOMContentLoaded', initializeDom, {once: true});
