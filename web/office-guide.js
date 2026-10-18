(() => {
  'use strict';
  let timer;
  for (const button of document.querySelectorAll('[data-copy]')) {
    button.addEventListener('click',async()=>{
      const text=document.getElementById(button.dataset.copy)?.textContent;
      if(!text)return;
      const status=document.getElementById('copyStatus');
      try {
        if(!navigator.clipboard?.writeText)throw Error('clipboard unavailable');
        await navigator.clipboard.writeText(text);
        status.textContent='已复制，可以粘贴到对应的聊天。';
      } catch {
        const selection=window.getSelection(), range=document.createRange();
        range.selectNodeContents(document.getElementById(button.dataset.copy));
        selection.removeAllRanges();selection.addRange(range);
        status.textContent='请长按复制已选文字，或按 Ctrl / ⌘ + C。';
      }
      status.hidden=false;clearTimeout(timer);timer=setTimeout(()=>status.hidden=true,5000);
    });
  }
})();

(() => {
  'use strict';
  const dialog=document.getElementById('shotDialog');
  const content=document.getElementById('zoomContent');
  const title=document.getElementById('zoomTitle');
  for(const button of document.querySelectorAll('[data-zoom]')){
    button.addEventListener('click',()=>{
      const original=button.querySelector('svg');
      const svg=original.cloneNode(true);
      // A dialog can coexist with the original figure; avoid duplicate SVG title IDs.
      svg.removeAttribute('aria-labelledby');
      svg.setAttribute('aria-label',original.querySelector('title').textContent);
      svg.querySelector('title').removeAttribute('id');
      svg.style.setProperty('--shot-width',original.dataset.width+'px');
      title.textContent=button.closest('figure').querySelector('h3').textContent;
      content.replaceChildren(svg);
      dialog.showModal();content.scrollTop=0;content.scrollLeft=0;
    });
  }
  document.getElementById('closeShot').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});
  dialog.addEventListener('close',()=>content.replaceChildren());
})();
