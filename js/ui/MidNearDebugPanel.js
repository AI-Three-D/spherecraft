// js/ui/MidNearDebugPanel.js
//
// Real-time debug panel for adjusting mid-near tree rendering parameters:
// canopy hull shape, impostor cards, trunk, distance ranges.
// Changes are written to TreeLODController and trigger pipeline rebuild.

import { Logger } from '../config/Logger.js';

// ─── Parameter definitions ─────────────────────────────────────────────
// Each param: { label, group, min, max, step, default, get(ctrl), set(ctrl,v) }
// get/set operate on a TreeLODController instance.

const PARAM_DEFS = [

    // ── Distance & Range ──────────────────────────────────────────────
    { key: 'range.start', label: 'Range Start (m)', group: 'Distance & Range',
      min: 20, max: 150, step: 1, default: 55,
      get: c => c.midNearRange.start,
      set: (c, v) => { c.midNearRange.start = v; } },
    { key: 'range.end', label: 'Range End (m)', group: 'Distance & Range',
      min: 100, max: 500, step: 1, default: 220,
      get: c => c.midNearRange.end,
      set: (c, v) => { c.midNearRange.end = v; } },
    { key: 'overlapNear', label: 'Overlap Near', group: 'Distance & Range',
      min: 1, max: 40, step: 1, default: 13,
      get: c => c.midNearOverlapNear,
      set: (c, v) => { c.midNearOverlapNear = v; } },
    { key: 'overlapFar', label: 'Overlap Far', group: 'Distance & Range',
      min: 1, max: 60, step: 1, default: 20,
      get: c => c.midNearOverlapFar,
      set: (c, v) => { c.midNearOverlapFar = v; } },
    { key: 'subBandOverlap', label: 'Sub-Band Overlap', group: 'Distance & Range',
      min: 1, max: 40, step: 1, default: 15,
      get: c => c.midNearSubBandOverlap,
      set: (c, v) => { c.midNearSubBandOverlap = v; } },

    // Sub-band boundaries
    { key: 'sb0.start', label: 'SB0 Start (m)', group: 'Sub-Band Distances',
      min: 20, max: 150, step: 1, default: 55,
      get: c => c.midNearSubBands[0]?.start ?? 55,
      set: (c, v) => { if (c.midNearSubBands[0]) c.midNearSubBands[0].start = v; } },
    { key: 'sb0.end', label: 'SB0 End (m)', group: 'Sub-Band Distances',
      min: 50, max: 200, step: 1, default: 100,
      get: c => c.midNearSubBands[0]?.end ?? 100,
      set: (c, v) => { if (c.midNearSubBands[0]) c.midNearSubBands[0].end = v; } },
    { key: 'sb1.start', label: 'SB1 Start (m)', group: 'Sub-Band Distances',
      min: 50, max: 200, step: 1, default: 100,
      get: c => c.midNearSubBands[1]?.start ?? 100,
      set: (c, v) => { if (c.midNearSubBands[1]) c.midNearSubBands[1].start = v; } },
    { key: 'sb1.end', label: 'SB1 End (m)', group: 'Sub-Band Distances',
      min: 100, max: 300, step: 1, default: 160,
      get: c => c.midNearSubBands[1]?.end ?? 160,
      set: (c, v) => { if (c.midNearSubBands[1]) c.midNearSubBands[1].end = v; } },
    { key: 'sb2.start', label: 'SB2 Start (m)', group: 'Sub-Band Distances',
      min: 100, max: 300, step: 1, default: 160,
      get: c => c.midNearSubBands[2]?.start ?? 160,
      set: (c, v) => { if (c.midNearSubBands[2]) c.midNearSubBands[2].start = v; } },
    { key: 'sb2.end', label: 'SB2 End (m)', group: 'Sub-Band Distances',
      min: 150, max: 500, step: 1, default: 220,
      get: c => c.midNearSubBands[2]?.end ?? 220,
      set: (c, v) => { if (c.midNearSubBands[2]) c.midNearSubBands[2].end = v; } },

    // ── Hull Resolution (geometry rebuild) ─────────────────────────────
    { key: 'hull.lon', label: 'Hull Longitude Segments', group: 'Hull Resolution ⚠',
      min: 6, max: 48, step: 2, default: 24, rebuildsGeometry: true,
      get: c => c.midNearCanopyHullConfig.hullLon,
      set: (c, v) => { c.midNearCanopyHullConfig.hullLon = v; } },
    { key: 'hull.lat', label: 'Hull Latitude Segments', group: 'Hull Resolution ⚠',
      min: 4, max: 32, step: 2, default: 14, rebuildsGeometry: true,
      get: c => c.midNearCanopyHullConfig.hullLat,
      set: (c, v) => { c.midNearCanopyHullConfig.hullLat = v; } },

    // ── Canopy Hull Shape ──────────────────────────────────────────────
    { key: 'hull.inflation', label: 'Inflation', group: 'Canopy Hull Shape',
      min: 0.3, max: 2.0, step: 0.01, default: 0.93,
      get: c => c.midNearCanopyHullConfig.hullInflation,
      set: (c, v) => { c.midNearCanopyHullConfig.hullInflation = v; } },
    { key: 'hull.shrinkWrap', label: 'Shrink Wrap', group: 'Canopy Hull Shape',
      min: 0.0, max: 1.5, step: 0.01, default: 1.00,
      get: c => c.midNearCanopyHullConfig.hullShrinkWrap,
      set: (c, v) => { c.midNearCanopyHullConfig.hullShrinkWrap = v; } },
    { key: 'hull.verticalBias', label: 'Vertical Bias', group: 'Canopy Hull Shape',
      min: 0.3, max: 2.5, step: 0.01, default: 0.94,
      get: c => c.midNearCanopyHullConfig.hullVerticalBias,
      set: (c, v) => { c.midNearCanopyHullConfig.hullVerticalBias = v; } },
    { key: 'hull.spreadRadialScale', label: 'Spread Radial Scale', group: 'Canopy Hull Shape',
      min: 0.1, max: 2.0, step: 0.01, default: 0.86,
      get: c => c.midNearCanopyHullConfig.hullSpreadRadialScale,
      set: (c, v) => { c.midNearCanopyHullConfig.hullSpreadRadialScale = v; } },
    { key: 'hull.spreadVerticalScale', label: 'Spread Vertical Scale', group: 'Canopy Hull Shape',
      min: 0.05, max: 2.0, step: 0.01, default: 0.64,
      get: c => c.midNearCanopyHullConfig.hullSpreadVerticalScale,
      set: (c, v) => { c.midNearCanopyHullConfig.hullSpreadVerticalScale = v; } },
    { key: 'hull.thinBase', label: 'Thin Base', group: 'Canopy Hull Shape',
      min: 0.01, max: 1.0, step: 0.01, default: 0.10,
      get: c => c.midNearCanopyHullConfig.hullThinBase,
      set: (c, v) => { c.midNearCanopyHullConfig.hullThinBase = v; } },
    { key: 'hull.topShrinkStart', label: 'Top Shrink Start', group: 'Canopy Hull Shape',
      min: 0.1, max: 1.0, step: 0.01, default: 0.54,
      get: c => c.midNearCanopyHullConfig.hullTopShrinkStart,
      set: (c, v) => { c.midNearCanopyHullConfig.hullTopShrinkStart = v; } },
    { key: 'hull.topShrinkEnd', label: 'Top Shrink End', group: 'Canopy Hull Shape',
      min: 0.3, max: 1.0, step: 0.01, default: 0.96,
      get: c => c.midNearCanopyHullConfig.hullTopShrinkEnd,
      set: (c, v) => { c.midNearCanopyHullConfig.hullTopShrinkEnd = v; } },
    { key: 'hull.topShrinkStrength', label: 'Top Shrink Strength', group: 'Canopy Hull Shape',
      min: 0.0, max: 1.0, step: 0.01, default: 0.46,
      get: c => c.midNearCanopyHullConfig.hullTopShrinkStrength,
      set: (c, v) => { c.midNearCanopyHullConfig.hullTopShrinkStrength = v; } },
    { key: 'hull.maxAnchors', label: 'Max Anchors Per Tree', group: 'Canopy Hull Shape',
      min: 4, max: 128, step: 1, default: 64,
      get: c => c.midNearCanopyHullConfig.maxAnchorsPerTree,
      set: (c, v) => { c.midNearCanopyHullConfig.maxAnchorsPerTree = v; } },

    // ── Canopy Hull Rendering ──────────────────────────────────────────
    { key: 'canopy.envelopeExpand', label: 'Envelope Expand', group: 'Canopy Hull Rendering',
      min: 0.3, max: 2.0, step: 0.01, default: 0.92,
      get: c => c.midNearCanopyHullConfig.canopyEnvelopeExpand,
      set: (c, v) => { c.midNearCanopyHullConfig.canopyEnvelopeExpand = v; } },
    { key: 'canopy.envelopeSoftness', label: 'Envelope Softness', group: 'Canopy Hull Rendering',
      min: 0.001, max: 0.2, step: 0.001, default: 0.015,
      get: c => c.midNearCanopyHullConfig.canopyEnvelopeSoftness,
      set: (c, v) => { c.midNearCanopyHullConfig.canopyEnvelopeSoftness = v; } },
    { key: 'canopy.bumpStrength', label: 'Bump Strength', group: 'Canopy Hull Rendering',
      min: 0.0, max: 1.0, step: 0.01, default: 0.18,
      get: c => c.midNearCanopyHullConfig.canopyBumpStrength,
      set: (c, v) => { c.midNearCanopyHullConfig.canopyBumpStrength = v; } },
    { key: 'canopy.cutoutStrength', label: 'Cutout Strength', group: 'Canopy Hull Rendering',
      min: 0.0, max: 0.2, step: 0.001, default: 0.016,
      get: c => c.midNearCanopyHullConfig.canopyCutoutStrength,
      set: (c, v) => { c.midNearCanopyHullConfig.canopyCutoutStrength = v; } },
    { key: 'canopy.brightness', label: 'Brightness', group: 'Canopy Hull Rendering',
      min: 0.2, max: 3.0, step: 0.01, default: 1.00,
      get: c => c.midNearCanopyHullConfig.canopyBrightness,
      set: (c, v) => { c.midNearCanopyHullConfig.canopyBrightness = v; } },
    { key: 'canopy.fieldThreshold', label: 'Field Threshold', group: 'Canopy Hull Rendering',
      min: 0.0, max: 1.0, step: 0.01, default: 0.56,
      get: c => c.midNearCanopyHullConfig.canopyFieldThreshold,
      set: (c, v) => { c.midNearCanopyHullConfig.canopyFieldThreshold = v; } },
    { key: 'canopy.fieldSoftness', label: 'Field Softness', group: 'Canopy Hull Rendering',
      min: 0.01, max: 0.5, step: 0.01, default: 0.14,
      get: c => c.midNearCanopyHullConfig.canopyFieldSoftness,
      set: (c, v) => { c.midNearCanopyHullConfig.canopyFieldSoftness = v; } },
    { key: 'canopy.fieldGain', label: 'Field Gain', group: 'Canopy Hull Rendering',
      min: 0.1, max: 2.0, step: 0.01, default: 0.98,
      get: c => c.midNearCanopyHullConfig.canopyFieldGain,
      set: (c, v) => { c.midNearCanopyHullConfig.canopyFieldGain = v; } },

    // ── Trunk ──────────────────────────────────────────────────────────
    { key: 'trunk.heightFrac', label: 'Visible Height Fraction', group: 'Trunk',
      min: 0.1, max: 0.9, step: 0.01, default: 0.40,
      get: c => c.midNearTrunkConfig.visibleHeightFrac,
      set: (c, v) => { c.midNearTrunkConfig.visibleHeightFrac = v; } },
    { key: 'trunk.radiusFrac', label: 'Base Radius Fraction', group: 'Trunk',
      min: 0.005, max: 0.15, step: 0.001, default: 0.025,
      get: c => c.midNearTrunkConfig.baseRadiusFrac,
      set: (c, v) => { c.midNearTrunkConfig.baseRadiusFrac = v; } },
    { key: 'trunk.taperTop', label: 'Taper Top', group: 'Trunk',
      min: 0.1, max: 1.0, step: 0.01, default: 0.60, rebuildsGeometry: true,
      get: c => c.midNearTrunkConfig.taperTop,
      set: (c, v) => { c.midNearTrunkConfig.taperTop = v; } },
    { key: 'trunk.embedDepth', label: 'Embed Depth', group: 'Trunk',
      min: 0.0, max: 1.0, step: 0.01, default: 0.35,
      get: c => c.midNearTrunkConfig.embedDepth,
      set: (c, v) => { c.midNearTrunkConfig.embedDepth = v; } },

    // ── Impostor Sub-Band 0 ───────────────────────────────────────────
    { key: 'imp0.keepFrac', label: 'SB0 Anchor Keep Frac', group: 'Impostor Sub-Band 0',
      min: 0.0, max: 1.0, step: 0.01, default: 1.00,
      get: c => c.midNearSubBandConfig[0].anchorKeepFrac,
      set: (c, v) => { c.midNearSubBandConfig[0].anchorKeepFrac = v; } },
    { key: 'imp0.weightStart', label: 'SB0 Weight Start', group: 'Impostor Sub-Band 0',
      min: 0.0, max: 1.0, step: 0.01, default: 0.86,
      get: c => c.midNearSubBandConfig[0].impostorWeight.start,
      set: (c, v) => { c.midNearSubBandConfig[0].impostorWeight.start = v; } },
    { key: 'imp0.weightEnd', label: 'SB0 Weight End', group: 'Impostor Sub-Band 0',
      min: 0.0, max: 1.0, step: 0.01, default: 1.00,
      get: c => c.midNearSubBandConfig[0].impostorWeight.end,
      set: (c, v) => { c.midNearSubBandConfig[0].impostorWeight.end = v; } },
    { key: 'imp0.scaleW', label: 'SB0 Card Scale W', group: 'Impostor Sub-Band 0',
      min: 0.1, max: 3.0, step: 0.01, default: 0.98,
      get: c => c.midNearSubBandConfig[0].impostorCardScale.w,
      set: (c, v) => { c.midNearSubBandConfig[0].impostorCardScale.w = v; } },
    { key: 'imp0.scaleH', label: 'SB0 Card Scale H', group: 'Impostor Sub-Band 0',
      min: 0.1, max: 3.0, step: 0.01, default: 1.34,
      get: c => c.midNearSubBandConfig[0].impostorCardScale.h,
      set: (c, v) => { c.midNearSubBandConfig[0].impostorCardScale.h = v; } },

    // ── Impostor Sub-Band 1 ───────────────────────────────────────────
    { key: 'imp1.keepFrac', label: 'SB1 Anchor Keep Frac', group: 'Impostor Sub-Band 1',
      min: 0.0, max: 1.0, step: 0.01, default: 0.98,
      get: c => c.midNearSubBandConfig[1].anchorKeepFrac,
      set: (c, v) => { c.midNearSubBandConfig[1].anchorKeepFrac = v; } },
    { key: 'imp1.weightStart', label: 'SB1 Weight Start', group: 'Impostor Sub-Band 1',
      min: 0.0, max: 1.0, step: 0.01, default: 0.78,
      get: c => c.midNearSubBandConfig[1].impostorWeight.start,
      set: (c, v) => { c.midNearSubBandConfig[1].impostorWeight.start = v; } },
    { key: 'imp1.weightEnd', label: 'SB1 Weight End', group: 'Impostor Sub-Band 1',
      min: 0.0, max: 1.0, step: 0.01, default: 0.92,
      get: c => c.midNearSubBandConfig[1].impostorWeight.end,
      set: (c, v) => { c.midNearSubBandConfig[1].impostorWeight.end = v; } },
    { key: 'imp1.scaleW', label: 'SB1 Card Scale W', group: 'Impostor Sub-Band 1',
      min: 0.1, max: 3.0, step: 0.01, default: 0.92,
      get: c => c.midNearSubBandConfig[1].impostorCardScale.w,
      set: (c, v) => { c.midNearSubBandConfig[1].impostorCardScale.w = v; } },
    { key: 'imp1.scaleH', label: 'SB1 Card Scale H', group: 'Impostor Sub-Band 1',
      min: 0.1, max: 3.0, step: 0.01, default: 1.24,
      get: c => c.midNearSubBandConfig[1].impostorCardScale.h,
      set: (c, v) => { c.midNearSubBandConfig[1].impostorCardScale.h = v; } },

    // ── Impostor Sub-Band 2 ───────────────────────────────────────────
    { key: 'imp2.keepFrac', label: 'SB2 Anchor Keep Frac', group: 'Impostor Sub-Band 2',
      min: 0.0, max: 1.0, step: 0.01, default: 0.90,
      get: c => c.midNearSubBandConfig[2].anchorKeepFrac,
      set: (c, v) => { c.midNearSubBandConfig[2].anchorKeepFrac = v; } },
    { key: 'imp2.weightStart', label: 'SB2 Weight Start', group: 'Impostor Sub-Band 2',
      min: 0.0, max: 1.0, step: 0.01, default: 0.64,
      get: c => c.midNearSubBandConfig[2].impostorWeight.start,
      set: (c, v) => { c.midNearSubBandConfig[2].impostorWeight.start = v; } },
    { key: 'imp2.weightEnd', label: 'SB2 Weight End', group: 'Impostor Sub-Band 2',
      min: 0.0, max: 1.0, step: 0.01, default: 0.82,
      get: c => c.midNearSubBandConfig[2].impostorWeight.end,
      set: (c, v) => { c.midNearSubBandConfig[2].impostorWeight.end = v; } },
    { key: 'imp2.scaleW', label: 'SB2 Card Scale W', group: 'Impostor Sub-Band 2',
      min: 0.1, max: 3.0, step: 0.01, default: 0.86,
      get: c => c.midNearSubBandConfig[2].impostorCardScale.w,
      set: (c, v) => { c.midNearSubBandConfig[2].impostorCardScale.w = v; } },
    { key: 'imp2.scaleH', label: 'SB2 Card Scale H', group: 'Impostor Sub-Band 2',
      min: 0.1, max: 3.0, step: 0.01, default: 1.12,
      get: c => c.midNearSubBandConfig[2].impostorCardScale.h,
      set: (c, v) => { c.midNearSubBandConfig[2].impostorCardScale.h = v; } },
];

