from pathlib import Path

netflix_path = Path('scripts/netflix-subtitles-downloader.user.js')
text = netflix_path.read_text(encoding='utf-8')

if text.count('// @version    1.0.1') != 1:
    raise SystemExit('unexpected Netflix version')
text = text.replace('// @version    1.0.1', '// @version    1.0.2', 1)

old = "const STOP_THE_DOWNLOAD = 'NETFLIX_SUBTITLE_DOWNLOADER_STOP_THE_DOWNLOAD';\n"
new = old + "const DOWNLOAD_TIMEOUT = 'NETFLIX_SUBTITLE_DOWNLOADER_DOWNLOAD_TIMEOUT';\n"
if text.count(old) != 1:
    raise SystemExit('stop constant block not found')
text = text.replace(old, new, 1)

old = '''const pickFormat = formats => {
  const preferred = (subFormat === DFXP ? ALL_FORMATS : ALL_FORMATS_prefer_vtt);

  for(let format of preferred) {
    if(typeof formats[format] !== 'undefined')
      return formats[format];
  }
};
'''
new = '''const isUsableFormatCandidate = candidate => {
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
'''
if text.count(old) != 1:
    raise SystemExit('pickFormat block not found')
text = text.replace(old, new, 1)

old = '''  const progress = new ProgressBar(filteredLangs.length);
  let stop = false;
  for(const lang of filteredLangs) {
    const selectedFormat = pickFormat(subs[lang]);
    if(!selectedFormat)
      continue;
    const [cachedUrls, extension] = selectedFormat;
    const urls = cachedUrls.slice();
    while(urls.length > 0) {
      let url = popRandomElement(urls);
      const resultPromise = fetch(url, {mode: "cors"});
      let result;
      try {
        // Promise.any isn't supported in all browsers, use Promise.race instead
        result = await Promise.race([resultPromise, progress.stop, asyncSleep(30, STOP_THE_DOWNLOAD)]);
      }
      catch(e) {
        // the only promise that can be rejected is the one from fetch
        // if that happens we want to stop the download anyway
        result = STOP_THE_DOWNLOAD;
      }
      if(result === STOP_THE_DOWNLOAD) {
        stop = true;
        break;
      }
      progress.increment();
      const data = await result.text();
      if(data.length > 0) {
        downloaded.push({lang, data, extension});
        break;
      }
    }
    if(stop)
      break;
  }
'''
new = '''  const progress = new ProgressBar(filteredLangs.length);
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
'''
if text.count(old) != 1:
    raise SystemExit('download loop block not found')
text = text.replace(old, new, 1)
netflix_path.write_text(text, encoding='utf-8')

reg_path = Path('tests/regression.js')
reg = reg_path.read_text(encoding='utf-8')
needle = "console.log(`# ${passed} regression groups passed`);\n"
addition = '''test('netflix: download fallback skips unusable candidates and failed mirrors', () => {
  const source = sources.netflix;
  requireText(source, "const DOWNLOAD_TIMEOUT = 'NETFLIX_SUBTITLE_DOWNLOADER_DOWNLOAD_TIMEOUT';", 'distinct download timeout');
  requireText(source, 'const isUsableFormatCandidate = candidate =>', 'usable format guard');
  requireText(source, 'isUsableFormatCandidate(formats[format])', 'format fallback guard');
  requireText(source, 'result.ok !== true', 'HTTP status validation');
  requireText(source, 'subtitle fetch failed, trying another URL', 'network mirror fallback');
  requireText(source, 'subtitle fetch timed out, trying another URL', 'timeout mirror fallback');
  requireText(source, 'subtitle response could not be read, trying another URL', 'body-read mirror fallback');
});

'''
if reg.count(needle) != 1:
    raise SystemExit('regression footer not found')
reg = reg.replace(needle, addition + needle, 1)
reg_path.write_text(reg, encoding='utf-8')
