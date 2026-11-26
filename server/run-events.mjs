// This module is shared with the Worker. Disk persistence is supplied only by the Mac server.
import {poolOwner} from './openai-keys.mjs';
const observer=Symbol('formbench.run.observer');
export const observeRun=(env,sink)=>sink?{...env,[poolOwner]:env[poolOwner]||env,[observer]:sink}:env;
export const runSink=env=>env[observer];
export function track(env,event,fields){env[observer]?.(event,fields);}
