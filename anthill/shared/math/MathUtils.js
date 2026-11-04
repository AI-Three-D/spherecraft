// js/shared/math/MathUtils.js
// Math helpers exported both as individual functions and bundled in a
// MathUtils namespace object (so call sites can use either form).

export function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

export function clamp01(value) {
    return clamp(value, 0, 1);
}

export function clampInt(value, min, max) {
    return clamp(Math.floor(value), min, max);
}

export function clampByte(value) {
    return clampInt(value | 0, 0, 255);
}

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

export function degToRad(degrees) {
    return degrees * DEG2RAD;
}

export function radToDeg(radians) {
    return radians * RAD2DEG;
}

export const MathUtils = {
    DEG2RAD,
    RAD2DEG,
    clamp,
    clamp01,
    clampInt,
    clampByte,
    degToRad,
    radToDeg,
};
