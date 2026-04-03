// js/renderer/streamer/branch/BranchSystem.js

import { BirchBranchGenerator } from './species/BirchBranchGenerator.js';

export class BranchSystem {
    static generateBirch(seed, params = {}) {
        return BirchBranchGenerator.generateBirch(seed, params);
    }
}
