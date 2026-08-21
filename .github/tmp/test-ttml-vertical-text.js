const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('scripts/coupang-play-subtitles-downloader.user.js', 'utf8');
if (!source.includes('// @version    1.0.19')) throw new Error('version bump missing');
if (!source.includes("'textCombine', 'textOrientation'")) throw new Error('vertical text styles not preserved');
if (!source.includes("::cue(.ttml-combine) { text-combine-upright: all; }")) throw new Error('WebVTT combine STYLE missing');
if (source.includes('text-orientation:')) throw new Error('unsupported WebVTT text-orientation must not be emitted');

const docStart = source.indexOf('    function ttmlVttDocument(');
const docEnd = source.indexOf('    function ttmlHasParserError(');
const start = source.indexOf('    function ttmlAttribute(');
const end = source.indexOf('    function timestampSeconds(');
if (docStart < 0 || docEnd <= docStart || start < 0 || end <= start) throw new Error('could not isolate TTML helper blocks');
const ctx = { console, MAX_TTML_CUE_BOUNDARIES: 2048 };
vm.createContext(ctx);
vm.runInContext(`function localName(n){return String(n&&(n.localName||n.nodeName||n.name)||'').split(':').pop();}\n${source.slice(docStart,docEnd)}\n${source.slice(start,end)}`, ctx);

function attr(name, value) { return { name, localName: name.split(':').pop(), value: String(value) }; }
function el(name, attrs = {}, parent = null) {
  const n = {
    nodeType: 1, localName: name, nodeName: name,
    attributes: Object.entries(attrs).map(([k,v]) => attr(k,v)),
    childNodes: [], parentNode: parent,
    getAttribute(k) { const a = this.attributes.find(x => x.name === k || x.localName === k); return a ? a.value : ''; },
    getElementsByTagName() { const out=[]; const walk=x=>(x.childNodes||[]).forEach(c=>{if(c.nodeType===1){out.push(c);walk(c)}}); walk(this); return out; }
  };
  if (parent) parent.childNodes.push(n);
  return n;
}
function textNode(value, parent) { const n={nodeType:3,nodeValue:value,parentNode:parent}; parent.childNodes.push(n); return n; }
function doc(root) { const all=[root]; const walk=x=>(x.childNodes||[]).forEach(c=>{if(c.nodeType===1){all.push(c);walk(c)}}); walk(root); return { getElementsByTagName(){return all;}, documentElement:root }; }

const p = el('p', { begin:'0s', dur:'4s' });
const span = el('span', { 'tts:textCombine':'all', 'tts:textOrientation':'upright' }, p);
textNode('12', span);
const d = doc(p);
const styles = ctx.ttmlStyleMap(d);
const staticStyle = ctx.ttmlComputedPresentationStyle(span, styles);
if (staticStyle.textCombine !== 'all') throw new Error('textCombine not computed');
if (staticStyle.textOrientation !== 'upright') throw new Error('textOrientation not computed');
if (ctx.ttmlWrapVttText('12', staticStyle) !== '<c.ttml-combine>12</c>') throw new Error('combine markup incorrect');

const child = el('span', {}, span); textNode('A', child);
const inherited = ctx.ttmlComputedPresentationStyle(child, styles);
if (inherited.textCombine !== 'all' || inherited.textOrientation !== 'upright') throw new Error('vertical text style inheritance incorrect');

el('set', { begin:'1s', dur:'1s', 'tts:textCombine':'none', 'tts:textOrientation':'sideways' }, span);
const timing = {frameRate:30,effectiveFrameRate:30,subFrameRate:1,tickRate:1};
const at15 = ctx.ttmlComputedPresentationStyleAtTime(span, styles, timing, 1.5);
if (at15.textCombine !== 'none' || at15.textOrientation !== 'sideways') throw new Error('timed vertical text style override incorrect');
const at25 = ctx.ttmlComputedPresentationStyleAtTime(span, styles, timing, 2.5);
if (at25.textCombine !== 'all' || at25.textOrientation !== 'upright') throw new Error('timed vertical text style restore incorrect');

const invalid = el('span', { 'tts:textOrientation':'sidewaysLeft', 'tts:textCombine':'digits' }, p);
const invalidStyle = ctx.ttmlComputedPresentationStyle(invalid, styles);
if (invalidStyle.textOrientation !== 'mixed') throw new Error('unsupported orientation must fall back to mixed');
if (invalidStyle.textCombine !== 'none') throw new Error('unsupported combine must fall back to none');

const plainDoc = ctx.ttmlVttDocument(['00:00:00.000 --> 00:00:01.000\nHello']);
if (plainDoc.includes('STYLE')) throw new Error('plain TTML output must not add unnecessary STYLE');
const combinedDoc = ctx.ttmlVttDocument(['00:00:00.000 --> 00:00:01.000 vertical:rl\n<c.ttml-combine>12</c>']);
if (!combinedDoc.startsWith('WEBVTT\n\nSTYLE\n::cue(.ttml-combine) { text-combine-upright: all; }\n\n')) throw new Error('combine STYLE header placement incorrect');
if (!combinedDoc.includes('vertical:rl\n<c.ttml-combine>12</c>')) throw new Error('vertical cue changed');

console.log('TTML vertical text fixtures passed');
