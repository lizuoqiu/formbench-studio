import {parentPort,workerData} from 'node:worker_threads';
import {readPurchasedCad} from '../part-geometry.js';
try{parentPort.postMessage(await readPurchasedCad(new Uint8Array(workerData.bytes),workerData.filename));}
catch(error){parentPort.postMessage({error:error.message});}
