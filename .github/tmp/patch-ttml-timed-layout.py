from pathlib import Path

path = Path('scripts/coupang-play-subtitles-downloader.user.js')
text = path.read_text(encoding='utf-8')

if text.count('// @version    1.0.19') != 1:
    raise SystemExit('unexpected Coupang version')
text = text.replace('// @version    1.0.19', '// @version    1.0.20', 1)

old = '''    function ttmlActiveInlineSetStyle(node, styleMap, timingContext, activeTime) {
        var animated = {};
        Array.prototype.slice.call(node && node.childNodes || []).forEach(function (child) {
            if (child.nodeType !== 1 || localName(child) !== 'set') return;
            if (!ttmlSetAppliesAtTime(child, timingContext, activeTime)) return;
            var specified = ttmlSpecifiedPresentationStyle(child, styleMap);
            ['fontWeight', 'fontStyle', 'textDecoration', 'textCombine', 'textOrientation'].forEach(function (name) {
                if (specified[name]) animated[name] = specified[name];
            });
        });
        return animated;
    }
'''
new = '''    function ttmlActiveSetStyle(node, styleMap, timingContext, activeTime, propertyNames) {
        var animated = {};
        Array.prototype.slice.call(node && node.childNodes || []).forEach(function (child) {
            if (child.nodeType !== 1 || localName(child) !== 'set') return;
            if (!ttmlSetAppliesAtTime(child, timingContext, activeTime)) return;
            var specified = ttmlSpecifiedPresentationStyle(child, styleMap);
            (propertyNames || []).forEach(function (name) {
                if (specified[name]) animated[name] = specified[name];
            });
        });
        return animated;
    }

    function ttmlActiveInlineSetStyle(node, styleMap, timingContext, activeTime) {
        return ttmlActiveSetStyle(node, styleMap, timingContext, activeTime,
            ['fontWeight', 'fontStyle', 'textDecoration', 'textCombine', 'textOrientation']);
    }
'''
if text.count(old) != 1:
    raise SystemExit('active inline set style block not found')
text = text.replace(old, new, 1)

old = '''    function ttmlRegionPresentationStyle(region, styleMap) {
        var resolved = ttmlSpecifiedPresentationStyle(region, styleMap);
        Array.prototype.slice.call(region && region.childNodes || []).forEach(function (child) {
            if (child.nodeType !== 1 || localName(child) !== 'style') return;
            ttmlMergePresentationStyle(resolved, ttmlSpecifiedPresentationStyle(child, styleMap));
        });
        return resolved;
    }
'''
new = old + '''
    function ttmlRegionPresentationStyleAtTime(region, styleMap, timingContext, activeTime) {
        var resolved = ttmlRegionPresentationStyle(region, styleMap);
        ttmlMergePresentationStyle(resolved, ttmlActiveSetStyle(region, styleMap, timingContext, activeTime,
            ['fontSize', 'origin', 'extent', 'position', 'textAlign', 'displayAlign', 'writingMode']));
        return resolved;
    }
'''
if text.count(old) != 1:
    raise SystemExit('region style block not found')
text = text.replace(old, new, 1)

old = '''    function ttmlContentFontSize(node, doc, styleMap, regionFontSize, context, depth) {
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
'''
new = '''    function ttmlContentFontSize(node, doc, styleMap, regionFontSize, context, depth, timingContext, activeTime) {
        if (!node || depth > 64) return regionFontSize;
        var parent = node.parentNode;
        while (parent && parent.nodeType === 1 && !/^(?:body|div|p|span)$/.test(localName(parent))) {
            parent = parent.parentNode;
        }
        var parentSize = parent && parent.nodeType === 1
            ? ttmlContentFontSize(parent, doc, styleMap, regionFontSize, context, depth + 1, timingContext, activeTime)
            : regionFontSize;
        if (!parentSize) return null;
        var specified = ttmlSpecifiedPresentationStyle(node, styleMap);
        ttmlMergePresentationStyle(specified, ttmlActiveSetStyle(node, styleMap, timingContext, activeTime, ['fontSize']));
        return specified.fontSize ? ttmlResolveFontSize(specified.fontSize, parentSize, context) : parentSize;
    }
'''
if text.count(old) != 1:
    raise SystemExit('content font size block not found')
