// A local, bounded streamline adjustment around a round obstacle. Coordinates
// are along/across the current; no modification remains beyond four radii.
// The flow separates ahead of a rock and turns back toward its wake behind it.
export function rockFlowDeflection(along, across, radius, strength = 1) {
    const r = Math.max(radius, 0.01), d2 = along * along + across * across, d = Math.sqrt(d2);
    if (d >= 4 * r || strength <= 0) return { along: 1, across: 0, weight: 0 };
    const t = Math.max(0, Math.min(1, (d / r - 2) / 2)), fade = 1 - t * t * (3 - 2 * t);
    const den = Math.max(d2, r * r), k = Math.min(0.9, strength * fade * r * r / den);
    const x = along / Math.sqrt(den), y = across / Math.sqrt(den);
    return { along: 1 - k * (x * x - y * y), across: -2 * k * x * y, weight: k };
}
