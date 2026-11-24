/** Uniforms of CloudCompositePass, shared with the passes that prepare its lookups. */
export const CLOUD_COMPOSITE_UNIFORMS_WGSL = /* wgsl */`
struct CompositeUniforms {
    viewport: vec4f,  // width, height, shadow strength, world units per km
    atmo0: vec4f,     // planet radius, atmosphere radius, Rayleigh scale height, Mie scale height (world units)
    atmo1: vec4f,     // Rayleigh scattering rgb, Mie scattering (per world unit)
    atmo2: vec4f,     // Mie g, sun intensity, shadow floor, reach of the haze lookup (km)
    mistRay: vec4f,   // camera radius² minus the mist layer's and the ground's (km²), optical depth scale (0 = no mist)
    mistPath: vec4f,  // shortest path (km) and 1 / range: rays that meet the ground, rays that do not
    rays: vec4f,      // god rays: beam scattering (1/km), share of the haze that clouds shadow, reach (km), share of cloud extinction
    rays2: vec4f,     // beam phase g, isotropic share of the beam phase, beam height scale (km), darkening between beams
    rays3: vec4f,     // beam fade over distance (1/km)
}
`;
