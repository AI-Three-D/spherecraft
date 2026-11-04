import { CapturedHeightfield } from './CapturedHeightfield.js';
import { VoxelVolume } from './VoxelVolume.js';
import { RockModel } from './RockModel.js';

/**
 * A voxel region: the captured ground, the editable volume under (and just above) it, and the rock
 * description. The volume is a box over the heightfield footprint, from `depth` metres below the
 * lowest captured point (rounded down to a chunk) to `headroom` above the highest.
 */
export class VoxelRegion {
    /**
     * @param {Object} options
     * @param {import('./CapturedHeightfield.js').HeightfieldDescriptor | CapturedHeightfield} options.heightfield
     * @param {object} options.rock see RockModel
     * @param {object[]} [options.carves] edits applied at creation (natural caves, pre-dug tunnels)
     */
    constructor({ heightfield, rock, voxelSize = 0.25, chunkSize = 32, depth = 100, headroom = 4, carves = [] }) {
        this.surface = heightfield instanceof CapturedHeightfield ? heightfield : new CapturedHeightfield(heightfield);
        this.frame = this.surface.frame;
        const chunkMetres = chunkSize * voxelSize;
        const minY = Math.floor((this.surface.minHeight - depth) / chunkMetres) * chunkMetres;
        const maxY = Math.ceil((this.surface.maxHeight + headroom) / chunkMetres) * chunkMetres;
        this.volume = new VoxelVolume({ surface: this.surface, minY, maxY, voxelSize, chunkSize });
        this.rock = new RockModel(rock, this.surface);
        for (const op of carves) this.volume.apply(op);
    }

    /** Apply an edit; see VoxelVolume.apply. */
    apply(op) { return this.volume.apply(op); }
}