// Classic worker for the unmodified occt-import-js UMD loader; do not run it on the UI thread.
onmessage=async({data:{buffer,filename}})=>{
  try{
    const {decodePurchasedCad}=await import('../../part-geometry.js');let reader;
    if(!/\.stl$/i.test(filename)){importScripts('./occt-import-js.js');reader=await occtimportjs({locateFile:file=>new URL(file,self.location.href).href});}
    postMessage({result:decodePurchasedCad(new Uint8Array(buffer),filename,reader)});
  }catch(e){postMessage({error:e?.message||'无法读取 CAD，请检查源文件。'});}
};
