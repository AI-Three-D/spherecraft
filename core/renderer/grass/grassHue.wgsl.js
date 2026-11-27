// Shared by the grass blades (grassWgsl.js) and the ground they stand on (terrainPass.wgsl.js).

/**
 * The hue of grass by climate, as a factor on the ground's grass colour (groundMaterials.js means): blue-green where
 * cool, deep green where warm and wet, yellow-green where it dries. The terrain (terrainPass.wgsl.js) and the blades
 * take it alike, so that blades and the ground they hand over to agree. Needs step3.
 */
export const GRASS_HUE_WGSL = /* wgsl */`
fn grassHue(temperature: f32, humidity: f32) -> vec3<f32> {
    let warm = step3(0.40, 0.68, temperature);
    let lush = mix(vec3<f32>(0.80, 1.06, 1.40), vec3<f32>(0.82, 1.10, 1.04), warm);
    return mix(lush, vec3<f32>(1.12, 1.05, 0.90), 0.7 * step3(0.55, 0.25, humidity));
}
`;
