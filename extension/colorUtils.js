import GdkPixbuf from 'gi://GdkPixbuf';

export function hexToRgba(hex, alpha = 1.0) {
    let cleanHex = hex.replace('#', '');
    if (cleanHex.length === 3) {
        cleanHex = cleanHex.split('').map(c => c + c).join('');
    }
    const num = parseInt(cleanHex, 16);
    if (cleanHex.length === 8) {
        return [
            ((num >> 24) & 255) / 255,
            ((num >> 16) & 255) / 255,
            ((num >> 8) & 255) / 255,
            (num & 255) / 255,
        ];
    }
    return [
        ((num >> 16) & 255) / 255,
        ((num >> 8) & 255) / 255,
        (num & 255) / 255,
        alpha,
    ];
}

export function rgbToHls(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, l, 0];

    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = 0;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else if (max === b) h = (r - g) / d + 4;
    return [h / 6, l, s];
}

export function hlsToRgb(h, l, s) {
    if (s === 0) return [l, l, l];
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hue2rgb = (t) => {
        let val = t;
        if (val < 0) val += 1;
        if (val > 1) val -= 1;
        if (val < 1 / 6) return p + (q - p) * 6 * val;
        if (val < 1 / 2) return q;
        if (val < 2 / 3) return p + (q - p) * (2 / 3 - val) * 6;
        return p;
    };
    return [hue2rgb(h + 1 / 3), hue2rgb(h), hue2rgb(h - 1 / 3)];
}

export function extractWallpaperColor(path, cropRatio = null) {
    try {
        const pb = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 96, 96, false);
        if (!pb) return null;

        const w = pb.get_width();
        const h = pb.get_height();
        const rowstride = pb.get_rowstride();
        const nChannels = pb.get_n_channels();
        const pixels = pb.get_pixels();

        let x0 = 0, x1 = w;
        let y0 = Math.floor(h * 0.12);
        let y1 = Math.floor(h * 0.50);

        if (cropRatio && cropRatio.length === 4) {
            const [rL, rT, rR, rB] = cropRatio.map(Number);
            x0 = Math.max(0, Math.floor(w * rL));
            x1 = Math.min(w, Math.ceil(w * rR));
            const totalMonH = rB - rT;
            y0 = Math.max(0, Math.floor(h * (rT + totalMonH * 0.12)));
            y1 = Math.min(h, Math.ceil(h * (rT + totalMonH * 0.50)));
        }

        let totalLum = 0;
        let clockPixelCount = 0;

        for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
                const idx = y * rowstride + x * nChannels;
                const r = pixels[idx] / 255;
                const g = pixels[idx + 1] / 255;
                const b = pixels[idx + 2] / 255;
                totalLum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
                clockPixelCount++;
            }
        }
        const bgLum = clockPixelCount > 0 ? totalLum / clockPixelCount : 0.5;

        let bestScore = -1;
        let bestH = 0.6;
        let bestS = 0.3;

        for (let y = 0; y < h; y += 2) {
            for (let x = 0; x < w; x += 2) {
                const idx = y * rowstride + x * nChannels;
                const r = pixels[idx] / 255;
                const g = pixels[idx + 1] / 255;
                const b = pixels[idx + 2] / 255;
                const [hVal, lVal, sVal] = rgbToHls(r, g, b);
                if (lVal > 0.15 && lVal < 0.85 && sVal > 0.12) {
                    const score = sVal * (1.0 - Math.abs(lVal - 0.5) * 0.8);
                    if (score > bestScore) {
                        bestScore = score;
                        bestH = hVal;
                        bestS = sVal;
                    }
                }
            }
        }

        const isMonochrome = (bestScore < 0);
        let targetL, targetS;
        if (bgLum < 0.52) {
            targetL = 0.91;
            targetS = isMonochrome ? 0.05 : Math.min(0.42, Math.max(0.22, bestS * 0.75));
        } else {
            targetL = 0.18;
            targetS = isMonochrome ? 0.08 : Math.min(0.55, Math.max(0.28, bestS * 0.85));
        }

        const [fr, fg, fb] = hlsToRgb(bestH, targetL, targetS);
        const toHex = (n) => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, '0');
        return `#${toHex(fr)}${toHex(fg)}${toHex(fb)}`;
    } catch (e) {
        console.warn(`[DepthClock] Failed to extract wallpaper color: ${e}`);
        return null;
    }
}
