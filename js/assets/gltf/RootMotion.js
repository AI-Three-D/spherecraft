// js/assets/gltf/RootMotion.js
//
// One instance per (animation × root-node), built at load time.
// Computes frame-to-frame translation delta with correct loop-wrap
// handling. Delta is in the clip's local space; caller transforms to
// world using the actor's surface tangent frame + facing yaw.

import { AnimationSampler } from './AnimationSampler.js';

export class RootMotion {
    constructor(animation, nodeIndex, bindTranslation, mask) {
        this.nodeIndex = nodeIndex;
        this.bindTranslation = bindTranslation;
        this.mask = mask;
        this._duration = animation.duration;

        this._channel = null;
        for (const ch of animation.channels) {
            if (ch.targetNodeIndex === nodeIndex && ch.targetPath === 'translation') {
                this._channel = ch; break;
            }
        }
        this._start = this._channel ? this._at(0)              : [...bindTranslation];
        this._end   = this._channel ? this._at(this._duration) : [...bindTranslation];
    }

    get valid() { return this._channel !== null; }

    /** Masked delta between two clip times. Handles one loop wrap. */
    delta(t0, t1, looping) {
        if (!this._channel) return null;
        const d = this._duration;
        let a = t0, b = t1;
        if (d > 0) { a = ((a % d) + d) % d; b = ((b % d) + d) % d; }
        if (!looping || b >= a) return this._sub(this._at(b), this._at(a));
        // Wrapped this tick: (end − a) + (b − start)
        const l1 = this._sub(this._end, this._at(a));
        const l2 = this._sub(this._at(b), this._start);
        return [l1[0]+l2[0], l1[1]+l2[1], l1[2]+l2[2]];
    }

    /** Total clip displacement — useful for deriving authored walk speed. */
    totalDisplacement() {
        return this._channel ? this._sub(this._end, this._start) : [0,0,0];
    }

    _at(t)    { return AnimationSampler._sampleChannel(this._channel, t); }
    _sub(a,b) {
        const m = this.mask;
        return [m.x ? a[0]-b[0] : 0, m.y ? a[1]-b[1] : 0, m.z ? a[2]-b[2] : 0];
    }
}