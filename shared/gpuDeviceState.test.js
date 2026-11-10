import {describe,it,expect,vi} from 'vitest';
import {gpuDeviceLoss,reportGpuAsyncFailure} from './gpuDeviceState.js';

describe('shared GPU device loss',()=>{
    it('publishes one terminal state for foreground and background work',async()=>{
        let lose;const device={lost:new Promise(resolve=>{lose=resolve;})};
        expect(gpuDeviceLoss(device)).toBeNull();
        lose({reason:'destroyed',message:'test shutdown'});await device.lost;
        expect(gpuDeviceLoss(device)).toEqual({reason:'destroyed',message:'test shutdown'});
    });
    it('handles instance cancellation even before the lost callback arrives',()=>{
        const device={lost:new Promise(()=>{})},log=vi.spyOn(console,'error').mockImplementation(()=>{});
        try {
            reportGpuAsyncFailure(device,'readback',new Error('A valid external Instance reference no longer exists.'));
            expect(gpuDeviceLoss(device)?.reason).toBe('unknown');
            reportGpuAsyncFailure(device,'scope',new Error('Instance dropped in popErrorScope'));
            expect(log).not.toHaveBeenCalled();
        } finally {log.mockRestore();}
    });
    it('reports independent errors instead of treating them as device loss',()=>{
        const device={},log=vi.spyOn(console,'error').mockImplementation(()=>{});
        try {
            reportGpuAsyncFailure(device,'readback',new Error('Buffer already mapped'));
            expect(gpuDeviceLoss(device)).toBeNull();expect(log).toHaveBeenCalledOnce();
        } finally {log.mockRestore();}
    });
});
