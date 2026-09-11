import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import cairo from 'gi://cairo';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { extractWallpaperColor } from './colorUtils.js';

export class WallpaperManager {
    constructor(extensionPath, settings, bgSettings, interfaceSettings, callbacks = {}) {
        this._extensionPath = extensionPath;
        this._settings = settings;
        this._bgSettings = bgSettings;
        this._interfaceSettings = interfaceSettings;
        this._callbacks = callbacks;

        this._cutoutSurface = null;
        this._contourProfile = null;
        this._depthViable = true;
        this._lastProcessedHash = null;
        this._activeSubprocess = null;
        this._requestToken = 0;
        this._wallpaperTimerId = null;
    }

    get cutoutSurface() {
        return this._cutoutSurface;
    }

    get contourProfile() {
        return this._contourProfile;
    }

    get depthViable() {
        return this._depthViable;
    }

    scheduleUpdate() {
        if (this._wallpaperTimerId) {
            GLib.source_remove(this._wallpaperTimerId);
            this._wallpaperTimerId = null;
        }
        this._wallpaperTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            this._wallpaperTimerId = null;
            this.update();
            return GLib.SOURCE_REMOVE;
        });
    }

    _getWallpaperPath() {
        const colorScheme = this._interfaceSettings ? this._interfaceSettings.get_string('color-scheme') : 'default';
        const isDark = colorScheme === 'prefer-dark';

        let uri = null;
        if (isDark) {
            uri = this._bgSettings.get_string('picture-uri-dark');
            if (!uri || uri === '')
                uri = this._bgSettings.get_string('picture-uri');
        } else {
            uri = this._bgSettings.get_string('picture-uri');
            if (!uri || uri === '')
                uri = this._bgSettings.get_string('picture-uri-dark');
        }
        if (!uri) return null;

        if (uri.startsWith('file://')) {
            const [path] = GLib.filename_from_uri(uri);
            return path;
        }
        return uri;
    }

    _calculateCropRatio(wallpaperPath, monitor) {
        if (!wallpaperPath || !monitor) return null;

        let origW = 0, origH = 0;
        try {
            const [, w, h] = GdkPixbuf.Pixbuf.get_file_info(wallpaperPath);
            origW = w;
            origH = h;
        } catch (e) {
            return null;
        }

        if (origW <= 0 || origH <= 0) return null;

        const pictureOptions = this._bgSettings.get_string('picture-options');
        const isSpanned = pictureOptions === 'spanned' || wallpaperPath.includes('hydrapaper');

        if (isSpanned && Main.layoutManager.monitors.length > 1) {
            let minX = 0, minY = 0, maxX = 0, maxY = 0;
            for (const m of Main.layoutManager.monitors) {
                minX = Math.min(minX, m.x);
                minY = Math.min(minY, m.y);
                maxX = Math.max(maxX, m.x + m.width);
                maxY = Math.max(maxY, m.y + m.height);
            }
            const totalW = Math.max(1, maxX - minX);
            const totalH = Math.max(1, maxY - minY);

            const scale = Math.max(totalW / origW, totalH / origH);
            const destW = origW * scale;
            const destH = origH * scale;
            const canvasOffsetX = (totalW - destW) / 2;
            const canvasOffsetY = (totalH - destH) / 2;

            const x1 = (monitor.x - minX - canvasOffsetX) / scale;
            const y1 = (monitor.y - minY - canvasOffsetY) / scale;
            const x2 = (monitor.x - minX + monitor.width - canvasOffsetX) / scale;
            const y2 = (monitor.y - minY + monitor.height - canvasOffsetY) / scale;

            const rLeft = Math.max(0, Math.min(1, x1 / origW));
            const rTop = Math.max(0, Math.min(1, y1 / origH));
            const rRight = Math.max(0, Math.min(1, x2 / origW));
            const rBottom = Math.max(0, Math.min(1, y2 / origH));

            return [rLeft.toFixed(6), rTop.toFixed(6), rRight.toFixed(6), rBottom.toFixed(6)];
        }

        const scale = Math.max(monitor.width / origW, monitor.height / origH);
        const destW = origW * scale;
        const destH = origH * scale;
        const offsetX = (monitor.width - destW) / 2;
        const offsetY = (monitor.height - destH) / 2;

        const x1 = -offsetX / scale;
        const y1 = -offsetY / scale;
        const x2 = x1 + monitor.width / scale;
        const y2 = y1 + monitor.height / scale;

        const rLeft = Math.max(0, Math.min(1, x1 / origW));
        const rTop = Math.max(0, Math.min(1, y1 / origH));
        const rRight = Math.max(0, Math.min(1, x2 / origW));
        const rBottom = Math.max(0, Math.min(1, y2 / origH));

        return [rLeft.toFixed(6), rTop.toFixed(6), rRight.toFixed(6), rBottom.toFixed(6)];
    }

    updateAutoColor() {
        const wallpaperPath = this._getWallpaperPath();
        if (!wallpaperPath || !GLib.file_test(wallpaperPath, GLib.FileTest.EXISTS))
            return;

        const monitor = Main.layoutManager.primaryMonitor || Main.layoutManager.monitors[0];
        if (!monitor) return;

        const cropRatio = this._calculateCropRatio(wallpaperPath, monitor);
        const autoColor = extractWallpaperColor(wallpaperPath, cropRatio);
        if (autoColor && autoColor !== this._settings.get_string('clock-color'))
            this._settings.set_string('clock-color', autoColor);
    }

    update(force = false) {
        const wallpaperPath = this._getWallpaperPath();
        if (!wallpaperPath || !GLib.file_test(wallpaperPath, GLib.FileTest.EXISTS))
            return;

        const monitor = Main.layoutManager.primaryMonitor || Main.layoutManager.monitors[0];
        if (!monitor) return;

        const cropRatio = this._calculateCropRatio(wallpaperPath, monitor);

        if (this._settings.get_boolean('auto-color'))
            this.updateAutoColor();

        const file = Gio.File.new_for_path(wallpaperPath);
        let mtime = 0;
        try {
            const info = file.query_info(Gio.FILE_ATTRIBUTE_TIME_MODIFIED, Gio.FileQueryInfoFlags.NONE, null);
            mtime = info.get_attribute_uint64(Gio.FILE_ATTRIBUTE_TIME_MODIFIED);
        } catch (e) {
            mtime = Date.now();
        }

        const cropStr = cropRatio ? cropRatio.join('_') : 'full';
        const rawKey = `${wallpaperPath}:${mtime}:${cropStr}:${monitor.width}x${monitor.height}`;
        const checksum = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, rawKey, -1);

        if (!force && checksum === this._lastProcessedHash) return;
        this._lastProcessedHash = checksum;

        const cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'depth-clock']);
        GLib.mkdir_with_parents(cacheDir, 0o755);
        this._pruneCache(cacheDir, 8);
        const cacheFile = GLib.build_filenamev([cacheDir, `${checksum}.png`]);

        if (GLib.file_test(cacheFile, GLib.FileTest.EXISTS)) {
            this._loadCutout(cacheFile);
        } else {
            this._clearCutout();
            this._generateCutoutAsync(wallpaperPath, cacheFile, cropRatio);
        }
    }

    _clearCutout() {
        if (this._cutoutSurface) {
            try {
                this._cutoutSurface.finish();
            } catch (e) {}
            this._cutoutSurface = null;
        }
        if (this._callbacks.onCutoutCleared)
            this._callbacks.onCutoutCleared();
    }

    _loadCutout(cutoutPath) {
        this._clearCutout();

        try {
            this._cutoutSurface = cairo.ImageSurface.createFromPNG(cutoutPath);
        } catch (e) {
            console.error(`[DepthClock] Failed to load cutout surface: ${e}`);
            this._cutoutSurface = null;
        }

        const metaPath = cutoutPath.replace(/\.png$/, '.json');
        let contourLoaded = false;
        if (GLib.file_test(metaPath, GLib.FileTest.EXISTS)) {
            try {
                const [ok, bytes] = GLib.file_get_contents(metaPath);
                if (ok) {
                    const meta = JSON.parse(new TextDecoder().decode(bytes));
                    if (this._settings.get_boolean('auto-color') && meta.suggested_color) {
                        if (meta.suggested_color !== this._settings.get_string('clock-color'))
                            this._settings.set_string('clock-color', meta.suggested_color);
                    }
                    if (this._settings.get_boolean('auto-adapt') && meta.depth_viable !== undefined) {
                        this._depthViable = meta.depth_viable;
                    }
                    if (Array.isArray(meta.contour_samples) && meta.contour_samples.length > 0) {
                        this._contourProfile = meta.contour_samples;
                        contourLoaded = true;
                    }
                }
            } catch (e) {
                console.warn(`[DepthClock] Failed to read cutout meta: ${e}`);
            }
        }

        if (!contourLoaded && GLib.file_test(cutoutPath, GLib.FileTest.EXISTS)) {
            this._contourProfile = this._extractContourFromCutout(cutoutPath);
        }

        if (this._callbacks.onCutoutUpdated)
            this._callbacks.onCutoutUpdated(this._cutoutSurface, this._contourProfile);
    }

    _extractContourFromCutout(pngPath) {
        try {
            const pb = GdkPixbuf.Pixbuf.new_from_file_at_scale(pngPath, 256, 256, false);
            if (!pb) return null;
            const w = pb.get_width();
            const h = pb.get_height();
            const rowstride = pb.get_rowstride();
            const nChannels = pb.get_n_channels();
            const pixels = pb.get_pixels();

            const rawSamples = [];
            for (let x = 0; x < w; x++) {
                let firstY = h;
                for (let y = 0; y < h - 1; y++) {
                    const idx = y * rowstride + x * nChannels;
                    const idxNext = (y + 1) * rowstride + x * nChannels;
                    const a1 = nChannels === 4 ? pixels[idx + 3] : 0;
                    const a2 = nChannels === 4 ? pixels[idxNext + 3] : 0;
                    if (a1 > 96 && a2 > 96) {
                        firstY = y;
                        break;
                    }
                }
                rawSamples.push(firstY / h);
            }

            const samples = [];
            for (let i = 0; i < rawSamples.length; i++) {
                const prev = i > 0 ? rawSamples[i - 1] : rawSamples[i];
                const curr = rawSamples[i];
                const next = i < rawSamples.length - 1 ? rawSamples[i + 1] : rawSamples[i];
                const avg = 0.25 * prev + 0.5 * curr + 0.25 * next;
                samples.push(Math.round(avg * 1000) / 1000);
            }

            const metaPath = pngPath.replace(/\.png$/, '.json');
            if (GLib.file_test(metaPath, GLib.FileTest.EXISTS)) {
                try {
                    const [ok, bytes] = GLib.file_get_contents(metaPath);
                    if (ok) {
                        const meta = JSON.parse(new TextDecoder().decode(bytes));
                        meta.contour_samples = samples;
                        GLib.file_set_contents(metaPath, JSON.stringify(meta, null, 2));
                    }
                } catch (e) {}
            }
            return samples;
        } catch (e) {
            console.warn(`[DepthClock] Failed to extract contour from cutout: ${e}`);
            return null;
        }
    }

    _pruneCache(cacheDir, maxEntries = 8) {
        try {
            const dir = Gio.File.new_for_path(cacheDir);
            if (!dir.query_exists(null)) return;

            const enumerator = dir.enumerate_children(
                'standard::name,time::modified',
                Gio.FileQueryInfoFlags.NONE,
                null
            );
            const files = [];
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                const name = info.get_name();
                const mtime = info.get_attribute_uint64('time::modified');
                files.push({ name, mtime });
            }

            const maxFiles = maxEntries * 2;
            if (files.length <= maxFiles) return;

            files.sort((a, b) => b.mtime - a.mtime);
            for (let i = maxFiles; i < files.length; i++) {
                const child = dir.get_child(files[i].name);
                try {
                    child.delete(null);
                } catch (e) {}
            }
        } catch (e) {
            console.warn(`[DepthClock] Failed to prune cache: ${e}`);
        }
    }

    _generateCutoutAsync(wallpaperPath, outputPng, cropRatio) {
        const pythonBin = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'share', 'depth-clock', 'venv', 'bin', 'python3']);
        const modelPath = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'share', 'depth-clock', 'models', 'rmbg-1.4.onnx']);
        let scriptPath = GLib.build_filenamev([this._extensionPath, 'backend', 'segment.py']);
        if (!GLib.file_test(scriptPath, GLib.FileTest.EXISTS))
            scriptPath = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'share', 'depth-clock', 'backend', 'segment.py']);

        if (!GLib.file_test(pythonBin, GLib.FileTest.EXISTS) ||
            !GLib.file_test(scriptPath, GLib.FileTest.EXISTS) ||
            !GLib.file_test(modelPath, GLib.FileTest.EXISTS)) {
            return;
        }

        if (this._activeSubprocess) {
            try {
                this._activeSubprocess.force_exit();
            } catch (e) {}
            this._activeSubprocess = null;
        }

        const token = ++this._requestToken;
        const argv = [pythonBin, scriptPath, wallpaperPath, outputPng];
        if (cropRatio) {
            argv.push('--crop-ratio');
            argv.push(...cropRatio);
        }

        try {
            const proc = Gio.Subprocess.new(
                argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            this._activeSubprocess = proc;

            proc.communicate_utf8_async(null, null, (source, res) => {
                try {
                    const [, stdout, stderr] = source.communicate_utf8_finish(res);
                    if (token !== this._requestToken)
                        return;

                    if (source.get_successful()) {
                        this._loadCutout(outputPng);
                    } else {
                        console.warn(`[DepthClock] Worker exited with code ${source.get_exit_status()}: ${stderr || stdout}`);
                    }
                } catch (err) {
                    console.error(`[DepthClock] Subprocess error: ${err}`);
                } finally {
                    if (this._activeSubprocess === proc)
                        this._activeSubprocess = null;
                }
            });
        } catch (e) {
            console.error(`[DepthClock] Failed to launch segmenter: ${e}`);
        }
    }

    destroy() {
        if (this._wallpaperTimerId) {
            GLib.source_remove(this._wallpaperTimerId);
            this._wallpaperTimerId = null;
        }
        if (this._activeSubprocess) {
            try {
                this._activeSubprocess.force_exit();
            } catch (e) {}
            this._activeSubprocess = null;
        }
        if (this._cutoutSurface) {
            try {
                this._cutoutSurface.finish();
            } catch (e) {}
            this._cutoutSurface = null;
        }
        this._contourProfile = null;
        this._callbacks = {};
    }
}
