const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('scripts/coupang-play-subtitles-downloader.user.js', 'utf8');
if (!source.includes('// @version    1.0.17')) throw new Error('version bump missing');
if (!source.includes("'fontSize', 'origin'")) throw new Error('fontSize is not preserved in specified style');
if (!source.includes('ttmlPositionOrigin(positionValue, extent, positionContext)')) throw new Error('position does not use resolved extent/context');
if (!source.includes('var extentContext = extentFromNode ? nodeLayoutContext : regionLayoutContext;')) throw new Error('geometry source context selection missing');

const start = source.indexOf('    function ttmlAttribute(');
const end = source.indexOf('    function ttmlSpaceMode(');
if (start < 0 || end <= start) throw new Error('could not isolate TTML helper block');

const context = { console };
vm.createContext(context);
vm.runInContext(`
function localName(node) {
    return String(node && (node.localName || node.nodeName || node.name) || '').split(':').pop().toLowerCase();
}
${source.slice(start, end)}
`, context);

function attr(name, value) {
    return { name, localName: name.split(':').pop(), value: String(value) };
}
function element(name, attrs = {}, parent = null) {
    const node = {
        nodeType: 1,
        localName: name,
        nodeName: name,
        attributes: Object.entries(attrs).map(([k, v]) => attr(k, v)),
        childNodes: [],
        parentNode: parent,
        getAttribute(key) {
            const found = this.attributes.find(a => a.name === key || a.localName === key);
            return found ? found.value : '';
        }
    };
    if (parent) parent.childNodes.push(node);
    return node;
}
function documentWith(root, nodes) {
    return { getElementsByTagName() { return nodes; }, documentElement: root };
}
function close(actual, expected, epsilon = 0.001) {
    if (actual === null || Math.abs(actual - expected) > epsilon) {
        throw new Error(`expected ${expected}, got ${actual}`);
    }
}
function pair(actual, expected, epsilon = 0.001) {
    if (!actual || actual.length !== 2) throw new Error(`expected pair, got ${actual}`);
    close(actual[0], expected[0], epsilon);
    close(actual[1], expected[1], epsilon);
}

const root = element('tt', { 'tts:extent': '1920px 1080px', 'ttp:cellResolution': '32 15' });
const doc = documentWith(root, [root]);
const base = context.ttmlLayoutContext(doc);
pair(context.ttmlResolveFontSize('1c', null, base), [3.75, 100 / 15]);
pair(context.ttmlResolveFontSize('1c 1c', null, base), [100 / 32, 100 / 15]);
pair(context.ttmlResolveFontSize('50% 2em', [4, 6], base), [2, 12]);
pair(context.ttmlResolveFontSize('20px', null, base), [20 / 1920 * 100, 20 / 1080 * 100]);

const initial = element('initial', { 'tts:fontSize': '2c 1c' }, root);
const region = element('region', { 'tts:fontSize': '40px 60px' }, root);
const body = element('body', { 'tts:fontSize': '2c 1c' }, root);
const div = element('div', {}, body);
const p = element('p', { 'tts:fontSize': '50% 2em' }, div);
const doc2 = documentWith(root, [root, initial, region, body, div, p]);
const base2 = context.ttmlLayoutContext(doc2);
pair(context.ttmlInitialFontSize(doc2, base2), [100 / 16, 100 / 15]);
const styleMap = context.ttmlStyleMap(doc2);
const regionStyle = context.ttmlRegionPresentationStyle(region, styleMap);
const regionFont = context.ttmlRegionFontSize(regionStyle, doc2, base2);
pair(regionFont, [40 / 1920 * 100, 60 / 1080 * 100]);
const pFont = context.ttmlContentFontSize(p, doc2, styleMap, regionFont, base2, 0);
pair(pFont, [100 / 32, 200 / 15]);

const emContext = context.ttmlLayoutContext(doc2, pFont);
pair(context.ttmlLengthPairToPercentage('2em 0.5em', emContext), [200 / 32, 100 / 15]);
close(context.ttmlLengthToPercentage('20%', 'h', emContext), 20);
close(context.ttmlLengthToPercentage('1em', 'h', { fontSize: [3, 5] }), 3);
close(context.ttmlLengthToPercentage('2em', 'v', { fontSize: [3, 5] }), 10);

const noExtentRoot = element('tt', { 'ttp:cellResolution': '32 15' });
const noExtentDoc = documentWith(noExtentRoot, [noExtentRoot]);
const noExtentContext = context.ttmlLayoutContext(noExtentDoc);
if (context.ttmlInitialFontSize(noExtentDoc, noExtentContext) !== null) {
    throw new Error('single-value initial 1c should fail closed without root aspect ratio');
}
pair(context.ttmlResolveFontSize('1c 1c', null, noExtentContext), [100 / 32, 100 / 15]);
if (context.ttmlLengthToPercentage('1em', 'h', noExtentContext) !== null) {
    throw new Error('em geometry should fail closed without computed font size');
}

console.log('TTML em geometry fixtures passed');
