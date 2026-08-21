const fs=require('fs'),vm=require('vm');
const source=fs.readFileSync('scripts/coupang-play-subtitles-downloader.user.js','utf8');
if(!source.includes('// @version    1.0.18')) throw new Error('version bump missing');
if(!source.includes('/^(?:body|div|p|span|set)$/')) throw new Error('set timing membership missing');
if(!source.includes("if (localName(node) === 'set') return;")) throw new Error('set content suppression missing');
const start=source.indexOf('    function ttmlAttribute(');
const end=source.indexOf('    function timestampSeconds(');
if(start<0||end<=start) throw new Error('helper block not found');
const ctx={console,MAX_TTML_CUE_BOUNDARIES:2048}; vm.createContext(ctx);
vm.runInContext(`function localName(n){return String(n&&(n.localName||n.nodeName||n.name)||'').split(':').pop();}\n${source.slice(start,end)}`,ctx);
function attr(name,value){return {name,localName:name.split(':').pop(),value:String(value)}}
function el(name,attrs={},parent=null){const n={nodeType:1,localName:name,nodeName:name,attributes:Object.entries(attrs).map(([k,v])=>attr(k,v)),childNodes:[],parentNode:parent,getAttribute(k){const a=this.attributes.find(x=>x.name===k||x.localName===k);return a?a.value:'';},getElementsByTagName(){const out=[];function walk(x){(x.childNodes||[]).forEach(c=>{if(c.nodeType===1){out.push(c);walk(c)}})}walk(this);return out;}};if(parent)parent.childNodes.push(n);return n}
function text(value,parent){const n={nodeType:3,nodeValue:value,parentNode:parent};parent.childNodes.push(n);return n}
function doc(root){const all=[root];function walk(x){(x.childNodes||[]).forEach(c=>{if(c.nodeType===1){all.push(c);walk(c)}})}walk(root);return {getElementsByTagName(){return all;},documentElement:root}}
const p=el('p',{begin:'0s',dur:'5s'}); text('Hello',p);
const s1=el('set',{begin:'1s',dur:'1s','tts:fontWeight':'bold'},p);
const s2=el('set',{begin:'2s',dur:'1s','tts:fontStyle':'italic'},p);
const s3=el('set',{begin:'3s',dur:'1s',fill:'freeze','tts:textDecoration':'underline'},p);
const d=doc(p), timing={frameRate:30,effectiveFrameRate:30,subFrameRate:1,tickRate:1}, styles=ctx.ttmlStyleMap(d);
function rendered(t){return ctx.ttmlCueText(p,d,timing,t,styles)}
if(rendered(.5)!=='Hello') throw new Error('static interval changed');
if(rendered(1.5)!=='<b>Hello</b>') throw new Error('bold set not applied');
if(rendered(2.5)!=='<i>Hello</i>') throw new Error('italic set not applied');
if(rendered(3.5)!=='<u>Hello</u>') throw new Error('underline set not applied');
if(rendered(4.5)!=='<u>Hello</u>') throw new Error('fill freeze not preserved');
const overlap=el('set',{begin:'1s',dur:'2s','tts:fontWeight':'normal'},p);
if(rendered(1.5)!=='Hello') throw new Error('later active set did not override earlier set');
if(rendered(2.5)!=='<i>Hello</i>') throw new Error('unrelated animation property was disturbed');
const intervals=ctx.ttmlParagraphCueIntervals(p,d,timing);
const signature=intervals.map(x=>`${x.begin}-${x.end}:${x.text}`).join('|');
if(!signature.includes('0-1:Hello')||!signature.includes('1-2:Hello')||!signature.includes('2-3:<i>Hello</i>')||!signature.includes('3-5:<u>Hello</u>')) throw new Error('set boundaries/cue merge incorrect: '+signature);
const bad=el('set',{begin:'bogus',dur:'1s','tts:fontWeight':'bold'},p);
if(ctx.ttmlParagraphCueIntervals(p,d,timing).length!==0) throw new Error('malformed set timing must fail closed');
p.childNodes.pop();
const repeat=el('set',{begin:'0s',dur:'1s',repeatCount:'2','tts:fontWeight':'bold'},p);
if(ctx.ttmlSetAppliesAtTime(repeat,timing,.5)!==false) throw new Error('unsupported repeatCount must not be approximated');
console.log('TTML set styling fixtures passed');
