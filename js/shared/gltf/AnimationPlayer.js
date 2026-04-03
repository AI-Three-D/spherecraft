// js/assets/gltf/AnimationPlayer.js

import { AnimationSampler } from './AnimationSampler.js';
import { Pose } from './Pose.js';

export class AnimationPlayer {
    constructor(asset, modelDescriptor) {
        this._asset = asset;
        this._model = modelDescriptor;

        this._a = _empty();
        this._b = _empty();
        this._blendT = 1;
        this._blendDur = 0;
        this._aFinished = false;

        this._ext = null;       // ragdoll / procedural override
        this._extT = 0;
        this._extDur = 0;
    }

    /**
     * Transition to a clip.
     * opts: { speed, loop, blendTime, startTime, force }
     * Returns false if the animId is not in the model descriptor.
     */
    play(animId, opts = {}) {
        const clip = this._model.clip(animId);
        if (!clip) return false;

        if (!opts.force && this._a.animId === animId) {
            if (opts.speed !== undefined) this._a.speed = opts.speed;
            return true;
        }

        const blend = opts.blendTime ?? clip.blendIn ?? this._model.blendDefaults.in;
        if (this._a.animId >= 0 && blend > 0) {
            this._b = { ...this._a };   // snapshot, not reference
            this._blendT = 0;
            this._blendDur = blend;
        } else {
            this._b = _empty();
            this._blendT = 1;
        }

        this._a = {
            animId, clip,
            time: opts.startTime ?? 0,
            speed: opts.speed ?? 1,
            loop: opts.loop ?? clip.loop,
        };
        this._aFinished = false;
        return true;
    }

    /** Ragdoll hook. Pass null to release back to animation. */
    setExternalPose(pose, blendTime = 0.2) {
        this._ext = pose ? Pose.clone(pose) : null;
        this._extDur = blendTime;
    }

    /**
     * @returns {{ pose:Map, finished:boolean }}
     *
     * pose has the root node's XZ translation stripped so the mesh
     * stays at model origin regardless of authored motion.
     * finished fires exactly once when a non-looping clip hits its end.
     */
    tick(dt) {
        // Fade-out slot: wrap if it was a loop, else let it run past the end
        // (_sampleChannel clamps to last frame, which is correct during a fade).
        if (this._b.animId >= 0) {
            this._b.time += dt * (this._b.speed ?? 1);
            if (this._b.loop) {
                const bd = this._b.clip.anim.duration;
                if (bd > 0) this._b.time = ((this._b.time % bd) + bd) % bd;
            }
        }
    
        let finished = false;
    
        if (this._a.animId >= 0) {
            this._a.time += dt * this._a.speed;
    
            const dur = this._a.clip.anim.duration;
            if (dur > 0) {
                if (this._a.loop) {
                    this._a.time = ((this._a.time % dur) + dur) % dur;
                } else if (this._a.time >= dur) {
                    this._a.time = dur;   // safe now — no modulo downstream
                    if (!this._aFinished) { finished = true; this._aFinished = true; }
                }
            }
        }

        if (this._blendT < 1) {
            this._blendT = Math.min(1, this._blendT + dt / Math.max(this._blendDur, 1e-4));
            if (this._blendT >= 1) this._b = _empty();
        }

        const extTarget = this._ext ? 1 : 0;
        if (this._extT !== extTarget) {
            const step = dt / Math.max(this._extDur, 1e-4);
            this._extT = extTarget > this._extT
                ? Math.min(1, this._extT + step)
                : Math.max(0, this._extT - step);
        }

        const poseA = this._sample(this._a);
        let pose = poseA;
        if (this._b.animId >= 0 && this._blendT < 1) {
            pose = Pose.blend(this._sample(this._b), poseA, this._blendT);
        }
        if (this._extT > 0 && this._ext) {
            pose = Pose.blend(pose, this._ext, this._extT);
        }

        return { pose, finished };
    }

    get currentAnimId() { return this._a.animId; }

    _sample(slot) {
        if (slot.animId < 0) return new Map();
        const pose = AnimationSampler.sample(slot.clip.anim, slot.time);

        // Strip root node XZ translation in all clips. The root node is
        // the skeleton root (lowest depth node with translation channels),
        // not necessarily the mesh node. Position is owned by game logic.
        const rm = slot.clip.rootMotion;
        if (rm?.valid) {
            Pose.stripTranslation(pose, rm.nodeIndex, rm.bindTranslation, rm.mask);
        }
        return pose;
    }
}

function _empty() {
    return { animId: -1, clip: null, time: 0, speed: 1, loop: true };
}