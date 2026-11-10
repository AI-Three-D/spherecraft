// core/world/hydrology/waterCache.js
//
// IndexedDB cache for the water system (plan 6.3): the sampled topology
// grid and solved lakes, keyed by a hash of everything that shapes the
// terrain (shader source, terrain uniforms, biome authoring) plus the grid
// size and the algorithm version. Any terrain change gives a new key, so
// stale entries are never read. No-op where IndexedDB is missing (Node lab,
// some private windows); failures are logged and treated as cache misses.

import { Logger } from '../../../shared/Logger.js';

const DB_NAME = 'spherecraft-water';
const STORE = 'entries';

/** FNV-1a (32-bit) over strings and byte arrays, chained; returns hex. */
export function hashParts(parts) {
    let h = 0x811c9dc5;
    const mixByte = (b) => { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; };
    for (const part of parts) {
        if (typeof part === 'string') {
            for (let i = 0; i < part.length; i++) { const c = part.charCodeAt(i); mixByte(c & 0xff); mixByte(c >>> 8); }
        } else if (part instanceof ArrayBuffer || ArrayBuffer.isView(part)) {
            const bytes = part instanceof ArrayBuffer ? new Uint8Array(part) : new Uint8Array(part.buffer, part.byteOffset, part.byteLength);
            for (let i = 0; i < bytes.length; i++) mixByte(bytes[i]);
        } else {
            const s = JSON.stringify(part) ?? 'undefined';
            for (let i = 0; i < s.length; i++) mixByte(s.charCodeAt(i) & 0xff);
        }
        mixByte(0x1f); // part separator
    }
    return h.toString(16).padStart(8, '0');
}

export class WaterCache {
    constructor() {
        this._db = null;
        this._opening = null;
        this.available = typeof indexedDB !== 'undefined';
    }

    _open() {
        if (!this.available) return Promise.resolve(null);
        if (this._db) return Promise.resolve(this._db);
        if (!this._opening) {
            this._opening = new Promise((resolve) => {
                try {
                    const req = indexedDB.open(DB_NAME, 1);
                    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
                    req.onsuccess = () => { this._db = req.result; resolve(this._db); };
                    req.onerror = () => { Logger.warn(`[WaterCache] open failed: ${req.error}`); this.available = false; resolve(null); };
                } catch (err) {
                    Logger.warn(`[WaterCache] open failed: ${err?.message || err}`);
                    this.available = false;
                    resolve(null);
                }
            });
        }
        return this._opening;
    }

    async get(key) {
        const db = await this._open();
        if (!db) return null;
        return new Promise((resolve) => {
            try {
                const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
                req.onsuccess = () => resolve(req.result ?? null);
                req.onerror = () => resolve(null);
            } catch { resolve(null); }
        });
    }

    async put(key, value) {
        const db = await this._open();
        if (!db) return false;
        return new Promise((resolve) => {
            try {
                const tx = db.transaction(STORE, 'readwrite');
                tx.objectStore(STORE).put(value, key);
                tx.oncomplete = () => resolve(true);
                tx.onerror = () => { Logger.warn(`[WaterCache] put failed: ${tx.error}`); resolve(false); };
            } catch (err) {
                Logger.warn(`[WaterCache] put failed: ${err?.message || err}`);
                resolve(false);
            }
        });
    }

    /** Deletes every entry whose key does not contain keyPart. Resolves to the count. */
    async pruneExcept(keyPart) {
        const db = await this._open();
        if (!db) return 0;
        return new Promise((resolve) => {
            try {
                const tx = db.transaction(STORE, 'readwrite');
                const store = tx.objectStore(STORE);
                let removed = 0;
                const req = store.getAllKeys();
                req.onsuccess = () => {
                    for (const k of req.result) {
                        if (typeof k === 'string' && k.includes(keyPart)) continue;
                        store.delete(k);
                        removed++;
                    }
                };
                tx.oncomplete = () => resolve(removed);
                tx.onerror = () => resolve(0);
            } catch { resolve(0); }
        });
    }

    /** Deletes every entry (qtDiag.water.clearCache()). */
    async clear() {
        const db = await this._open();
        if (!db) return false;
        return new Promise((resolve) => {
            try {
                const tx = db.transaction(STORE, 'readwrite');
                tx.objectStore(STORE).clear();
                tx.oncomplete = () => resolve(true);
                tx.onerror = () => resolve(false);
            } catch { resolve(false); }
        });
    }
}
