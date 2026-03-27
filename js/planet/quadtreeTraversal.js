// js/planet/quadtreeTraversal.js
// Flat-array quadtree traversal state for chunk selection.

export class QuadtreeTraverser {
    constructor(maxNodes = 1024) {
        this._allocate(maxNodes);
    }

    _allocate(capacity) {
        this.capacity = capacity;
        this.stackFace = new Uint8Array(capacity);
        this.stackLevel = new Uint8Array(capacity);
        this.stackX = new Uint32Array(capacity);
        this.stackY = new Uint32Array(capacity);
        this.stackTop = 0;

        this.selectedFace = new Uint8Array(capacity);
        this.selectedLevel = new Uint8Array(capacity);
        this.selectedX = new Uint32Array(capacity);
        this.selectedY = new Uint32Array(capacity);
        this.selectedCount = 0;
    }

    ensureCapacity(minCapacity) {
        if (minCapacity <= this.capacity) return;
        let next = this.capacity;
        while (next < minCapacity) next *= 2;
        const prevStackTop = this.stackTop;
        const prevSelectedCount = this.selectedCount;
        const prevStackFace = this.stackFace;
        const prevStackLevel = this.stackLevel;
        const prevStackX = this.stackX;
        const prevStackY = this.stackY;
        const prevSelectedFace = this.selectedFace;
        const prevSelectedLevel = this.selectedLevel;
        const prevSelectedX = this.selectedX;
        const prevSelectedY = this.selectedY;
        this._allocate(next);
        this.stackFace.set(prevStackFace.subarray(0, prevStackTop));
        this.stackLevel.set(prevStackLevel.subarray(0, prevStackTop));
        this.stackX.set(prevStackX.subarray(0, prevStackTop));
        this.stackY.set(prevStackY.subarray(0, prevStackTop));
        this.selectedFace.set(prevSelectedFace.subarray(0, prevSelectedCount));
        this.selectedLevel.set(prevSelectedLevel.subarray(0, prevSelectedCount));
        this.selectedX.set(prevSelectedX.subarray(0, prevSelectedCount));
        this.selectedY.set(prevSelectedY.subarray(0, prevSelectedCount));
        this.stackTop = prevStackTop;
        this.selectedCount = prevSelectedCount;
    }

    reset() {
        this.stackTop = 0;
        this.selectedCount = 0;
    }

    push(face, level, x, y) {
        if (this.stackTop >= this.capacity) {
            this.ensureCapacity(this.stackTop + 1);
        }
        const idx = this.stackTop++;
        this.stackFace[idx] = face;
        this.stackLevel[idx] = level;
        this.stackX[idx] = x;
        this.stackY[idx] = y;
    }

    pop() {
        if (this.stackTop <= 0) return null;
        this.stackTop--;
        const idx = this.stackTop;
        return {
            face: this.stackFace[idx],
            level: this.stackLevel[idx],
            x: this.stackX[idx],
            y: this.stackY[idx]
        };
    }

    popInto(out) {
        if (this.stackTop <= 0) return false;
        this.stackTop--;
        const idx = this.stackTop;
        out.face = this.stackFace[idx];
        out.level = this.stackLevel[idx];
        out.x = this.stackX[idx];
        out.y = this.stackY[idx];
        return true;
    }

    select(face, level, x, y) {
        if (this.selectedCount >= this.capacity) {
            this.ensureCapacity(this.selectedCount + 1);
        }
        const idx = this.selectedCount++;
        this.selectedFace[idx] = face;
        this.selectedLevel[idx] = level;
        this.selectedX[idx] = x;
        this.selectedY[idx] = y;
    }
}
