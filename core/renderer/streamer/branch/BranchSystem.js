// js/renderer/streamer/branch/BranchSystem.js


export class BranchSystem {
    static generateBirch(seed, params = {}, BirchBranchGenerator) {
        if (!BirchBranchGenerator) {
            throw new Error('BranchSystem.generateBirch requires BirchBranchGenerator');
        }
        return BirchBranchGenerator.generateBirch(seed, params);
    }
}
