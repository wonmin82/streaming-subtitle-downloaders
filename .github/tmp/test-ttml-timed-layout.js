const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('scripts/coupang-play-subtitles-downloader.user.js', 'utf8');
if (!source.includes('// @version    1.0.20')) throw new Error('version bump missing');
if (!source.includes('ttmlCueSettings(node, doc, timingContext, sampleTime, styleMap)')) throw new Error('cue settings are not interval-aware');
if (!source.includes('ttmlCueExternalTimedSets(node, doc, styleMap)')) throw new Error('external timed set collection missing');
if (!source.includes("ttmlActiveSetStyle(node, styleMap, timingContext, activeTime, ['fontSize'])")) throw new Error('timed fontSize composition missing');

const start = source.indexOf('    function ttmlAttribute(');
const end = source.indexOf('    function timestampSeconds(');
if (start < 0 || end <= start) throw new Error('could not isolate TTML helper block');
const ctx = { console, MAX_TTML_CUE_BOUNDARIES: 2048 };
vm.createContext(ctx);
vm.runInContext(`function localName(n){return String(n&&(n.localName||n.nodeName||n.name)||'').split(':').pop();}\n${source.slice(start,end)}`, ctx);

function attr(name, value) { return { name, localName: name.split(':').pop(), value: String(value) }; }
function el(name, attrs = {}, parent = null) {
  const n = {
    nodeType: 1, localName: name, nodeName: name,
    attributes: Object.entries(attrs).map(([k,v]) => attr(k,v)),
    childNodes: [], parentNode: parent,
    getAttribute(k) { const a=this.attributes.find(x=>x.name===k||x.localName===k); return a?a.value:''; },
    getElementsByTagName() { const out=[]; const walk=x=>(x.childNodes||[]).forEach(c=>{if(c.nodeType===1){out.push(c);walk(c)}}); walk(this); return out; }
  };
  if (parent) parent.childNodes.push(n);
  return n;
}
function textNode(value, parent) { const n={nodeType:3,nodeValue:value,parentNode:parent}; parent.childNodes.push(n); return n; }
function makeDoc(root) { const all=[root]; const walk=x=>(x.childNodes||[]).forEach(c=>{if(c.nodeType===1){all.push(c);walk(c)}}); walk(root); return { getElementsByTagName(){return all;}, documentElement:root }; }
function near(a,b,eps=.001){ if(a===null||Math.abs(a-b)>eps) throw new Error(`expected ${b}, got ${a}`); }

const root = el('tt', { 'tts:extent':'1000px 1000px', 'ttp:cellResolution':'32 15' });
const head = el('head', {}, root);
const layout = el('layout', {}, head);
const region = el('region', { 'xml:id':'r', 'tts:origin':'10% 10%', 'tts:extent':'50% 30%', 'tts:textAlign':'left', 'tts:writingMode':'lrtb' }, layout);
const regionSet = el('set', { begin:'2s', dur:'1s', fill:'freeze', 'tts:origin':'20% 20%' }, region);
const body = el('body', { begin:'0s', dur:'5s', region:'r' }, root);
const div = el('div', {}, body);
const divAlignSet = el('set', { begin:'1s', dur:'1s', 'tts:textAlign':'right' }, div);
const p = el('p', { begin:'0s', dur:'5s' }, div);
textNode('Hello', p);
const pDisplaySet = el('set', { begin:'3s', dur:'1s', 'tts:displayAlign':'after' }, p);
const d = makeDoc(root);
const timing = ctx.ttmlTimingContext(d);
if (!timing) throw new Error('timing context missing');
const styles = ctx.ttmlStyleMap(d);

function settingsAt(t) { return ctx.ttmlCueSettings(p, d, timing, t, styles); }
const s05 = settingsAt(.5);
if (!s05.includes('line:10%,start') || !s05.includes('position:10%,line-left') || !s05.includes('size:50%') || !s05.includes('align:left')) throw new Error('static region settings changed: '+s05);
const s15 = settingsAt(1.5);
if (!s15.includes('align:right')) throw new Error('ancestor timed textAlign not inherited: '+s15);
const s25 = settingsAt(2.5);
if (!s25.includes('line:20%,start') || !s25.includes('position:20%,line-left') || !s25.includes('align:left')) throw new Error('region timed origin not applied: '+s25);
const s35 = settingsAt(3.5);
if (!s35.includes('line:50%,end') || !s35.includes('position:20%,line-left')) throw new Error('paragraph timed displayAlign not applied: '+s35);
const s45 = settingsAt(4.5);
if (!s45.includes('line:20%,start') || !s45.includes('position:20%,line-left')) throw new Error('fill=freeze region state or paragraph restore incorrect: '+s45);

const intervals = ctx.ttmlParagraphCueIntervals(p, d, timing);
const sig = intervals.map(x => `${x.begin}-${x.end}:${x.settings}`).join('|');
for (const boundary of ['0-1:','1-2:','2-3:','3-4:','4-5:']) if (!sig.includes(boundary)) throw new Error('missing timed layout interval '+boundary+' in '+sig);

const fontSet = el('set', { begin:'4s', dur:'0.5s', 'tts:fontSize':'2c 2c' }, div);
const baseContext = ctx.ttmlLayoutContext(d);
const regionStyle = ctx.ttmlRegionPresentationStyleAtTime(region, styles, timing, 4.25);
const regionFont = ctx.ttmlRegionFontSize(regionStyle, d, baseContext);
const activeFont = ctx.ttmlContentFontSize(p, d, styles, regionFont, baseContext, 0, timing, 4.25);
near(activeFont[0], 6.25); near(activeFont[1], 100/15*2);
const inactiveFont = ctx.ttmlContentFontSize(p, d, styles, regionFont, baseContext, 0, timing, 4.75);
if (Math.abs(inactiveFont[0]-activeFont[0]) < .001 && Math.abs(inactiveFont[1]-activeFont[1]) < .001) throw new Error('timed ancestor fontSize did not restore');
div.childNodes.pop();

const bad = el('set', { begin:'bogus', dur:'1s', 'tts:textAlign':'center' }, div);
if (ctx.ttmlParagraphCueIntervals(p, d, timing).length !== 0) throw new Error('malformed external layout timing must fail closed');
div.childNodes.pop();

if (ctx.ttmlCueExternalTimedSets(p, d, styles).indexOf(regionSet) < 0 || ctx.ttmlCueExternalTimedSets(p, d, styles).indexOf(divAlignSet) < 0) throw new Error('external relevant sets not collected');
if (ctx.ttmlCueExternalTimedSets(p, d, styles).indexOf(pDisplaySet) >= 0) throw new Error('paragraph descendant set should not be duplicated as external');

console.log('TTML timed layout fixtures passed');
