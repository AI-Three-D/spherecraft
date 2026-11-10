// core/renderer/rivers/shaders/riverNoise.wgsl.js
//
// Hash/value-noise helpers shared by the river sim and water shaders.
// Ported verbatim from whitewater's WGSL_NOISE.

export const RIVER_WGSL_NOISE = /* wgsl */`
fn hash21(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
fn hash31(p: vec3f) -> f32 {
  var p3 = fract(p * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
fn noise2(p: vec2f) -> f32 {
  let i = floor(p); let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = hash21(i); let b = hash21(i + vec2f(1.0, 0.0));
  let c = hash21(i + vec2f(0.0, 1.0)); let d = hash21(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
fn noise3(p: vec3f) -> f32 {
  let i = floor(p); let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let n000 = hash31(i); let n100 = hash31(i + vec3f(1.0,0.0,0.0));
  let n010 = hash31(i + vec3f(0.0,1.0,0.0)); let n110 = hash31(i + vec3f(1.0,1.0,0.0));
  let n001 = hash31(i + vec3f(0.0,0.0,1.0)); let n101 = hash31(i + vec3f(1.0,0.0,1.0));
  let n011 = hash31(i + vec3f(0.0,1.0,1.0)); let n111 = hash31(i + vec3f(1.0,1.0,1.0));
  return mix(mix(mix(n000,n100,u.x), mix(n010,n110,u.x), u.y),
             mix(mix(n001,n101,u.x), mix(n011,n111,u.x), u.y), u.z);
}
`;
