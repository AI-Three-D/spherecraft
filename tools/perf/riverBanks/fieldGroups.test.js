import { expect, it } from 'vitest';
import { pageKey, riverFieldLayout } from '../../../core/world/water/riverField.js';
import { fieldPageGroups } from './fieldGroups.js';

it('joins adjacent pages and every page of the same river without joining distant independent groups', () => {
    const L = riverFieldLayout(131000), key = (f, x, y) => pageKey(f, x, y, L);
    const keys = [key(0, 10, 10), key(0, 11, 11), key(0, 30, 30), key(0, 80, 80), key(1, 80, 80)];
    const groups = fieldPageGroups(keys, [[1], [2], [2], [3], [4]], L);
    expect(groups).toEqual([{ pages: 3, rivers: 2 }, { pages: 1, rivers: 1 }, { pages: 1, rivers: 1 }]);
});
