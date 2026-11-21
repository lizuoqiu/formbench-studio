import {parentPort,workerData} from 'node:worker_threads';
import {compileCadPlan} from '../cad-plan-compiler.js';
try{parentPort.postMessage({result:await compileCadPlan(workerData)})}
catch(error){parentPort.postMessage({error:error instanceof Error?error.message:'实体编译失败。'})}
