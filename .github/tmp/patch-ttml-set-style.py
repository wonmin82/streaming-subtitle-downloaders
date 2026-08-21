from pathlib import Path
p=Path('scripts/coupang-play-subtitles-downloader.user.js')
s=p.read_text(encoding='utf-8')
def r(a,b):
    global s
    if s.count(a)!=1: raise SystemExit(f'expected one match, found {s.count(a)}')
    s=s.replace(a,b,1)
r('// @version    1.0.17','// @version    1.0.18')
r("return !!node && node.nodeType === 1 && /^(?:body|div|p|span)$/.test(localName(node));","return !!node && node.nodeType === 1 && /^(?:body|div|p|span|set)$/.test(localName(node));")
anchor='''    function ttmlUnderlineFromDecoration(value, inherited) {\n'''
insert='''    function ttmlSetAppliesAtTime(node, timingContext, activeTime) {
        if (!node || localName(node) !== 'set' || typeof activeTime !== 'number' || !isFinite(activeTime)) return false;
        if (ttmlAttribute(node, 'repeatCount')) return false;
        var timing = ttmlResolveTiming(node, timingContext, 0);
        if (!timing) return false;
        if (activeTime >= timing.begin && activeTime < timing.end) return true;
        var fill = String(ttmlAttribute(node, 'fill') || 'remove').toLowerCase();
        return fill === 'freeze' && activeTime >= timing.end;
    }

    function ttmlActiveInlineSetStyle(node, styleMap, timingContext, activeTime) {
        var animated = {};
        Array.prototype.slice.call(node && node.childNodes || []).forEach(function (child) {
            if (child.nodeType !== 1 || localName(child) !== 'set') return;
            if (!ttmlSetAppliesAtTime(child, timingContext, activeTime)) return;
            var specified = ttmlSpecifiedPresentationStyle(child, styleMap);
            ['fontWeight', 'fontStyle', 'textDecoration'].forEach(function (name) {
                if (specified[name]) animated[name] = specified[name];
            });
        });
        return animated;
    }

    function ttmlComputedPresentationStyleAtTime(node, styleMap, timingContext, activeTime) {
        var inherited = {
            bold: false,
            italic: false,
            underline: false,
            ruby: 'none'
        };
        var parent = node && node.parentNode;
        if (parent && parent.nodeType === 1) {
            var parentStyle = ttmlComputedPresentationStyleAtTime(parent, styleMap, timingContext, activeTime);
            inherited.bold = parentStyle.bold;
            inherited.italic = parentStyle.italic;
            inherited.underline = parentStyle.underline;
        }

        var specified = ttmlSpecifiedPresentationStyle(node, styleMap);
        var animated = ttmlActiveInlineSetStyle(node, styleMap, timingContext, activeTime);
        ttmlMergePresentationStyle(specified, animated);
        if (specified.fontWeight) inherited.bold = String(specified.fontWeight).toLowerCase() === 'bold';
        if (specified.fontStyle) {
            var fontStyle = String(specified.fontStyle).toLowerCase();
            inherited.italic = fontStyle === 'italic' || fontStyle === 'oblique';
        }
        if (specified.textDecoration) inherited.underline = ttmlUnderlineFromDecoration(specified.textDecoration, inherited.underline);
        inherited.ruby = specified.ruby ? String(specified.ruby) : 'none';
        return inherited;
    }

'''+anchor
r(anchor,insert)
r("            var presentation = ttmlComputedPresentationStyle(node, context.styleMap);","            if (localName(node) === 'set') return;\n            var presentation = ttmlComputedPresentationStyleAtTime(node, context.styleMap, context.timingContext, context.activeTime);")
r("            var parentStyle = ttmlComputedPresentationStyle(node.parentNode, context.styleMap);","            var parentStyle = ttmlComputedPresentationStyleAtTime(node.parentNode, context.styleMap, context.timingContext, context.activeTime);")
if s.count('function ttmlComputedPresentationStyleAtTime(')!=1: raise SystemExit('dynamic style helper missing')
p.write_text(s,encoding='utf-8')
