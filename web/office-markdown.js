/* Parse Markdown, then build only explicit DOM nodes. Source HTML is never inserted. */
(() => {
  'use strict';
  const make=(tag,text)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
  function link(href){try{const url=new URL(href,document.baseURI);return ['http:','https:','mailto:'].includes(url.protocol)?url.href:null;}catch{return null;}}
  function inline(tokens,parent,depth=0){
    if(depth>32)return;
    for(const token of tokens??[]){
      let node;
      if(['strong','em','del'].includes(token.type)){node=make(token.type);inline(token.tokens,node,depth+1);}
      else if(token.type==='link'){const href=link(token.href);node=make(href?'a':'span');if(href){node.href=href;node.rel='noopener noreferrer';node.target='_blank';node.referrerPolicy='no-referrer';}inline(token.tokens,node,depth+1);}
      else if(token.type==='codespan')node=make('code',token.text);
      else if(token.type==='br')node=make('br');
      else if(token.type==='image')node=make('span',token.text?'[图片：'+token.text+']':'[图片]');
      else if(token.tokens){node=make('span');inline(token.tokens,node,depth+1);}
      else node=document.createTextNode(token.text??token.raw??'');
      parent.append(node);
    }
  }
  function blocks(tokens,parent,depth=0){
    if(depth>32)return;
    for(const token of tokens??[]){
      let node;
      if(token.type==='space'||token.type==='checkbox')continue;
      if(token.type==='heading'){node=make('h'+Math.max(1,Math.min(6,token.depth)));inline(token.tokens,node);}
      else if(token.type==='paragraph'||token.type==='text'){node=make('p');inline(token.tokens??[{type:'text',text:token.text}],node);}
      else if(token.type==='code'){node=make('pre');const code=make('code',token.text);if(token.lang)code.dataset.language=token.lang.split(/\s/)[0];node.append(code);}
      else if(token.type==='blockquote'){node=make('blockquote');blocks(token.tokens,node,depth+1);}
      else if(token.type==='hr')node=make('hr');
      else if(token.type==='list'){
        node=make(token.ordered?'ol':'ul');if(token.ordered&&Number.isSafeInteger(token.start))node.start=token.start;
        for(const item of token.items){const li=make('li');if(item.task){li.className='office-markdown-task';const check=make('input');check.type='checkbox';check.disabled=true;check.checked=!!item.checked;li.append(check);}blocks(item.tokens,li,depth+1);node.append(li);}
      }else if(token.type==='table'){
        node=make('div');node.className='office-markdown-table';const table=make('table'),head=make('thead'),body=make('tbody');
        const row=(cells,tag)=>{const tr=make('tr');cells.forEach((cell,index)=>{const td=make(tag);if(['left','center','right'].includes(token.align[index]))td.style.textAlign=token.align[index];inline(cell.tokens,td);tr.append(td);});return tr;};
        head.append(row(token.header,'th'));for(const cells of token.rows)body.append(row(cells,'td'));table.append(head,body);node.append(table);
      }else node=make('pre',token.text??token.raw??'');
      parent.append(node);
    }
  }
  function render(text){
    const node=make('div');node.className='office-markdown';
    if(!window.marked){node.append(make('pre',text));return node;}
    try{blocks(window.marked.lexer(String(text??''),{gfm:true}),node);}catch{node.replaceChildren(make('pre',text));}
    return node;
  }
  window.MindPondOfficeMarkdown={render};
})();
