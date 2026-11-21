// Runs only after the extension sends a user-started add request. No private endpoints.
(() => {
  const hostnames = new Set(['item.taobao.com', 'detail.tmall.com']);
  const readProduct = value => {
    try {
      const u = new URL(value);
      const ids = u.searchParams.getAll('id'), skus = u.searchParams.getAll('skuId');
      if (u.protocol !== 'https:' || u.username || u.password || u.port || !hostnames.has(u.hostname) || u.pathname !== '/item.htm' || ids.length !== 1 || !/^\d{1,25}$/.test(ids[0]) || skus.length > 1 || (skus.length && !/^\d{1,25}$/.test(skus[0]))) return null;
      return { id: ids[0], sku: skus[0] };
    } catch { return null; }
  };
  const norm = s => String(s || '').replace(/\s+/gu,' ').trim();
  const visible = e => e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}) && e.getClientRects().length && !e.closest('[inert],[aria-hidden="true"]');
  const all = selector => Array.from(document.querySelectorAll(selector)).filter(visible);
  const enabled = e => !e.matches(':disabled,[aria-disabled="true"]') && getComputedStyle(e).pointerEvents!=='none';
  const control = 'button,[role="button"],a,[role="radio"],label,[class*="valueItem"],[class*="skuItem"]';
  const text = e => norm(e.innerText);
  const selected = e => e.matches('[aria-checked="true"],[aria-pressed="true"],[aria-selected="true"]') || [...e.classList].some(c=>/^(?:selected|checked|active)(?:--|_|$)/i.test(c)) || !!e.querySelector('input:checked');
  const only = a => a.length===1?a[0]:null;
  const sleep = n=>new Promise(ok=>setTimeout(ok,n));
  const res = (status,message)=>({status,message});
  const groupSelector='[role="radiogroup"],[class*="skuItemGroup"],[class*="SkuContent--skuItem--"]';
  const option = name=>{const el=only(all(control).filter(e=>text(e)===name&&enabled(e)));return el&&!/购物车|立即购买|马上抢|下单|付款|结算|登录/.test(name)&&!el.closest('a[href]')&&(el.closest(groupSelector)||el.matches('[role="radio"],[aria-checked],[aria-pressed],[aria-selected],[class*="valueItem"],[class*="skuItem"]'))?el:null;};
  const gated = ()=>all('[role="dialog"],iframe,[class*="login" i],[class*="captcha" i],h1,h2').some(e=>/扫码登录|请先登录|请登录后|拖动滑块|安全验证|身份验证|请完成验证/.test(text(e)) || (e.tagName==='IFRAME' && /login\.taobao\.com|captcha|punish/.test(e.src)));
  const success = /^(?:已成功加入购物车|成功加入购物车|加入购物车成功|已加入购物车|宝贝已成功加入购物车|商品已成功加入购物车)[！!。]?$/;
  const receipts=()=>all('div,span,p,[role="alert"],[role="status"]').filter(e=>success.test(text(e)) && ![...e.children].some(c=>visible(c)&&success.test(text(c))));
  const groups=()=>all(groupSelector);
  const title=()=>{for(const sel of ['[data-testid="item-title"]','[class*="ItemHeader--title"]','h1','[class*="mainTitle"]']){const titles=[...new Set(all(sel).map(text).filter(s=>s&&s.length<=250&&!/^(加载中|loading|淘宝网|天猫)[.。…]*$/i.test(s)))];if(titles.length)return only(titles);}return null;};
  function capture(){
    const p=readProduct(location.href);if(gated())return res('needs_login','请本人完成淘宝登录或验证。');
    const t=title(),gs=groups();if(!p?.sku||!t||!gs.length||gs.length>12)return res('needs_selection','请在商品页选好每组规格，等待标题和 SKU 链接更新。');
    const options=gs.map(g=>only([...new Set([...g.querySelectorAll(control)].filter(e=>visible(e)&&enabled(e)&&selected(e)).map(text).filter(Boolean))]));
    if(options.some(n=>!n||n.length>150)||new Set(options).size!==options.length)return res('needs_selection','未能唯一识别每组已选规格。');
    const url=new URL('/item.htm',location.origin);url.searchParams.set('id',p.id);url.searchParams.set('skuId',p.sku);
    return {status:'picked',candidate:{title:t,listingTitle:t,url:url.href,skuId:p.sku,options,sku:options.join(' | '),titleSource:'page'}};
  }
  const attempts=new Set(); let busy=false;
  async function run(line){
    const target=readProduct(line?.url),here=readProduct(location.href),opts=line?.options;
    if(!target||!here||target.id!==here.id)return res('not_confirmed','当前页与清单商品不一致。');
    if(gated())return res('needs_login','请本人登录或完成淘宝验证。');
    if(typeof line.title!=='string'||!norm(line.title)||line.title.length>250||!Array.isArray(opts)||!opts.length||opts.length>12||opts.some(s=>typeof s!=='string'||!norm(s)||s.length>150)||!Number.isInteger(line.qty)||line.qty<1||line.qty>999 || (line.skuId!=null&&!/^\d{1,25}$/.test(String(line.skuId))))return res('needs_selection','需要明确的标题、规格和数量。');
    const sku=line.skuId==null?target.sku:String(line.skuId),names=opts.map(norm);
    if(new Set(names).size!==names.length||[target.sku,here.sku].some(s=>s&&sku&&s!==sku)) return res('needs_selection','链接与清单规格不一致。');
    const heading=()=>{const h=title();return h&&(h===norm(line.title)||!!sku);};
    if(!heading())return res('needs_selection','商品标题尚未加载，或没有 SKU 来核对与清单不同的商品名。');
    const key=[here.id,sku||'',...names].join('|');if(attempts.has(key))return res('not_confirmed','本页已点击过该规格，请核对实际购物车，不会重复点击。');
    for(const name of names){const el=option(name);if(!el)return res('needs_selection','无法唯一识别可见规格：'+name);if(!selected(el)){el.click();for(let i=0;i<12&&!selected(option(name)||el);i++)await sleep(100);}if(gated())return res('needs_login','淘宝要求本人登录或验证。');}
    const specsMatch=()=>{const p=readProduct(location.href);if(p?.id!==target.id||!heading()||!names.every(n=>{const e=option(n);return e&&selected(e)}))return false;const gs=groups();const complete=gs.length===names.length&&gs.every(g=>names.filter(n=>g.contains(option(n))).length===1);return sku?p.sku===sku&&(gs.length?complete:title()===norm(line.title)):complete;};
    if(!specsMatch())return res('needs_selection','请在淘宝选择清单中的完整规格，核对 SKU 后再继续。');
    const quantity=()=>only(all('input').filter(e=>enabled(e)&&!e.readOnly&&(e.type==='number'||e.getAttribute('role')==='spinbutton'||/数量|购买量/.test((e.getAttribute('aria-label')||'')+(e.title||''))||/quantity|countValue/i.test(e.className))));
    const q=quantity();if(!q)return res('needs_selection','无法唯一识别可见购买数量。');
    if(q.value!==String(line.qty)){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(q,String(line.qty));for(const t of ['input','change','blur'])q.dispatchEvent(new Event(t,{bubbles:true}));}await sleep(250);
    const button=only(all(control).filter(e=>text(e)==='加入购物车'&&enabled(e)));
    if(gated())return res('needs_login','请本人完成淘宝登录或验证。');
    if(!button||!specsMatch()||quantity()?.value!==String(line.qty))return res('needs_selection','规格、数量或唯一的加购按钮尚未确认。');
    const actualTitle=title(),note=actualTitle!==norm(line.title)?` 页面商品名：「${actualTitle}」。`: '';const before=new Set(receipts());attempts.add(key);button.click();
    for(let i=0;i<24;i++){await sleep(200);if(gated())return res('needs_login','淘宝要求登录或验证，请先核对实际购物车。');if(readProduct(location.href)?.id!==target.id)return res('not_confirmed','页面已切换，请核对实际购物车。');if(receipts().some(e=>!before.has(e)))return res('added','本次点击后商品页显示了新的加购成功提示；请在购物车核对数量。'+note);}
    return res('not_confirmed','已点击一次，淘宝未显示可辨认的新成功提示。请核对购物车。'+note);
  }
  chrome.runtime.onMessage.addListener((event,sender,reply)=>{
    if(sender.id!==chrome.runtime.id)return;
    if(event?.type==='FORMBENCH_CAPTURE_LINE'){reply(capture());return;}
    if(event?.type!=='FORMBENCH_ADD_LINE')return;
    if(busy){reply(res('not_confirmed','本页正在处理另一项。'));return;}
    busy=true;run(event.line).then(reply,()=>reply(res('not_confirmed','页面发生变化，请核对实际购物车。'))).finally(()=>busy=false);return true;
  });
})();
