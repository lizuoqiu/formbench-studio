// Buyer-facing entry points. Official site navigation stays in the buyer's own browser.
import {catalog} from './catalog.mjs';
import {createHandoff} from './cart.mjs';
export async function buyerSearch(part,env=process.env){
 const response=await catalog(new Request('https://workbench.invalid/api/catalog',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:part?.name,spec:part?.spec??''})}),env);
 const body=await response.json();
 return {...body,state:body.candidates?.length?'candidates':body.searchUrl?'search_handoff':'invalid',candidates:body.candidates||[],verified:false};
}
export async function buyerCart(items,env=process.env){
 const result=await createHandoff(items,env);
 return {...result,items:result.items.map(i=>({...i,status:'not_verified_in_cart'})),receipt:null};
}
