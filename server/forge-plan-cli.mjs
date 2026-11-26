// The request supplies bounded CAD features. Only the adapter constructs executable source.
import {execFile} from 'node:child_process';
import {accessSync,constants,readFileSync,realpathSync} from 'node:fs';
import {mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {delimiter,dirname,isAbsolute,join,resolve} from 'node:path';
import {promisify} from 'node:util';
import {cadBodyToForgeScript} from '../forge-source.js';
import {cadBodyProgress} from '../cad-plan.js';
import {MAX_ASSEMBLY_STL_BYTES} from '../cad-limits.js';

const run = promisify(execFile);
export const researchVersion = '0.8.2';
const maxBytes = MAX_ASSEMBLY_STL_BYTES;
const failure = (message,status) => Object.assign(new Error(message),{status});

export function forgeMode(env) {
  if (env.FORGECAD_ENTERPRISE_AUTOMATION === 'true') return 'enterprise';
  if (env.FORGECAD_RESEARCH_AUTOMATION === 'true') return 'research';
  return null;
}

function verifyResearchBinary(binary) {
  if (!isAbsolute(binary)) throw failure('请配置研究版 ForgeCAD 可执行文件的绝对路径。',503);
  const entry = realpathSync(binary);
  accessSync(entry,constants.X_OK);
  // npm creates a .bin symlink to the package's declared executable.
  for (let dir=dirname(entry), depth=0; depth<5; depth++,dir=dirname(dir)) {
    let manifest;
    try { manifest = JSON.parse(readFileSync(join(dir,'package.json'),'utf8')); }
    catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (manifest.name !== 'forgecad') continue;
    const target = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.forgecad;
    if (manifest.version === researchVersion && manifest.license === 'BUSL-1.1' && typeof target === 'string' &&
        realpathSync(resolve(dir,target)) === entry) return manifest.version;
    break;
  }
  throw failure(`本机研究模式需要官方 forgecad@${researchVersion} 的 CLI。`,503);
}

// This is a configuration probe only. Successful compilation reports the actual version.
export function configuredForgeEngine(env={}) {
  const mode=forgeMode(env);
  if (!mode) return null;
  try {
    if (mode === 'research') verifyResearchBinary(env.FORGECAD_BIN || '');
    else {
      const binary=env.FORGECAD_BIN || 'forgecad';
      const candidates=isAbsolute(binary)?[binary]:(env.PATH || '').split(delimiter).map(dir=>join(dir,binary));
      if (!candidates.some(path=>{try {accessSync(path,constants.X_OK);return true} catch {return false}})) return null;
    }
    return 'forgecad';
  } catch {return null}
}

async function readExport(file,remaining) {
  const size = (await stat(file)).size;
  if (size < 134) throw failure('ForgeCAD 导出的实体为空；请检查切削是否完全消除了该实体。',422);
  if (size > remaining) throw failure(`整机网格总量超出 ${maxBytes/1024/1024} MiB；请降低非配合曲面的离散精度并保留所需零件。`,422);
  if (size > 84+50*65000) throw failure('此实体网格超出 65,000 个三角面的上限。',422);
  const data = await readFile(file);
  const n = data.readUInt32LE(80);
  if (n === 0 || data.length !== 84+n*50) throw failure('ForgeCAD 导出的二进制 STL 无效。',502);
  for (let i=0;i<n;i++) {
    for (let j=0;j<12;j++) {
      if (!Number.isFinite(data.readFloatLE(84+50*i+4*j))) throw failure('ForgeCAD 导出的 STL 含有无效坐标。',502);
    }
  }
  return data;
}

export async function compileWithForge(plan,env,mode,requestSignal,onProgress) {
  const binary = env.FORGECAD_BIN || 'forgecad';
  const deadline = AbortSignal.timeout(Math.max(80_000,plan.bodies.length*4000));
  const signal = AbortSignal.any([requestSignal,deadline]);
  let dir,currentBody='';
  try {
    dir = await mkdtemp(join(tmpdir(),'formbench-forge-plan-'));
    await writeFile(join(dir,'forgecad.json'),'{}');
    const childEnv = Object.fromEntries(['PATH','HOME','TMPDIR','TEMP','SystemRoot','USERPROFILE','FORGECAD_TOKEN']
      .filter(key=>env[key]).map(key=>[key,env[key]]));
    const options = {cwd:dir,env:childEnv,signal,maxBuffer:256*1024,killSignal:'SIGKILL'};
    let version;
    if (mode === 'research') {
      version = verifyResearchBinary(binary);
    } else {
      const {stdout} = await run(binary,['--version'],options);
      version = stdout.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0];
      if (!version) throw failure('无法识别 ForgeCAD CLI 的版本。',503);
    }
    const bodies = [];
    let remaining = maxBytes;
    for (const [i,body] of plan.bodies.entries()) {
      signal.throwIfAborted();
      currentBody=`实体 #${i}「${body.name}」（BOM #${body.partIndex}）：`;
      onProgress?.(cadBodyProgress(plan,i,'start'));
      const fileName = `part-${body.partIndex+1}-body-${i+1}.stl`;
      const source = join(dir,`part-${i+1}.forge.js`), output = join(dir,fileName);
      await writeFile(source,cadBodyToForgeScript(body));
      await run(binary,['export','stl',source,'--output',output],options);
      const stl = await readExport(output,remaining);
      remaining -= stl.length;
      const {partIndex,name,role,positionMm} = body;
      bodies.push({partIndex,name,role,positionMm,fileName,stlBase64:stl.toString('base64')});
      onProgress?.(cadBodyProgress(plan,i,'finish'));
    }
    return {engine:`ForgeCAD CLI ${version}`,version,units:'mm',bodies};
  } catch(e) {
    if (requestSignal.aborted) throw failure('已取消 ForgeCAD 编译。',408);
    if (deadline.aborted) throw failure('ForgeCAD 编译超时，请减少实体特征后重试。',504);
    if (e.status) {e.message=currentBody+e.message;throw e;}
    if (/not (?:logged|signed) in|log[ -]?in required|please (?:log|sign) in|forgecad login|requires authentication/i.test(String(e.stderr)))
      throw failure('ForgeCAD CLI 需要登录。请先使用本机 ForgeCAD 账户登录，再重新计算。',503);
    if (e.code === 'ENOENT') throw failure('找不到 ForgeCAD 可执行文件或预期的 STL 输出，请检查本机安装。',503);
    throw failure(currentBody+'ForgeCAD 无法完成实体导出，请检查设计特征与本机运行配置。',422);
  } finally {
    if (dir) await rm(dir,{recursive:true,force:true});
  }
}
