// The classic worker hosts the upstream UMD wrapper. Only the reader runtime
// comes over the network. The project and its CAD files stay in the browser.
let reader;
async function startStepReader(){
  importScripts('./occt-import-js.js');
  const options={locateFile:file=>new URL(file,self.location.href).href};
  if(typeof DecompressionStream==='function'){
    const compressed=await fetch('./occt-import-js.wasm.gz');
    if(compressed.ok){
      const bytes=new Uint8Array(await compressed.arrayBuffer());
      // Some static hosts transparently decompress .gz resources.
      if(bytes[0]===0x1f&&bytes[1]===0x8b){
        const stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
        options.wasmBinary=new Uint8Array(await new Response(stream).arrayBuffer());
      }else if(bytes[0]===0&&bytes[1]===0x61)options.wasmBinary=bytes;
    }
  }
  return occtimportjs(options);
}
onmessage=async({data:{buffer,filename,protocol}})=>{
  try{
    const {decodePurchasedCad}=await import('../../part-geometry.js');
    if(!/\.stl$/i.test(filename)&&!reader)reader=await startStepReader();
    if(protocol===2)postMessage({phase:'parsing'});
    postMessage({result:decodePurchasedCad(new Uint8Array(buffer),filename,reader)});
  }catch(e){postMessage({error:e?.message||'无法读取 CAD，请检查源文件。'});}
};
