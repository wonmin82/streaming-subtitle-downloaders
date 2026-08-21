from pathlib import Path

path = Path('scripts/coupang-play-subtitles-downloader.user.js')
text = path.read_text(encoding='utf-8')

replacements = [
    ('// @version    1.0.18', '// @version    1.0.19'),
    ("['fontWeight', 'fontStyle', 'textDecoration', 'ruby', 'fontSize', 'origin', 'extent', 'position', 'textAlign', 'displayAlign', 'writingMode']", "['fontWeight', 'fontStyle', 'textDecoration', 'ruby', 'fontSize', 'textCombine', 'textOrientation', 'origin', 'extent', 'position', 'textAlign', 'displayAlign', 'writingMode']"),
    ("['fontWeight', 'fontStyle', 'textDecoration'].forEach(function (name) {", "['fontWeight', 'fontStyle', 'textDecoration', 'textCombine', 'textOrientation'].forEach(function (name) {"),
]
for old, new in replacements:
    if text.count(old) != 1:
        raise SystemExit(f'expected one occurrence of {old!r}, found {text.count(old)}')
    text = text.replace(old, new, 1)

old = """        return 'WEBVTT\\n\\n' + cues.join('\\n\\n') + '\\n';
    }

    function ttmlHasParserError(doc) {
"""
new = """        return ttmlVttDocument(cues);
    }

    function ttmlVttDocument(cues) {
        var body = (cues || []).join('\\n\\n');
        var header = 'WEBVTT\\n\\n';
        if (body.indexOf('<c.ttml-combine>') >= 0) {
            header += 'STYLE\\n::cue(.ttml-combine) { text-combine-upright: all; }\\n\\n';
        }
        return header + body + '\\n';
    }

    function ttmlHasParserError(doc) {
"""
if text.count(old) != 1:
    raise SystemExit('ttmlToVtt return block not found')
text = text.replace(old, new, 1)

old = """        var inherited = {
            bold: false,
            italic: false,
            underline: false,
            ruby: 'none'
        };
"""
new = """        var inherited = {
            bold: false,
            italic: false,
            underline: false,
            ruby: 'none',
            textCombine: 'none',
            textOrientation: 'mixed'
        };
"""
if text.count(old) != 2:
    raise SystemExit(f'expected two inherited presentation blocks, found {text.count(old)}')
text = text.replace(old, new, 2)

old = """            inherited.bold = parentStyle.bold;
            inherited.italic = parentStyle.italic;
            inherited.underline = parentStyle.underline;
"""
new = """            inherited.bold = parentStyle.bold;
            inherited.italic = parentStyle.italic;
            inherited.underline = parentStyle.underline;
            inherited.textCombine = parentStyle.textCombine;
            inherited.textOrientation = parentStyle.textOrientation;
"""
if text.count(old) != 2:
    raise SystemExit(f'expected two presentation inheritance blocks, found {text.count(old)}')
text = text.replace(old, new, 2)

old = """        inherited.ruby = specified.ruby ? String(specified.ruby) : 'none';
        return inherited;
    }
"""
new = """        inherited.ruby = specified.ruby ? String(specified.ruby) : 'none';
        if (specified.textCombine) inherited.textCombine = String(specified.textCombine).toLowerCase() === 'all' ? 'all' : 'none';
        if (specified.textOrientation) {
            var textOrientation = String(specified.textOrientation).toLowerCase();
            inherited.textOrientation = /^(?:mixed|upright|sideways)$/.test(textOrientation) ? textOrientation : 'mixed';
        }
        return inherited;
    }
"""
if text.count(old) != 2:
    raise SystemExit(f'expected two presentation tails, found {text.count(old)}')
text = text.replace(old, new, 2)

old = """    function ttmlWrapVttText(value, style) {
        var open = '';
        var close = '';
        if (style && style.bold) {
"""
new = """    function ttmlWrapVttText(value, style) {
        var open = '';
        var close = '';
        if (style && style.textCombine === 'all') {
            open += '<c.ttml-combine>';
            close = '</c>' + close;
        }
        if (style && style.bold) {
"""
if text.count(old) != 1:
    raise SystemExit('ttmlWrapVttText block not found')
text = text.replace(old, new, 1)

path.write_text(text, encoding='utf-8')
