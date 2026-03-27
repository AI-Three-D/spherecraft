struct AtmosphereUniforms {
    planetRadius: f32,
    atmosphereRadius: f32,
    rayleighScaleHeight: f32,
    mieScaleHeight: f32,
    
    rayleighScattering: vec3<f32>,
    mieScattering: f32,
    
    ozoneAbsorption: vec3<f32>,
    _pad0: f32,
    
    textureSize: vec2<f32>,
    _pad1: vec2<f32>,
}

@group(0) @binding(0) var<uniform> atmo: AtmosphereUniforms;
@group(0) @binding(1) var outputTexture: texture_storage_2d<rgba16float, write>;

const PI: f32 = 3.14159265359;
const TRANSMITTANCE_STEPS: i32 = 40;

fn raySphereIntersect(origin: vec3<f32>, dir: vec3<f32>, radius: f32) -> vec2<f32> {
    let a = dot(dir, dir);
    let b = 2.0 * dot(origin, dir);
    let c = dot(origin, origin) - radius * radius;
    let d = b * b - 4.0 * a * c;
    
    if (d < 0.0) {
        return vec2<f32>(-1.0, -1.0);
    }
    
    let sqrtD = sqrt(d);
    return vec2<f32>(
        (-b - sqrtD) / (2.0 * a),
        (-b + sqrtD) / (2.0 * a)
    );
}

fn getAltitude(pos: vec3<f32>) -> f32 {
    return length(pos) - atmo.planetRadius;
}

fn getDensityRayleigh(altitude: f32) -> f32 {
    return exp(-max(0.0, altitude) / atmo.rayleighScaleHeight);
}

fn getDensityMie(altitude: f32) -> f32 {
    return exp(-max(0.0, altitude) / atmo.mieScaleHeight);
}

fn getDensityOzone(altitude: f32) -> f32 {
    let ozoneCenter = 25000.0;
    let ozoneWidth = 15000.0;
    let x = (altitude - ozoneCenter) / ozoneWidth;
    return max(0.0, 1.0 - x * x);
}

fn uvToTransmittanceParams(uv: vec2<f32>) -> vec2<f32> {
    let H = sqrt(atmo.atmosphereRadius * atmo.atmosphereRadius - 
                 atmo.planetRadius * atmo.planetRadius);
    
    let rho = H * uv.x;
    let r = sqrt(rho * rho + atmo.planetRadius * atmo.planetRadius);
    
    let dMin = atmo.atmosphereRadius - r;
    let dMax = rho + H;
    let d = dMin + uv.y * (dMax - dMin);
    
    var cosTheta: f32;
    if (d == 0.0) {
        cosTheta = 1.0;
    } else {
        cosTheta = (H * H - rho * rho - d * d) / (2.0 * r * d);
    }
    cosTheta = clamp(cosTheta, -1.0, 1.0);
    
    return vec2<f32>(r - atmo.planetRadius, cosTheta);
}

fn computeTransmittance(altitude: f32, cosTheta: f32) -> vec3<f32> {
    let r = atmo.planetRadius + altitude;
    let origin = vec3<f32>(0.0, r, 0.0);
    
    let sinTheta = sqrt(max(0.0, 1.0 - cosTheta * cosTheta));
    let dir = vec3<f32>(sinTheta, cosTheta, 0.0);
    
    let intersection = raySphereIntersect(origin, dir, atmo.atmosphereRadius);
    if (intersection.y < 0.0) {
        return vec3<f32>(1.0, 1.0, 1.0);
    }
    
    let groundIntersect = raySphereIntersect(origin, dir, atmo.planetRadius);
    var rayLength = intersection.y;
    if (groundIntersect.x > 0.0) {
        rayLength = min(rayLength, groundIntersect.x);
    }
    
    let stepSize = rayLength / f32(TRANSMITTANCE_STEPS);
    
    var opticalDepthRayleigh = vec3<f32>(0.0);
    var opticalDepthMie: f32 = 0.0;
    var opticalDepthOzone = vec3<f32>(0.0);
    
    for (var i = 0; i < TRANSMITTANCE_STEPS; i++) {
        let t = (f32(i) + 0.5) * stepSize;
        let pos = origin + dir * t;
        let alt = getAltitude(pos);
        
        let densityR = getDensityRayleigh(alt);
        let densityM = getDensityMie(alt);
        let densityO = getDensityOzone(alt);
        
        opticalDepthRayleigh += atmo.rayleighScattering * densityR * stepSize;
        opticalDepthMie += atmo.mieScattering * densityM * stepSize;
        opticalDepthOzone += atmo.ozoneAbsorption * densityO * stepSize;
    }
    
    let totalOpticalDepth = opticalDepthRayleigh + vec3<f32>(opticalDepthMie) + opticalDepthOzone;
    return exp(-totalOpticalDepth);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let texSize = vec2<u32>(u32(atmo.textureSize.x), u32(atmo.textureSize.y));
    
    if (id.x >= texSize.x || id.y >= texSize.y) {
        return;
    }
    
    let uv = vec2<f32>(
        (f32(id.x) + 0.5) / f32(texSize.x),
        (f32(id.y) + 0.5) / f32(texSize.y)
    );
    
    let params = uvToTransmittanceParams(uv);
    let altitude = params.x;
    let cosTheta = params.y;
    
    let transmittance = computeTransmittance(altitude, cosTheta);
    
    textureStore(outputTexture, vec2<i32>(id.xy), vec4<f32>(transmittance, 1.0));
}