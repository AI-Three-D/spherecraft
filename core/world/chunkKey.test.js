import { describe, it, expect } from 'vitest';
import {
    mortonEncode,
    mortonDecode,
    createChunkKey,
    parseChunkKey,
    chunkKeyToString,
    ChunkKey,
    FLAT_FACE,
    COORD_BIAS,
} from './chunkKey.js';

// ── Morton encoding ────────────────────────────────────────────────────────────

describe('mortonEncode / mortonDecode', () => {
    it('roundtrips (0, 0)', () => {
        const code = mortonEncode(0, 0);
        expect(mortonDecode(code)).toEqual({ x: 0, y: 0 });
    });
    it('roundtrips (1, 0)', () => {
        const code = mortonEncode(1, 0);
        expect(mortonDecode(code)).toEqual({ x: 1, y: 0 });
    });
    it('roundtrips (0, 1)', () => {
        const code = mortonEncode(0, 1);
        expect(mortonDecode(code)).toEqual({ x: 0, y: 1 });
    });
    it('roundtrips arbitrary values', () => {
        const pairs = [[17, 42], [255, 128], [1000, 999]];
        for (const [x, y] of pairs) {
            expect(mortonDecode(mortonEncode(x, y))).toEqual({ x, y });
        }
    });
    it('x and y bits are interleaved (x in even positions)', () => {
        // x=1 (bit 0 set) → bit 0 of code; y=0 → code = 1n
        expect(mortonEncode(1, 0)).toBe(1n);
        // y=1 (bit 0 set) → bit 1 of code; x=0 → code = 2n
        expect(mortonEncode(0, 1)).toBe(2n);
    });
});

// ── createChunkKey / parseChunkKey ────────────────────────────────────────────

describe('createChunkKey / parseChunkKey (spherical)', () => {
    it('roundtrips face, lod, x, y', () => {
        const key = createChunkKey(2, 3, 7, 11);
        const parsed = parseChunkKey(key);
        expect(parsed.face).toBe(2);
        expect(parsed.level).toBe(3);
        expect(parsed.x).toBe(7);
        expect(parsed.y).toBe(11);
        expect(parsed.isFlat).toBe(false);
    });
    it('roundtrips face 0 at lod 0', () => {
        const key = createChunkKey(0, 0, 0, 0);
        const parsed = parseChunkKey(key);
        expect(parsed.face).toBe(0);
        expect(parsed.level).toBe(0);
        expect(parsed.x).toBe(0);
        expect(parsed.y).toBe(0);
    });
    it('roundtrips all six faces', () => {
        for (let face = 0; face < 6; face++) {
            const key = createChunkKey(face, 1, 5, 5);
            expect(parseChunkKey(key).face).toBe(face);
        }
    });
});

describe('createChunkKey / parseChunkKey (flat)', () => {
    it('roundtrips flat key with null face', () => {
        const key = createChunkKey(null, 0, 10, 20);
        const parsed = parseChunkKey(key);
        expect(parsed.face).toBeNull();
        expect(parsed.x).toBe(10);
        expect(parsed.y).toBe(20);
        expect(parsed.isFlat).toBe(true);
    });
    it('roundtrips negative flat coordinates', () => {
        const key = createChunkKey(null, 0, -5, -3);
        const parsed = parseChunkKey(key);
        expect(parsed.x).toBe(-5);
        expect(parsed.y).toBe(-3);
    });
});

describe('parseChunkKey (string formats)', () => {
    it('parses flat string "x,y"', () => {
        const parsed = parseChunkKey('17,5');
        expect(parsed.x).toBe(17);
        expect(parsed.y).toBe(5);
        expect(parsed.isFlat).toBe(true);
    });
    it('parses spherical string "face:x,y:lod"', () => {
        const parsed = parseChunkKey('2:7,11:3');
        expect(parsed.face).toBe(2);
        expect(parsed.x).toBe(7);
        expect(parsed.y).toBe(11);
        expect(parsed.level).toBe(3);
        expect(parsed.isFlat).toBe(false);
    });
    it('throws on invalid string', () => {
        expect(() => parseChunkKey('abc,def')).toThrow();
    });
    it('throws on non-string non-bigint', () => {
        expect(() => parseChunkKey(42)).toThrow();
    });
});

