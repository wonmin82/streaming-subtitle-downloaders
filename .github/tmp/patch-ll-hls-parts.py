from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

narrow_services = [
    ROOT / 'scripts/apple-tv-plus-subtitles-downloader.user.js',
    ROOT / 'scripts/disney-plus-subtitles-downloader.user.js',
]
broad = "if (isMediaPlaylist || /\\.(?:vtt|webvtt|ttml|dfxp|srt)(?:[?#]|$)/i.test(line)) {"
narrow = "if (isMediaPlaylist || /\\.(?:vtt|webvtt)(?:[?#]|$)/i.test(line)) {"

for path in narrow_services:
    text = path.read_text()
    if broad in text:
        text = text.replace(broad, narrow, 1)
    elif narrow not in text:
        raise SystemExit(f'{path}: expected HLS media URI matcher not found')
    if '#EXT-X-PART' not in text or 'pendingParts' not in text or 'previousPart' not in text:
        raise SystemExit(f'{path}: LL-HLS implementation missing')
    path.write_text(text)

coupang = ROOT / 'scripts/coupang-play-subtitles-downloader.user.js'
coupang_text = coupang.read_text()
if broad not in coupang_text:
    raise SystemExit('Coupang: expected existing subtitle URI matcher changed')
if '#EXT-X-PART' not in coupang_text or 'pendingParts' not in coupang_text or 'previousPart' not in coupang_text:
    raise SystemExit('Coupang: LL-HLS implementation missing')

expected_versions = {
    ROOT / 'scripts/apple-tv-plus-subtitles-downloader.user.js': '1.0.10',
    ROOT / 'scripts/disney-plus-subtitles-downloader.user.js': '1.0.9',
    ROOT / 'scripts/coupang-play-subtitles-downloader.user.js': '1.0.21',
}
for path, version in expected_versions.items():
    if f'// @version    {version}' not in path.read_text():
        raise SystemExit(f'{path}: version {version} missing')

regression = (ROOT / 'tests/regression.js').read_text()
required = [
    'LL-HLS partial segments cover only the unfinished live edge',
    'completed parent must replace its PARTs while live-edge PARTs remain',
    'GAP range must still advance implicit offset',
]
for marker in required:
    if marker not in regression:
        raise SystemExit(f'regression coverage missing: {marker}')
