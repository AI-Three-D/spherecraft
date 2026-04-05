// js/shared/math/Color.js
// Linear-RGB color. Supports the constructor overloads new Color(),
// new Color(0xrrggbb), and new Color(r, g, b) with components in [0,1].
//
// Color space conventions:
//   - setHex / new Color(0xrrggbb) interprets the bytes as sRGB and
//     converts to linear-sRGB (the working color space) using the
//     IEC 61966-2-1 transfer function.
//   - setRGB / new Color(r, g, b) takes already-linear components.

function srgbToLinear(c) {
    return c < 0.04045
        ? c * (1 / 12.92)
        : Math.pow((c + 0.055) * (1 / 1.055), 2.4);
}

export class Color {
    constructor(rOrHex, g, b) {
        this.r = 1;
        this.g = 1;
        this.b = 1;
        this.isColor = true;

        if (rOrHex === undefined) {
            return;
        }
        if (g === undefined && b === undefined) {
            // single argument: hex int OR another Color
            if (typeof rOrHex === 'number') {
                this.setHex(rOrHex);
            } else if (rOrHex && rOrHex.isColor) {
                this.copy(rOrHex);
            }
        } else {
            this.setRGB(rOrHex, g, b);
        }
    }

    setHex(hex) {
        hex = Math.floor(hex);
        this.r = srgbToLinear(((hex >> 16) & 0xff) / 255);
        this.g = srgbToLinear(((hex >>  8) & 0xff) / 255);
        this.b = srgbToLinear(( hex        & 0xff) / 255);
        return this;
    }

    setRGB(r, g, b) {
        this.r = r;
        this.g = g;
        this.b = b;
        return this;
    }

    set(value) {
        if (value && value.isColor) {
            this.copy(value);
        } else if (typeof value === 'number') {
            this.setHex(value);
        }
        return this;
    }

    copy(c) {
        this.r = c.r;
        this.g = c.g;
        this.b = c.b;
        return this;
    }

    clone() {
        return new Color(this.r, this.g, this.b);
    }

    multiplyScalar(s) {
        this.r *= s;
        this.g *= s;
        this.b *= s;
        return this;
    }

    lerp(target, alpha) {
        this.r += (target.r - this.r) * alpha;
        this.g += (target.g - this.g) * alpha;
        this.b += (target.b - this.b) * alpha;
        return this;
    }
}