describe('chunkKeyToString', () => {
    it('returns flat string for flat key', () => {
        const key = createChunkKey(null, 0, 3, 7);
        expect(chunkKeyToString(key)).toBe('3,7');
    });
    it('returns spherical string for spherical key', () => {
        const key = createChunkKey(4, 2, 1, 1);
        expect(chunkKeyToString(key)).toBe('4:1,1:2');
    });
    it('is identity for string input', () => {
        expect(chunkKeyToString('17,5')).toBe('17,5');
    });
});

// ── ChunkKey class ────────────────────────────────────────────────────────────

describe('ChunkKey', () => {
    describe('construction', () => {
        it('stores x, y, face, lod', () => {
            const ck = new ChunkKey(3, 7, 2, 1);
            expect(ck.x).toBe(3);
            expect(ck.y).toBe(7);
            expect(ck.face).toBe(2);
            expect(ck.lod).toBe(1);
        });
        it('defaults face to null and lod to 0', () => {
            const ck = new ChunkKey(1, 2);
            expect(ck.face).toBeNull();
            expect(ck.lod).toBe(0);
        });
        it('throws on invalid x', () => {
            expect(() => new ChunkKey(NaN, 0)).toThrow();
        });
        it('throws on invalid face', () => {
            expect(() => new ChunkKey(0, 0, 6)).toThrow();
            expect(() => new ChunkKey(0, 0, -1)).toThrow();
        });
    });

    describe('toString', () => {
        it('flat: "x,y"', () => {
            expect(new ChunkKey(5, 9).toString()).toBe('5,9');
        });
        it('spherical: "face:x,y:lod"', () => {
            expect(new ChunkKey(3, 4, 1, 2).toString()).toBe('1:3,4:2');
        });
    });

    describe('fromKey (string roundtrip)', () => {
        it('rebuilds from flat string', () => {
            const ck = ChunkKey.fromKey('8,12');
            expect(ck.x).toBe(8);
            expect(ck.y).toBe(12);
            expect(ck.face).toBeNull();
        });
        it('rebuilds from spherical string', () => {
            const ck = ChunkKey.fromKey('3:5,6:1');
            expect(ck.face).toBe(3);
            expect(ck.x).toBe(5);
            expect(ck.y).toBe(6);
            expect(ck.lod).toBe(1);
        });
    });

    describe('toMortonKey roundtrip', () => {
        it('converts to bigint and back', () => {
            const original = new ChunkKey(10, 20, 3, 2);
            const morton = original.toMortonKey();
            expect(typeof morton).toBe('bigint');
            const rebuilt = ChunkKey.fromKey(morton);
            expect(rebuilt.x).toBe(10);
            expect(rebuilt.y).toBe(20);
            expect(rebuilt.face).toBe(3);
            expect(rebuilt.lod).toBe(2);
        });
    });

    describe('isFlat / isSpherical', () => {
        it('flat when face is null', () => {
            const ck = new ChunkKey(0, 0);
            expect(ck.isFlat()).toBe(true);
            expect(ck.isSpherical()).toBe(false);
        });
        it('spherical when face is set', () => {
            const ck = new ChunkKey(0, 0, 0);
            expect(ck.isFlat()).toBe(false);
            expect(ck.isSpherical()).toBe(true);
        });
    });

    describe('equals', () => {
        it('equal keys', () => {
            expect(new ChunkKey(1, 2, 3, 0).equals(new ChunkKey(1, 2, 3, 0))).toBe(true);
        });
        it('different x', () => {
            expect(new ChunkKey(1, 2).equals(new ChunkKey(9, 2))).toBe(false);
        });
        it('different face', () => {
            expect(new ChunkKey(1, 2, 0).equals(new ChunkKey(1, 2, 1))).toBe(false);
        });
        it('returns false for non-ChunkKey', () => {
            expect(new ChunkKey(1, 2).equals({ x: 1, y: 2 })).toBe(false);
        });
    });

    describe('clone', () => {
        it('produces an equal but distinct instance', () => {
            const original = new ChunkKey(3, 4, 2, 1);
            const copy = original.clone();
            expect(copy.equals(original)).toBe(true);
            expect(copy).not.toBe(original);
        });
    });

    describe('offset', () => {
        it('shifts coordinates', () => {
            const ck = new ChunkKey(5, 5, 0, 0);
            const shifted = ck.offset(2, -1);
            expect(shifted.x).toBe(7);
            expect(shifted.y).toBe(4);
            expect(shifted.face).toBe(0);
        });
    });
});