text = text.replace(old, new, 1)

old = '''    function ttmlCueTextAlign(node, regionStyle, styleMap, writingMode) {
        var specified = ttmlSpecifiedPresentationStyle(node, styleMap);
        var value = specified.textAlign || regionStyle.textAlign || '';
        if (!value && ttmlWebVttVertical(writingMode)) value = 'start';
        return ttmlWebVttAlign(value, writingMode);
    }
'''
new = '''    function ttmlContentPresentationValueAtTime(node, name, styleMap, timingContext, activeTime) {
        var chain = [];
        var current = node;
        while (current && current.nodeType === 1) {
            if (/^(?:body|div|p|span)$/.test(localName(current))) chain.push(current);
            current = current.parentNode;
        }
        var value = '';
        for (var i = chain.length - 1; i >= 0; i--) {
            var specified = ttmlSpecifiedPresentationStyle(chain[i], styleMap);
            ttmlMergePresentationStyle(specified, ttmlActiveSetStyle(chain[i], styleMap, timingContext, activeTime, [name]));
            if (specified[name]) value = specified[name];
        }
        return value;
    }

    function ttmlNodeLayoutPresentationStyleAtTime(node, styleMap, timingContext, activeTime) {
        var resolved = ttmlSpecifiedPresentationStyle(node, styleMap);
        ttmlMergePresentationStyle(resolved, ttmlActiveSetStyle(node, styleMap, timingContext, activeTime,
            ['fontSize', 'origin', 'extent', 'position', 'textAlign', 'displayAlign']));
        return resolved;
    }

    function ttmlSetAffectsCuePresentation(node, styleMap) {
        var specified = ttmlSpecifiedPresentationStyle(node, styleMap);
        return ['fontWeight', 'fontStyle', 'textDecoration', 'textCombine', 'textOrientation', 'fontSize',
            'origin', 'extent', 'position', 'textAlign', 'displayAlign', 'writingMode'].some(function (name) {
            return !!specified[name];
        });
    }

    function ttmlCueExternalTimedSets(node, doc, styleMap) {
        var result = [];
        var seen = [];
        function addDirectSets(container) {
            Array.prototype.slice.call(container && container.childNodes || []).forEach(function (child) {
                if (child.nodeType !== 1 || localName(child) !== 'set' || !ttmlSetAffectsCuePresentation(child, styleMap)) return;
                if (seen.indexOf(child) >= 0) return;
                seen.push(child);
                result.push(child);
            });
        }
        var current = node && node.parentNode;
        while (current && current.nodeType === 1) {
            if (/^(?:body|div|span)$/.test(localName(current))) addDirectSets(current);
            current = current.parentNode;
        }
        addDirectSets(ttmlCueRegion(node, doc));
        return result;
    }

    function ttmlCueTextAlign(node, regionStyle, styleMap, writingMode, timingContext, activeTime) {
        var value = ttmlContentPresentationValueAtTime(node, 'textAlign', styleMap, timingContext, activeTime) || regionStyle.textAlign || '';
        if (!value && ttmlWebVttVertical(writingMode)) value = 'start';
        return ttmlWebVttAlign(value, writingMode);
    }
'''
if text.count(old) != 1:
    raise SystemExit('cue text align block not found')
text = text.replace(old, new, 1)

old = '''    function ttmlCueSettings(node, doc) {
        var styleMap = ttmlStyleMap(doc);
        var region = ttmlCueRegion(node, doc);
        var regionStyle = region ? ttmlRegionPresentationStyle(region, styleMap) : {};
        var writingMode = String(regionStyle.writingMode || 'lrtb').toLowerCase();
'''
new = '''    function ttmlCueSettings(node, doc, timingContext, activeTime, styleMap) {
        styleMap = styleMap || ttmlStyleMap(doc);
        var region = ttmlCueRegion(node, doc);
        var regionStyle = region ? ttmlRegionPresentationStyleAtTime(region, styleMap, timingContext, activeTime) : {};
        var writingMode = String(regionStyle.writingMode || 'lrtb').toLowerCase();
'''
if text.count(old) != 1:
    raise SystemExit('cue settings header not found')
text = text.replace(old, new, 1)

