/** Preserve resident GPU data when a sparse cache grows. Copies precede later writes. */
export function growStorageBuffer(device, previous, usedBytes, size, label) {
    const buffer = device.createBuffer({ label, size, usage: 128 | 8 | 4 });
    if (previous && usedBytes) {
        const encoder = device.createCommandEncoder({ label: `${label} growth` });
        encoder.copyBufferToBuffer(previous, 0, buffer, 0, usedBytes);
        device.queue.submit([encoder.finish()]);
    }
    previous?.destroy();
    return buffer;
}
