// js/renderer/utils/SeededRandom.js

export class SeededRandom {
    constructor(seed = 0) {
        this.seed = seed >>> 0;
    }

    next() {
        this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
        return this.seed / 4294967296;
    }

    range(min, max) {
        return min + this.next() * (max - min);
    }

    rangeInt(min, max) {
        return Math.floor(this.range(min, max + 1));
    }

    pick(array) {
        return array[Math.floor(this.next() * array.length)];
    }
}
