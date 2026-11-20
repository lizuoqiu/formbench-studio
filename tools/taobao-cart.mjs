#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {normalizeItems,createHandoff,loginUrl,cartUrl} from '../server/cart.mjs';
const [file,mode='--links']=process.argv.slice(2);
try{if(file==='--login'){console.log(`请在浏览器打开淘宝官方登录页，扫码入口以该页实际显示为准：${loginUrl}`);}else if(!file||!['--links','--validate','--check','--add'].includes(mode)){throw Error('用法：node tools/taobao-cart.mjs 清单.json [--links|--validate]，或 --login');}else{const {items}=JSON.parse(await readFile(file,'utf8'));if(mode==='--validate'){console.log(`清单结构有效：${normalizeItems(items).length} 项；未访问淘宝。`);}else if(['--add','--check'].includes(mode)){throw Error(`自动操作及读取浏览器购物车已停用；使用 --links 获取官方链接，在 ${cartUrl} 查看结果。`);}else{console.log(JSON.stringify(await createHandoff(items,process.env),null,2));}}}catch(e){console.error(e.message);process.exitCode=1;}
