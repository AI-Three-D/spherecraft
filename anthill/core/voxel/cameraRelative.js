import { Matrix4 } from '../../shared/math/index.js';

const rotation = new Matrix4();
const model = new Matrix4();
const projection = new Matrix4();

/**
 * clipFromLocal = projection * rotation(view) * [frame axes | frame origin - camera position].
 *
 * Only the rotation of camera.matrixWorldInverse is used: its float32 translation carries the
 * ~1.3e5 m world offset and is only good to about a centimetre. The translation is rebuilt from
 * camera.position in doubles, so every float32 Matrix4 here holds small camera-relative numbers.
 *
 * @param {import('./RegionFrame.js').RegionFrame} frame
 * @param {{position: {x:number,y:number,z:number}, matrixWorldInverse: {elements: ArrayLike<number>}, projectionMatrix: {elements: ArrayLike<number>}}} camera
 * @param {Matrix4} out
 */
export function composeClipFromLocal(frame, camera, out) {
    const v = camera.matrixWorldInverse.elements;
    rotation.set(
        v[0], v[4], v[8], 0,
        v[1], v[5], v[9], 0,
        v[2], v[6], v[10], 0,
        0, 0, 0, 1,
    );
    frame.writeLocalToCameraRelative(camera.position, model.elements);
    projection.elements.set(camera.projectionMatrix.elements);
    return out.multiplyMatrices(projection, rotation).multiply(model);
}