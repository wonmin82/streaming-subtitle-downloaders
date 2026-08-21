from pathlib import Path

path = Path('scripts/coupang-play-subtitles-downloader.user.js')
text = path.read_text(encoding='utf-8')

old = '''    function ttmlRegionFontSize(regionStyle, doc, context) {
        var initial = ttmlInitialFontSize(doc, context);
        if (!initial) return null;
        var value = regionStyle && regionStyle.fontSize || '';
        return value ? ttmlResolveFontSize(value, initial, context) : initial;
    }
'''
new = '''    function ttmlCellFontSizeReference(context) {
        var cells = context && context.cellResolution;
        if (!cells || cells[0] <= 0 || cells[1] <= 0) return null;
        return [100 / cells[0], 100 / cells[1]];
    }

    function ttmlRegionFontSize(regionStyle, doc, context) {
        var initial = ttmlInitialFontSize(doc, context);
        if (!initial) return null;
        var value = regionStyle && regionStyle.fontSize || '';
        if (!value) return initial;
        var cellReference = ttmlCellFontSizeReference(context);
        if (!cellReference) return null;
        return ttmlResolveFontSize(value, cellReference, context);
    }
'''
if text.count(old) != 1:
    raise SystemExit(f'expected one region font-size block, found {text.count(old)}')
text = text.replace(old, new, 1)
path.write_text(text, encoding='utf-8')
