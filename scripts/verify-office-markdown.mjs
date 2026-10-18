/** Actual Marked tokens rendered without a browser HTML insertion sink. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {marked} from 'marked';
class Node {
  constructor(tag,text=''){this.tag=tag;this.textContent=text;this.children=[];this.style={};this.dataset={};}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.children=nodes;}
  set innerHTML(_value){throw Error('Untrusted HTML must not be inserted');}
}
const window={marked};
vm.runInNewContext(await fs.readFile(new URL('../web/office-markdown.js',import.meta.url),'utf8'),{window,URL,document:{baseURI:'http://localhost/collaboration',createElement:tag=>new Node(tag),createTextNode:text=>new Node('#text',text)}});
const flatten=n=>[n,...n.children.flatMap(flatten)];
const render=text=>flatten(window.MindPondOfficeMarkdown.render(text));
const normal=render('# Review\n\n**Important** and `code`.\n\n- [x] Checked\n- [ ] Pending\n\n> Quoted\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```js\nconst ok = true;\n```\n\n[Docs](https://example.com)');
for(const tag of ['h1','strong','code','ul','li','blockquote','table','th','td','pre','a'])assert(normal.some(n=>n.tag===tag),tag);
assert(normal.filter(n=>n.tag==='input').every(n=>n.disabled));
assert.equal(normal.filter(n=>n.tag==='input').length,2);
assert(!normal.some(n=>n.tag==='pre'&&/^\[[ x]\]/.test(n.textContent)),'task markers must not also become raw code blocks');
for(const source of ['<script>alert(1)</script>','<img src=x onerror=alert(1)>','<svg onload=alert(1)>','[Click](javascript:alert%281%29)','[Click](data:text/html,payload)','![Tracking](https://example.com/pixel)','<a href="javascript:alert(1)">bad</a>']){
  const nodes=render(source);
  assert(!nodes.some(n=>['script','img','svg','iframe','style','form'].includes(n.tag)),source);
  assert(nodes.filter(n=>n.tag==='a').every(n=>/^(https?:|mailto:)/.test(n.href)),source);
}
window.marked=null;assert(render('**raw**').some(n=>n.tag==='pre'&&n.textContent==='**raw**'),'missing parser keeps readable source');
console.log('PASS office Markdown: review structures, code, task lists and tables; HTML stays text, unsafe links and automatic images are excluded');
