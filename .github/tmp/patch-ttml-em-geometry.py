from pathlib import Path

path = Path('scripts/coupang-play-subtitles-downloader.user.js')
text = path.read_text(encoding='utf-8')

def replace_once(old, new):
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'expected exactly one match, found {count}: {old[:80]!r}')
    text = text.replace(old, new, 1)

replace_once('// @version    1.0.16', '// @version    1.0.17')
replace_once("['fontWeight', 'fontStyle', 'textDecoration', 'ruby', 'origin', 'extent', 'position', 'textAlign', 'displayAlign', 'writingMode']", "['fontWeight', 'fontStyle', 'textDecoration', 'ruby', 'fontSize', 'origin', 'extent', 'position', 'textAlign', 'displayAlign', 'writingMode']")

old = '''    function ttmlLayoutContext(doc) {
        return {
            rootPixelExtent: ttmlRootPixelExtent(doc),
            cellResolution: ttmlCellResolution(doc)
        };
    }

    function ttmlLengthToPercentage(value, axis, context) {
        var match = String(value || '').trim().match(/^([+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+))(px|c|rw|rh)$/i);
'''
new = '''    function ttmlLayoutContext(doc, fontSize) {
        return {
            rootPixelExtent: ttmlRootPixelExtent(doc),
            cellResolution: ttmlCellResolution(doc),
            fontSize: fontSize || null
        };
    }

    function ttmlConvertPercentageAxis(value, fromAxis, toAxis, context) {
        value = Number(value);
        if (!isFinite(value)) return null;
        if (fromAxis === toAxis) return value;
        var root = context && context.rootPixelExtent;
        if (!root || root[0] <= 0 || root[1] <= 0) return null;
        if (fromAxis === 'h' && toAxis === 'v') return value * root[0] / root[1];
        if (fromAxis === 'v' && toAxis === 'h') return value * root[1] / root[0];
        return null;
    }

    function ttmlInitialFontSizeValue(doc) {
        var value = '';
        Array.prototype.slice.call(doc && doc.getElementsByTagName('*') || []).forEach(function (node) {
            if (localName(node) !== 'initial') return;
            var candidate = ttmlAttribute(node, 'fontSize');
            if (candidate) value = candidate;
        });
        return value || '1c';
    }

    function ttmlFontSizeRelativeFactor(value) {
        var match = String(value || '').trim().match(/^([+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+))(em|%)$/i);
        if (!match) return null;
        var amount = Number(match[1]);
        if (!isFinite(amount) || amount < 0) return null;
        return match[2].toLowerCase() === 'em' ? amount : amount / 100;
    }

    function ttmlResolveFontSize(value, parentSize, context) {
        var tokens = String(value || '').trim().split(/\\s+/).filter(Boolean);
        if (tokens.length < 1 || tokens.length > 2) return null;
        var baseContext = {
            rootPixelExtent: context && context.rootPixelExtent || null,
            cellResolution: context && context.cellResolution || null,
            fontSize: null
        };

        function component(token, axis, parentComponent) {
            var relative = ttmlFontSizeRelativeFactor(token);
            if (relative !== null) {
                if (!parentSize || !isFinite(parentComponent)) return null;
                return parentComponent * relative;
            }
            return ttmlLengthToPercentage(token, axis, baseContext);
        }

        if (tokens.length === 2) {
            var width = component(tokens[0], 'h', parentSize && parentSize[0]);
            var height = component(tokens[1], 'v', parentSize && parentSize[1]);
            if (width === null || height === null || width < 0 || height < 0) return null;
            return [width, height];
        }

        var relative = ttmlFontSizeRelativeFactor(tokens[0]);
        var height;
        if (relative !== null) {
            if (!parentSize) return null;
            height = parentSize[1] * relative;
        } else {
            height = ttmlLengthToPercentage(tokens[0], 'v', baseContext);
        }
        if (height === null || height < 0) return null;
        var width = ttmlConvertPercentageAxis(height, 'v', 'h', context);
        if (width === null) return null;
        return [width, height];
    }

    function ttmlInitialFontSize(doc, context) {
        var specificationDefault = ttmlResolveFontSize('1c', null, context);
        if (!specificationDefault) return null;
        var value = ttmlInitialFontSizeValue(doc);
        if (value === '1c') return specificationDefault;
        return ttmlResolveFontSize(value, specificationDefault, context);
    }

    function ttmlRegionFontSize(regionStyle, doc, context) {
        var initial = ttmlInitialFontSize(doc, context);
        if (!initial) return null;
        var value = regionStyle && regionStyle.fontSize || '';
        return value ? ttmlResolveFontSize(value, initial, context) : initial;
    }

    function ttmlContentFontSize(node, doc, styleMap, regionFontSize, context, depth) {
        if (!node || depth > 64) return regionFontSize;
        var parent = node.parentNode;
        while (parent && parent.nodeType === 1 && !/^(?:body|div|p|span)$/.test(localName(parent))) {
            parent = parent.parentNode;
        }
        var parentSize = parent && parent.nodeType === 1
            ? ttmlContentFontSize(parent, doc, styleMap, regionFontSize, context, depth + 1)
            : regionFontSize;
        if (!parentSize) return null;
        var specified = ttmlSpecifiedPresentationStyle(node, styleMap);
        return specified.fontSize ? ttmlResolveFontSize(specified.fontSize, parentSize, context) : parentSize;
    }

    function ttmlLengthToPercentage(value, axis, context) {
        var match = String(value || '').trim().match(/^([+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+))(px|c|rw|rh|em)$/i);
'''
replace_once(old, new)

