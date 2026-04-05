// js/shared/math/index.js
// Single entry point for the in-house math library. Importers can do
// either:
//   import { Vector3, Matrix4 } from '../../shared/math/index.js';
// or import directly from the individual files.

export { Vector2 } from './Vector2.js';
export { Vector3 } from './Vector3.js';
export { Vector4 } from './Vector4.js';
export { Matrix4 } from './Matrix4.js';
export { Quaternion } from './Quaternion.js';
export { Euler } from './Euler.js';
export { Color } from './Color.js';
export { Box3 } from './Box3.js';
export { MathUtils, clamp, clamp01, clampInt, clampByte, degToRad, radToDeg } from './MathUtils.js';
