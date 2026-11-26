// Server-only configuration. Never serialize credentials into a task or response.
export function configuredOpenAIKeys(env={}){
  const seen=new Set();
  return Object.keys(env).filter(name=>/^OPENAI_API_KEY(?:_[1-9]\d*)?$/.test(name))
    .sort((a,b)=>Number(a.slice(15)||0)-Number(b.slice(15)||0))
    .flatMap(name=>{
      const value=typeof env[name]==='string'?env[name].trim():'';
      if(!value||seen.has(value))return [];
      seen.add(value);return [{name,value}];
    });
}
export const hasOpenAIKey=env=>configuredOpenAIKeys(env).length>0;
// Evidence receipts keep a stable signing key; API failover does not invalidate them.
export const primaryOpenAIKey=env=>configuredOpenAIKeys(env)[0]?.value;

export const poolOwner=Symbol('credential pool owner');
const pools=new WeakMap();
export function openAIKeyPool(env){
  const owner=env[poolOwner]||env;let pool=pools.get(owner);
  if(!pool){pool={credentials:[],exhausted:new Set(),until:new Map(),preferred:null};pools.set(owner,pool);}
  pool.credentials=configuredOpenAIKeys(env);
  const present=new Set(pool.credentials.map(c=>c.value));
  for(const value of pool.exhausted)if(!present.has(value)||(pool.until.get(value)??Infinity)<=Date.now()){pool.exhausted.delete(value);pool.until.delete(value);}
  if(!present.has(pool.preferred))pool.preferred=null;
  return pool;
}
export function resetOpenAIKeyPool(env){pools.delete(env[poolOwner]||env);}
