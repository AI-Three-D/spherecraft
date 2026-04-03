// js/assets/gltf/Pose.js
//
// A Pose is Map<nodeIndex, {translation?, rotation?, scale?}>.
// Same shape AnimationSampler.sample() emits and SkeletonPose.compute()
// consumes as its `overrides` argument — no conversion glue needed.
//
// Blend helpers are standalone so the port to a compute shader is
// mechanical (per-bone lerp/slerp, one thread per bone). Ragdoll
// reuses blend() verbatim: physics builds a Pose, then
// blend(animPose, ragdollPose, t) gives the knockout transition.

export class Pose {
    /** t=0 → a, t=1 → b. Nodes/channels in only one side pass through. */
    static blend(a, b, t) {
        if (t <= 0) return a;
        if (t >= 1) return b;
        const out = new Map();
        for (const k of a.keys()) out.set(k, null);
        for (const k of b.keys()) out.set(k, null);
        for (const k of out.keys()) {
            const va = a.get(k), vb = b.get(k);
            if (!va) { out.set(k, vb); continue; }
            if (!vb) { out.set(k, va); continue; }
            out.set(k, {
                translation: _lerpV3(va.translation, vb.translation, t),
                rotation:    _slerpQ(va.rotation,    vb.rotation,    t),
                scale:       _lerpV3(va.scale,       vb.scale,       t),
            });
        }
        return out;
    }

    /**
     * Clamp a node's translation components back to bind pose.
     * Called after sampling a root-motion clip so the skeleton stays
     * at model origin while the world transform carries the motion.
     */
    static stripTranslation(pose, nodeIndex, bindT, mask) {
        const e = pose.get(nodeIndex);
        if (!e?.translation) return;
        if (mask.x) e.translation[0] = bindT[0];
        if (mask.y) e.translation[1] = bindT[1];
        if (mask.z) e.translation[2] = bindT[2];
    }

    static clone(src) {
        const out = new Map();
        for (const [k, v] of src) {
            out.set(k, {
                translation: v.translation ? [...v.translation] : undefined,
                rotation:    v.rotation    ? [...v.rotation]    : undefined,
                scale:       v.scale       ? [...v.scale]       : undefined,
            });
        }
        return out;
    }
}

function _lerpV3(a, b, t) {
    if (!a) return b; if (!b) return a;
    return [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t];
}
function _slerpQ(a, b, t) {
    if (!a) return b; if (!b) return a;
    let d = a[0]*b[0]+a[1]*b[1]+a[2]*b[2]+a[3]*b[3];
    let bx=b[0],by=b[1],bz=b[2],bw=b[3];
    if (d<0){d=-d;bx=-bx;by=-by;bz=-bz;bw=-bw;}
    if (d>0.9995){
        const x=a[0]+(bx-a[0])*t, y=a[1]+(by-a[1])*t;
        const z=a[2]+(bz-a[2])*t, w=a[3]+(bw-a[3])*t;
        const l=Math.hypot(x,y,z,w)||1; return [x/l,y/l,z/l,w/l];
    }
    const th=Math.acos(Math.min(1,d)), s=Math.sin(th);
    const wa=Math.sin((1-t)*th)/s, wb=Math.sin(t*th)/s;
    return [a[0]*wa+bx*wb, a[1]*wa+by*wb, a[2]*wa+bz*wb, a[3]*wa+bw*wb];
}