// ─── Utility ────────────────────────────────────────────────────────────

function groupBy(arr, fn) {
    const map = new Map();
    for (const item of arr) {
        const key = fn(item);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(item);
    }
    return map;
}

// ─── Panel class ────────────────────────────────────────────────────────

export class MidNearDebugPanel {
    /**
     * @param {object} [options]
     * @param {number} [options.rebuildDelay=200] - ms debounce for pipeline rebuild
     */
    constructor(options = {}) {
        /** @type {import('../renderer/streamer/TreeLODController.js').TreeLODController|null} */
        this._ctrl = null;
        /** @type {Function|null} */
        this._rebuildCb = null;
        /** @type {Function|null} */
        this._enableCb = null;

        this._container = null;
        this._toggleBtn = null;
        this._statusEl = null;
        this._visible = false;
        this._controls = new Map();   // key → { input, slider }
        this._rebuildTimer = null;
        this._rebuildDelay = options.rebuildDelay ?? 200;
        this._autoApply = true;
        this._needsGeometryRebuild = false;
    }

    /**
     * Wire up to the live LOD controller and rebuild callback.
     *
     * @param {import('../renderer/streamer/TreeLODController.js').TreeLODController} lodController
     * @param {Function} rebuildCallback - (options: {rebuildGeometry:boolean}) => void
     * @param {Function} [enableCallback] - (enabled:boolean) => void
     */
    attach(lodController, rebuildCallback, enableCallback) {
        this._ctrl = lodController;
        this._rebuildCb = rebuildCallback;
        this._enableCb = enableCallback;
        this._build();
        this._readAll();
    }

