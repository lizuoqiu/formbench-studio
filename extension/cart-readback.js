// Read only the visible buyer cart. A virtualized or changing cart cannot prove absence.
(()=>{
 const visible=n=>n&&n.getClientRects().length&&getComputedStyle(n).visibility!=='hidden';
 const text=n=>n?.textContent?.trim()||'';
 function snapshot(item,sku){
  const empty=[...document.querySelectorAll('[class*="empty" i], [data-cart-empty]')].some(n=>visible(n)&&/购物车[里还]*[是没为]?空|购物车[里还]*没有[商宝]|购物车空空|your cart is empty/i.test(text(n)));
  const rows=[...document.querySelectorAll('[data-item-id][data-sku-id], [data-cart-item], .J_CartItem, [class*="cartItem"], [class*="cart-item"]')].filter(visible),matches=[],seen=new Set();let ambiguous=false;
  for(const r of rows){const a=r.querySelector('a[href*="item.htm"]');let url;if(a)try{url=new URL(a.href);if(!['item.taobao.com','detail.tmall.com'].includes(url.hostname))url=null;}catch{}
   const id=r.dataset.itemId||url?.searchParams.get('id'),variant=r.dataset.skuId||url?.searchParams.get('skuId');if(id!==item)continue;
   if(!variant){ambiguous=true;continue;}if(variant!==sku)continue;
   const input=[...r.querySelectorAll('input[type=number],input[aria-label*="数量"],input[class*="quantity" i],.item-amount input')].filter(visible);if(input.length!==1){ambiguous=true;continue;}
   if(seen.has(input[0]))continue;seen.add(input[0]);const v=input[0].value;if(!/^\d{1,4}$/.test(v)||+v<1)ambiguous=true;else matches.push(+v);
  }
  if(!ambiguous&&matches.length===1&&!empty)return {known:true,id:item,skuId:sku,qty:matches[0]};
  if(!ambiguous&&!matches.length&&!rows.length&&empty)return {known:true,id:item,skuId:sku,qty:0};
  return {known:false};
 }
 chrome.runtime.onMessage.addListener((m,s,reply)=>{if(s.id!==chrome.runtime.id||m?.type!=='FB_CART_READ_LINE'||location.origin!=='https://cart.taobao.com'||!/^\d{1,25}$/.test(m.id)||!/^\d{1,25}$/.test(m.skuId))return;reply(snapshot(m.id,m.skuId));});
})();
