// @ts-check
/** Reject asynchronous frame callbacks before their command encoder can be submitted. @param {unknown} result */
export function assertSynchronous(result) {
    if (result !== null && typeof result === 'object' && 'then' in result && typeof result.then === 'function') {
        // Drain a possible rejection while reporting the contract violation synchronously.
        Promise.resolve(result).catch(() => {});
        throw new Error('Frame callbacks must be synchronous; await loading in initialize instead');
    }
}