    // ═══════════════════════════════════════════════════════════════════
    // DOM construction
    // ═══════════════════════════════════════════════════════════════════

    _build() {
        // Toggle button
        this._toggleBtn = document.createElement('button');
        this._toggleBtn.textContent = '🌳';
        this._toggleBtn.title = 'Mid-Near Tree Debug Panel';
        Object.assign(this._toggleBtn.style, {
            position: 'fixed', top: '10px', right: '10px', zIndex: '10001',
            width: '36px', height: '36px', fontSize: '18px', cursor: 'pointer',
            background: 'rgba(0,0,0,0.7)', color: '#0f0', border: '1px solid #0f0',
            borderRadius: '4px', fontFamily: 'monospace',
        });
        this._toggleBtn.addEventListener('click', () => this._toggle());
        document.body.appendChild(this._toggleBtn);

        // Main container
        this._container = document.createElement('div');
        Object.assign(this._container.style, {
            position: 'fixed', top: '0', right: '0', width: '380px', height: '100vh',
            zIndex: '10000', background: 'rgba(10,12,18,0.94)', color: '#ccc',
            fontFamily: "'Consolas','Courier New',monospace", fontSize: '11px',
            overflowY: 'auto', overflowX: 'hidden', display: 'none',
            borderLeft: '1px solid #2a4', boxShadow: '-4px 0 16px rgba(0,0,0,0.5)',
            padding: '0',
        });
        document.body.appendChild(this._container);

        // Header
        const header = document.createElement('div');
        Object.assign(header.style, {
            padding: '10px 12px', background: 'rgba(20,40,20,0.95)',
            borderBottom: '1px solid #2a4', position: 'sticky', top: '0', zIndex: '1',
        });
        header.innerHTML = `<div style="font-size:13px;font-weight:bold;color:#4f8">
            MID-NEAR CANOPY & IMPOSTOR</div>`;

        // Toggles row
        const toggleRow = document.createElement('div');
        Object.assign(toggleRow.style, { marginTop: '6px', display: 'flex', gap: '12px', alignItems: 'center' });

        const mkCheck = (label, checked, onChange) => {
            const lbl = document.createElement('label');
            Object.assign(lbl.style, { display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' });
            const cb = document.createElement('input');
            cb.type = 'checkbox'; cb.checked = checked;
            cb.addEventListener('change', () => onChange(cb.checked));
            lbl.appendChild(cb);
            lbl.appendChild(document.createTextNode(label));
            return lbl;
        };

        toggleRow.appendChild(mkCheck('Enable Mid-Near', true, (v) => {
            this._enableCb?.(v);
        }));
        toggleRow.appendChild(mkCheck('Enable Impostors', true, (v) => {
            if (this._ctrl) {
                this._ctrl.disableMidNearImpostors = !v;
                this._scheduleRebuild();
            }
        }));
        toggleRow.appendChild(mkCheck('Auto-Apply', this._autoApply, (v) => {
            this._autoApply = v;
        }));
        header.appendChild(toggleRow);

        // Status line
        this._statusEl = document.createElement('div');
        Object.assign(this._statusEl.style, {
            marginTop: '4px', fontSize: '10px', color: '#888',
        });
        this._statusEl.textContent = 'Ready';
        header.appendChild(this._statusEl);

        this._container.appendChild(header);

        // Parameter sections
        const groups = groupBy(PARAM_DEFS, p => p.group);
        for (const [groupName, params] of groups) {
            this._container.appendChild(this._buildSection(groupName, params));
        }

        // Footer buttons
        const footer = document.createElement('div');
        Object.assign(footer.style, {
            padding: '10px 12px', borderTop: '1px solid #333',
            display: 'flex', gap: '8px', flexWrap: 'wrap',
            position: 'sticky', bottom: '0', background: 'rgba(10,12,18,0.98)',
        });

        const mkBtn = (text, color, onClick) => {
            const b = document.createElement('button');
            b.textContent = text;
            Object.assign(b.style, {
                padding: '4px 10px', fontSize: '11px', cursor: 'pointer',
                background: 'rgba(0,0,0,0.6)', color, border: `1px solid ${color}`,
                borderRadius: '3px', fontFamily: 'inherit',
            });
            b.addEventListener('click', onClick);
            return b;
        };

        footer.appendChild(mkBtn('Apply & Rebuild', '#4f8', () => this._applyAndRebuild()));
        footer.appendChild(mkBtn('Reset Defaults', '#fa0', () => this._resetDefaults()));
        footer.appendChild(mkBtn('Copy Config JSON', '#8af', () => this._copyConfig()));
        footer.appendChild(mkBtn('Paste Config JSON', '#f8a', () => this._pasteConfig()));
        this._container.appendChild(footer);
    }

    _buildSection(title, params) {
        const section = document.createElement('div');
        Object.assign(section.style, {
            borderBottom: '1px solid #222', userSelect: 'none',
        });

        const titleBar = document.createElement('div');
        Object.assign(titleBar.style, {
            padding: '6px 12px', background: 'rgba(30,50,30,0.5)', cursor: 'pointer',
            fontWeight: 'bold', fontSize: '11px', color: '#6d6',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        });
        const arrow = document.createElement('span');
        arrow.textContent = '▼';
        arrow.style.transition = 'transform 0.15s';
        titleBar.appendChild(document.createTextNode(title));
        titleBar.appendChild(arrow);

        const body = document.createElement('div');
        body.style.padding = '4px 12px 8px';
        let collapsed = false;
        titleBar.addEventListener('click', () => {
            collapsed = !collapsed;
            body.style.display = collapsed ? 'none' : 'block';
            arrow.style.transform = collapsed ? 'rotate(-90deg)' : '';
        });

        for (const p of params) {
            body.appendChild(this._buildRow(p));
        }

        section.appendChild(titleBar);
        section.appendChild(body);
        return section;
    }

    _buildRow(paramDef) {
        const row = document.createElement('div');
        Object.assign(row.style, {
            display: 'grid', gridTemplateColumns: '1fr 72px 1fr',
            gap: '4px', alignItems: 'center', marginBottom: '3px',
        });

        // Label
        const label = document.createElement('span');
        label.textContent = paramDef.label;
        label.style.color = paramDef.rebuildsGeometry ? '#fa0' : '#aaa';
        label.title = paramDef.rebuildsGeometry
            ? 'Changing this rebuilds geometry (slightly slower)'
            : paramDef.key;

        // Number input
        const input = document.createElement('input');
        input.type = 'number';
        input.min = paramDef.min;
        input.max = paramDef.max;
        input.step = paramDef.step;
        Object.assign(input.style, {
            width: '68px', background: '#1a1a2a', color: '#0ff', border: '1px solid #335',
            borderRadius: '2px', padding: '2px 4px', fontSize: '11px',
            fontFamily: 'inherit', textAlign: 'right',
        });

        // Range slider
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = paramDef.min;
        slider.max = paramDef.max;
        slider.step = paramDef.step;
        Object.assign(slider.style, {
            width: '100%', accentColor: '#4f8',
        });

        // Bidirectional linking
        const updateFromInput = () => {
            let v = parseFloat(input.value);
            if (!Number.isFinite(v)) return;
            v = Math.max(paramDef.min, Math.min(paramDef.max, v));
            slider.value = v;
            if (this._ctrl) {
                paramDef.set(this._ctrl, v);
                if (paramDef.rebuildsGeometry) this._needsGeometryRebuild = true;
                if (this._autoApply) this._scheduleRebuild();
            }
        };
        const updateFromSlider = () => {
            const v = parseFloat(slider.value);
            input.value = v;
            if (this._ctrl) {
                paramDef.set(this._ctrl, v);
                if (paramDef.rebuildsGeometry) this._needsGeometryRebuild = true;
                if (this._autoApply) this._scheduleRebuild();
            }
        };

        input.addEventListener('input', updateFromInput);
        input.addEventListener('change', updateFromInput);
        slider.addEventListener('input', updateFromSlider);

        row.appendChild(label);
        row.appendChild(input);
        row.appendChild(slider);

        this._controls.set(paramDef.key, { input, slider, def: paramDef });
        return row;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Value I/O
    // ═══════════════════════════════════════════════════════════════════

    _readAll() {
        if (!this._ctrl) return;
        for (const [key, ctrl] of this._controls) {
            const val = ctrl.def.get(this._ctrl);
            if (Number.isFinite(val)) {
                ctrl.input.value = val;
                ctrl.slider.value = val;
            }
        }
    }

    _writeAll() {
        if (!this._ctrl) return;
        for (const [key, ctrl] of this._controls) {
            const v = parseFloat(ctrl.input.value);
            if (Number.isFinite(v)) {
                ctrl.def.set(this._ctrl, v);
            }
        }
        // Also update the derived arrays that the shader config reads
        this._syncDerivedArrays();
    }

    _syncDerivedArrays() {
        if (!this._ctrl) return;
        // Update sub-band float arrays used by shader config
        for (let i = 0; i < 4; i++) {
            this._ctrl.midNearSubBandStarts[i] = this._ctrl.midNearSubBands[i]?.start ?? 99999;
            this._ctrl.midNearSubBandEnds[i]   = this._ctrl.midNearSubBands[i]?.end   ?? 99999;
        }
        // Update handoff
        this._ctrl.midNearHandoffEnd = Math.max(
            this._ctrl.midNearRange.start + this._ctrl.midNearOverlapNear + 1,
            this._ctrl.detailRange + 2
        );
    }

    // ═══════════════════════════════════════════════════════════════════
    // Rebuild
    // ═══════════════════════════════════════════════════════════════════

    _scheduleRebuild() {
        if (this._rebuildTimer) clearTimeout(this._rebuildTimer);
        this._statusEl.textContent = 'Pending rebuild...';
        this._statusEl.style.color = '#fa0';

        this._rebuildTimer = setTimeout(() => {
            this._doRebuild();
        }, this._rebuildDelay);
    }

    _applyAndRebuild() {
        if (this._rebuildTimer) clearTimeout(this._rebuildTimer);
        this._writeAll();
        this._doRebuild();
    }

    _doRebuild() {
        this._rebuildTimer = null;
        this._syncDerivedArrays();

        const needsGeom = this._needsGeometryRebuild;
        this._needsGeometryRebuild = false;

        const t0 = performance.now();
        try {
            this._rebuildCb?.({ rebuildGeometry: needsGeom });
            const ms = (performance.now() - t0).toFixed(1);
            this._statusEl.textContent = `Rebuilt in ${ms}ms${needsGeom ? ' (+ geometry)' : ''}`;
            this._statusEl.style.color = '#4f8';
            Logger.info(`[MidNearDebugPanel] Pipeline rebuild ${ms}ms, geometry=${needsGeom}`);
        } catch (e) {
            this._statusEl.textContent = `Rebuild FAILED: ${e.message}`;
            this._statusEl.style.color = '#f44';
            Logger.error(`[MidNearDebugPanel] Rebuild failed: ${e.message}`);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Reset / Export / Import
    // ═══════════════════════════════════════════════════════════════════

    _resetDefaults() {
        for (const [key, ctrl] of this._controls) {
            const d = ctrl.def.default;
            ctrl.input.value = d;
            ctrl.slider.value = d;
            if (this._ctrl) ctrl.def.set(this._ctrl, d);
        }
        this._needsGeometryRebuild = true;
        this._syncDerivedArrays();
        this._doRebuild();
    }

    _copyConfig() {
        if (!this._ctrl) return;
        const config = {};
        for (const [key, ctrl] of this._controls) {
            config[key] = parseFloat(ctrl.input.value);
        }
        const json = JSON.stringify(config, null, 2);
        navigator.clipboard.writeText(json).then(() => {
            this._statusEl.textContent = 'Config copied to clipboard';
            this._statusEl.style.color = '#8af';
        }).catch(() => {
            // Fallback: show in prompt
            prompt('Copy this config:', json);
        });
    }

    _pasteConfig() {
        const json = prompt('Paste config JSON:');
        if (!json) return;
        try {
            const config = JSON.parse(json);
            for (const [key, val] of Object.entries(config)) {
                const ctrl = this._controls.get(key);
                if (ctrl && Number.isFinite(val)) {
                    ctrl.input.value = val;
                    ctrl.slider.value = val;
                    if (this._ctrl) ctrl.def.set(this._ctrl, val);
                }
            }
            this._needsGeometryRebuild = true;
            this._syncDerivedArrays();
            this._doRebuild();
            this._statusEl.textContent = 'Config loaded from JSON';
            this._statusEl.style.color = '#8af';
        } catch (e) {
            this._statusEl.textContent = `JSON parse error: ${e.message}`;
            this._statusEl.style.color = '#f44';
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Visibility
    // ═══════════════════════════════════════════════════════════════════

    _toggle() {
        this._visible = !this._visible;
        this._container.style.display = this._visible ? 'block' : 'none';
        this._toggleBtn.style.borderColor = this._visible ? '#4f8' : '#0f0';
        if (this._visible) this._readAll();
    }

    dispose() {
        if (this._rebuildTimer) clearTimeout(this._rebuildTimer);
        this._container?.remove();
        this._toggleBtn?.remove();
        this._controls.clear();
        this._ctrl = null;
        this._rebuildCb = null;
    }
}