old = '''        if (unit === 'c') {
            var cells = context.cellResolution;
            if (!cells) return null;
            var divisor = axis === 'h' ? cells[0] : cells[1];
            return divisor > 0 ? amount * 100 / divisor : null;
        }

        var root = context.rootPixelExtent;
'''
new = '''        if (unit === 'em') {
            var fontSize = context.fontSize;
            if (!fontSize) return null;
            var component = axis === 'h' ? fontSize[0] : fontSize[1];
            return isFinite(component) ? amount * component : null;
        }
        if (unit === 'c') {
            var cells = context.cellResolution;
            if (!cells) return null;
            var divisor = axis === 'h' ? cells[0] : cells[1];
            return divisor > 0 ? amount * 100 / divisor : null;
        }

        var root = context.rootPixelExtent;
'''
replace_once(old, new)

old = '''    function ttmlPositionOrigin(value, extentValue, context) {
        var extent = ttmlLengthPairToPercentage(extentValue, context);
        if (!extent) return null;
        var width = extent[0];
'''
new = '''    function ttmlPositionOrigin(value, extent, context) {
        if (!extent) return null;
        var width = extent[0];
'''
replace_once(old, new)

old = '''        var nodeStyle = ttmlSpecifiedPresentationStyle(node, styleMap);
        var layoutContext = ttmlLayoutContext(doc);
        var extentValue = nodeStyle.extent || regionStyle.extent || '';
        var positionValue = nodeStyle.position || regionStyle.position || '';
        var originValue = nodeStyle.origin || regionStyle.origin || '';
        var extent = ttmlLengthPairToPercentage(extentValue, layoutContext);
        var origin = positionValue ? ttmlPositionOrigin(positionValue, extentValue, layoutContext) : ttmlLengthPairToPercentage(originValue, layoutContext);
        if (!origin || !extent) return settings.join(' ');
'''
new = '''        var nodeStyle = ttmlSpecifiedPresentationStyle(node, styleMap);
        var baseLayoutContext = ttmlLayoutContext(doc);
        var regionFontSize = ttmlRegionFontSize(regionStyle, doc, baseLayoutContext);
        var nodeFontSize = ttmlContentFontSize(node, doc, styleMap, regionFontSize, baseLayoutContext, 0);
        var regionLayoutContext = ttmlLayoutContext(doc, regionFontSize);
        var nodeLayoutContext = ttmlLayoutContext(doc, nodeFontSize);
        var extentFromNode = !!nodeStyle.extent;
        var positionFromNode = !!nodeStyle.position;
        var originFromNode = !!nodeStyle.origin;
        var extentValue = nodeStyle.extent || regionStyle.extent || '';
        var positionValue = nodeStyle.position || regionStyle.position || '';
        var originValue = nodeStyle.origin || regionStyle.origin || '';
        var extentContext = extentFromNode ? nodeLayoutContext : regionLayoutContext;
        var positionContext = positionFromNode ? nodeLayoutContext : regionLayoutContext;
        var originContext = originFromNode ? nodeLayoutContext : regionLayoutContext;
        var extent = ttmlLengthPairToPercentage(extentValue, extentContext);
        var origin = positionValue ? ttmlPositionOrigin(positionValue, extent, positionContext) : ttmlLengthPairToPercentage(originValue, originContext);
        if (!origin || !extent) return settings.join(' ');
'''
replace_once(old, new)

if text.count('function ttmlResolveFontSize(') != 1:
    raise SystemExit('font-size helper insertion failed')
if text.count("(px|c|rw|rh|em)") != 1:
    raise SystemExit('em unit parser insertion failed')

path.write_text(text, encoding='utf-8')
