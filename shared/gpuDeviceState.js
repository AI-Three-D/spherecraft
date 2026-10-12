import {Logger} from './Logger.js';

const states=new WeakMap();

// A lost device invalidates every resource made from it. Keep one shared
// terminal state so renderers and background terrain work stop together.
export function gpuDeviceLoss(device) {
    if(!device)return null;
    let state=states.get(device);
    if(!state) {
        state={loss:null};states.set(device,state);
        device.lost?.then(info=>{state.loss={reason:info.reason,message:info.message};});
    }
    return state.loss;
}

export function reportGpuAsyncFailure(device,operation,error) {
    gpuDeviceLoss(device);
    const state=states.get(device);
    // Browser instance teardown can reject pending operations before the
    // device.lost callback runs. Recognize that same terminal failure here.
    if(state&&!state.loss&&/Instance dropped|valid external Instance reference/i.test(error?.message??''))
        state.loss={reason:'unknown',message:error.message};
    if(state?.loss)return;
    Logger.error(`[WebGPU] ${operation} failed:`,error?.message??error);
}
