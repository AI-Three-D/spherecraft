# Transmittance LUT feature
We are implementing an atmosphere for our procedural planet. This phase consists of the following steps.

## Step 2.1: LUT Texture Resources
- Create 256x64 RGBA16F texture for transmittance
- Store in AtmosphericScatteringLUT class
- Persistent (not per-chunk)
## Step 2.2: Transmittance Computation
- WebGPU: Compute shader
- WebGL2: Fullscreen quad with FBO
- Ray march from altitude to space
- Accumulate extinction coefficients
- Store exp(-optical_depth)
## Step 2.3: Multi-Scattering LUT
- 32x32 texture
- Second-order scattering approximation
## Step 2.4: LUT Regeneration
- Mark dirty on planet switch
- Regenerate at frame start if dirty
## Phase 3: Aerial Perspective
### Step 3.1: Integrate into Terrain Shader
In fragment shader after lighting:
transmittance = sampleTransmittanceLUT(altitude, viewZenith)
inscatter = computeInscatter(rayDir, sunDir, altitude)
finalColor = terrainColor * transmittance + inscatter
### Step 3.2: Altitude-Based Fog
Replace current exponential fog:
density(alt) = density0 * exp(-alt / scaleHeight)
### Step 3.3: Horizon Scattering
For sky pixels (no terrain hit):
- Ray march through atmosphere
- Accumulate scattering toward sun
- Blend to black at high altitude

## Current implementation
Steps 2.1 - 3.1 have been implemented. However, some of the implemented phases can be still incomplete. There is a an atmospheric test rendering enabled at the moment, and if the program runs, it produces a golden-brown-white gradient which fills the screen. However, the program does not run do the a missing setter (and possible other problems). Please fix the problems and implement all remaining steps.

## Test criteria 