old = """        var align = supportedWriting ? ttmlCueTextAlign(node, regionStyle, styleMap, writingMode) : '';
"""
new = """        var align = supportedWriting ? ttmlCueTextAlign(node, regionStyle, styleMap, writingMode, timingContext, activeTime) : '';
"""
if text.count(old) != 1:
    raise SystemExit('cue align call not found')
text = text.replace(old, new, 1)

old = '''        var nodeStyle = ttmlSpecifiedPresentationStyle(node, styleMap);
        var baseLayoutContext = ttmlLayoutContext(doc);
        var regionFontSize = ttmlRegionFontSize(regionStyle, doc, baseLayoutContext);
        var nodeFontSize = ttmlContentFontSize(node, doc, styleMap, regionFontSize, baseLayoutContext, 0);
'''
new = '''        var nodeStyle = ttmlNodeLayoutPresentationStyleAtTime(node, styleMap, timingContext, activeTime);
        var baseLayoutContext = ttmlLayoutContext(doc);
        var regionFontSize = ttmlRegionFontSize(regionStyle, doc, baseLayoutContext);
        var nodeFontSize = ttmlContentFontSize(node, doc, styleMap, regionFontSize, baseLayoutContext, 0, timingContext, activeTime);
'''
if text.count(old) != 1:
    raise SystemExit('cue layout style block not found')
text = text.replace(old, new, 1)

old = '''        var boundaries = [timing.begin, timing.end];
        var descendants = node.getElementsByTagName ? node.getElementsByTagName('*') : [];
'''
new = '''        var boundaries = [timing.begin, timing.end];
        var styleMap = ttmlStyleMap(doc);
        var descendants = node.getElementsByTagName ? node.getElementsByTagName('*') : [];
'''
if text.count(old) != 1:
    raise SystemExit('paragraph boundary header not found')
text = text.replace(old, new, 1)

old = '''            if (boundaries.length > MAX_TTML_CUE_BOUNDARIES) return [];
        }

        boundaries.sort(function (a, b) { return a - b; });
'''
new = '''            if (boundaries.length > MAX_TTML_CUE_BOUNDARIES) return [];
        }

        var externalSets = ttmlCueExternalTimedSets(node, doc, styleMap);
        for (var externalIndex = 0; externalIndex < externalSets.length; externalIndex++) {
            var externalTiming = ttmlResolveTiming(externalSets[externalIndex], timingContext, 0);
            if (!externalTiming) return [];
            if (isFinite(externalTiming.begin) && externalTiming.begin > timing.begin && externalTiming.begin < timing.end) boundaries.push(externalTiming.begin);
            if (isFinite(externalTiming.end) && externalTiming.end > timing.begin && externalTiming.end < timing.end) boundaries.push(externalTiming.end);
            if (boundaries.length > MAX_TTML_CUE_BOUNDARIES) return [];
        }

        boundaries.sort(function (a, b) { return a - b; });
'''
if text.count(old) != 1:
    raise SystemExit('paragraph boundary tail not found')
text = text.replace(old, new, 1)

old = '''        var settings = ttmlCueSettings(node, doc);
        var styleMap = ttmlStyleMap(doc);
        var intervals = [];
'''
new = '''        var intervals = [];
'''
if text.count(old) != 1:
    raise SystemExit('static cue settings block not found')
text = text.replace(old, new, 1)

old = '''            var sampleTime = begin + (end - begin) / 2;
            var cueText = ttmlCueText(node, doc, timingContext, sampleTime, styleMap);
            if (!cueText.replace(/\\s/g, '')) continue;

            var previous = intervals.length ? intervals[intervals.length - 1] : null;
'''
new = '''            var sampleTime = begin + (end - begin) / 2;
            var cueText = ttmlCueText(node, doc, timingContext, sampleTime, styleMap);
            if (!cueText.replace(/\\s/g, '')) continue;
            var settings = ttmlCueSettings(node, doc, timingContext, sampleTime, styleMap);

            var previous = intervals.length ? intervals[intervals.length - 1] : null;
'''
if text.count(old) != 1:
    raise SystemExit('interval cue settings insertion point not found')
text = text.replace(old, new, 1)

path.write_text(text, encoding='utf-8')
