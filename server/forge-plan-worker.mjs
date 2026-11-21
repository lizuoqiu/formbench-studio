import {parentPort,workerData} from 'node:worker_threads';
import {compileCadPlan} from '../cad-plan-compiler.js';
const emit=workerData.progress ? progress=>parentPort.postMessage({progress}) : undefined;
try{parentPort.postMessage({result:await compileCadPlan(workerData.plan,emit)})}
catch(error){parentPort.postMessage({error:error instanceof Error?error.message:'实体编译失败。'})}
