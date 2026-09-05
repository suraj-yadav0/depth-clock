import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Pango from 'gi://Pango';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import cairo from 'gi://cairo';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const ClockWidget = GObject.registerClass(
    class ClockWidget extends St.BoxLayout {
        _init(settings, getMonitorBounds) {
            super._init({
                vertical: true,
                reactive: true,
                track_hover: true,
                style_class: 'depth-clock-widget',
            });

            this._settings = settings;
            this._getMonitorBounds = getMonitorBounds;
            this._isDragging = false;
            this._isSavingPosition = false;
            this._grab = null;
            this._dragStartX = 0;
            this._dragStartY = 0;
            this._dragActorStartX = 0;
            this._dragActorStartY = 0;
            this._scrollTimerId = null;
            this._currentScale = null;

            // Date label
            this._dateLabel = new St.Label({
                text: '',
                style_class: 'depth-clock-date',
                x_align: Clutter.ActorAlign.CENTER,
            });
            this._dateLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            this.add_child(this._dateLabel);

            // Time label
            this._timeLabel = new St.Label({
                text: '',
                style_class: 'depth-clock-time',
                x_align: Clutter.ActorAlign.CENTER,
            });
            this._timeLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            this.add_child(this._timeLabel);

            // Re-center whenever actor bounds or layout change
            this.connect('notify::allocation', () => {
                if (!this._isDragging && !this._isSavingPosition)
                    this._applyPosition();
            });

            // Drag positioning
            this.connect('button-press-event', (_actor, event) => {
                if (event.get_button() === 1) {
                    this._isDragging = true;
                    try {
                        this._grab = global.stage.grab(this);
                    } catch (e) {
                        this._grab = null;
                    }
                    const [stageX, stageY] = event.get_coords();
                    this._dragStartX = stageX;
                    this._dragStartY = stageY;
                    this._dragActorStartX = this.x;
                    this._dragActorStartY = this.y;
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });

            this.connect('motion-event', (_actor, event) => {
                if (this._isDragging) {
                    const [stageX, stageY] = event.get_coords();
                    const dx = stageX - this._dragStartX;
                    const dy = stageY - this._dragStartY;
                    this.set_position(
                        this._dragActorStartX + dx,
                        this._dragActorStartY + dy
                    );
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });

            this.connect('button-release-event', (_actor, event) => {
                if (event.get_button() === 1 && this._isDragging) {
                    if (this._grab) {
                        this._grab.dismiss();
                        this._grab = null;
                    }
                    this._isDragging = false;
                    this._savePosition();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });

            // Responsive scroll-to-resize
            this.connect('scroll-event', (_actor, event) => {
                const dir = event.get_scroll_direction();
                let delta = 0;
                if (dir === Clutter.ScrollDirection.UP) {
                    delta = 1;
                } else if (dir === Clutter.ScrollDirection.DOWN) {
                    delta = -1;
                } else if (dir === Clutter.ScrollDirection.SMOOTH) {
                    const [, dy] = event.get_scroll_delta();
                    if (Math.abs(dy) > 0.001)
                        delta = -dy;
                }

                if (delta === 0)
                    return Clutter.EVENT_PROPAGATE;

                let currentScale = this._currentScale ?? this._settings.get_double('clock-scale');
                const step = (dir === Clutter.ScrollDirection.SMOOTH)
                    ? delta * 0.35
                    : (delta > 0 ? 0.25 : -0.25);

                let newScale = Math.max(0.3, Math.min(3.5, Math.round((currentScale + step) * 100) / 100));

                if (newScale === currentScale)
                    return Clutter.EVENT_STOP;

                this._currentScale = newScale;
                this._applyStyles(newScale);

                // Debounce write to dconf
                if (this._scrollTimerId !== null) {
                    GLib.source_remove(this._scrollTimerId);
                    this._scrollTimerId = null;
                }
                this._scrollTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                    this._settings.set_double('clock-scale', this._currentScale);
                    this._scrollTimerId = null;
                    return GLib.SOURCE_REMOVE;
                });
                return Clutter.EVENT_STOP;
            });

            this._settingsId = this._settings.connect('changed', (_s, key) => {
                if (this._isSavingPosition) return;
                if (key === 'clock-x' || key === 'clock-y') {
                    if (!this._isDragging)
                        this._applyPosition();
                } else if (key === 'clock-scale' || key === 'clock-font' || key === 'clock-color' || key === 'clock-opacity' || key === 'stack-digits') {
                    this._currentScale = this._settings.get_double('clock-scale');
                    this._applyStyles();
                } else if (key === 'time-format-24h' || key === 'show-date') {
                    this._updateClock();
                }
            });

            this._currentScale = this._settings.get_double('clock-scale');
            this._applyStyles();
            this._applyPosition();
            this._updateClock();

            this._tickerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                this._updateClock();
                return GLib.SOURCE_CONTINUE;
            });
        }

        _applyStyles(overrideScale = null) {
            const scale = overrideScale !== null ? overrideScale : this._settings.get_double('clock-scale');
            const font = this._settings.get_string('clock-font');
            const color = this._settings.get_string('clock-color');
            const opacity = Math.round(this._settings.get_double('clock-opacity') * 255);
            const isStacked = this._settings.get_boolean('stack-digits');

            const baseFontSize = isStacked ? 190 : 250;
            const fontSize = Math.round(baseFontSize * scale);
            const dateSize = Math.round(24 * scale);

            const fontDesc = Pango.FontDescription.from_string(font);
            const fontFamily = fontDesc.get_family() || font;
            const fontWeight = fontDesc.get_weight();
            const weightCss = fontWeight && fontWeight !== Pango.Weight.NORMAL
                ? `font-weight: ${fontWeight};`
                : 'font-weight: 700;';
            const styleCss = fontDesc.get_style() !== Pango.Style.NORMAL
                ? 'font-style: italic;'
                : '';

            this._timeLabel.set_style(
                `font-family: '${fontFamily}', sans-serif; ${weightCss} ${styleCss} font-size: ${fontSize}px; color: ${color}; line-height: ${isStacked ? 0.82 : 0.9};`
            );
            this._dateLabel.set_style(
                `font-size: ${dateSize}px; color: ${color}; opacity: 0.9;`
            );
            this.set_opacity(opacity);
        }

        _applyPosition() {
            const bounds = this._getMonitorBounds();
            if (!bounds || bounds.width === 0 || bounds.height === 0) return;

            const rx = this._settings.get_double('clock-x');
            const ry = this._settings.get_double('clock-y');

            const targetX = Math.round(bounds.width * rx - this.width / 2);
            const targetY = Math.round(bounds.height * ry - this.height / 2);

            this.set_position(targetX, targetY);
        }

        _savePosition() {
            const bounds = this._getMonitorBounds();
            if (!bounds || bounds.width === 0 || bounds.height === 0) return;

            const centerX = this.x + this.width / 2;
            const centerY = this.y + this.height / 2;

            const rx = Math.max(-0.2, Math.min(1.2, centerX / bounds.width));
            const ry = Math.max(-0.2, Math.min(1.2, centerY / bounds.height));

            this._isSavingPosition = true;
            this._settings.set_double('clock-x', Math.round(rx * 1000) / 1000);
            this._settings.set_double('clock-y', Math.round(ry * 1000) / 1000);
            this._isSavingPosition = false;
        }

        _updateClock() {
            const now = GLib.DateTime.new_now_local();
            const showDate = this._settings.get_boolean('show-date');
            const is24h = this._settings.get_boolean('time-format-24h');
            const isStacked = this._settings.get_boolean('stack-digits');

            if (showDate) {
                const dayStr = DAYS[now.get_day_of_week() % 7];
                const monthStr = MONTHS[now.get_month() - 1];
                const dayNum = now.get_day_of_month();
                this._dateLabel.set_text(`${dayNum} ${monthStr} ${dayStr}`);
                this._dateLabel.show();
            } else {
                this._dateLabel.hide();
            }

            let hour = now.get_hour();
            const min = now.get_minute();
            if (!is24h)
                hour = hour % 12 || 12;

            const hh = hour < 10 ? `0${hour}` : `${hour}`;
            const mm = min < 10 ? `0${min}` : `${min}`;

            if (isStacked)
                this._timeLabel.set_text(`${hh}\n${mm}`);
            else
                this._timeLabel.set_text(`${hh}${mm}`);
        }

        destroy() {
            if (this._grab) {
                this._grab.dismiss();
                this._grab = null;
            }
            if (this._tickerId) {
                GLib.source_remove(this._tickerId);
                this._tickerId = null;
            }
            if (this._scrollTimerId) {
                GLib.source_remove(this._scrollTimerId);
                this._scrollTimerId = null;
            }
            if (this._settingsId) {
                this._settings.disconnect(this._settingsId);
                this._settingsId = null;
            }
            super.destroy();
        }
    }
);

export default class DepthClockExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._bgSettings = new Gio.Settings({ schema: 'org.gnome.desktop.background' });
        this._interfaceSettings = new Gio.Settings({ schema: 'org.gnome.desktop.interface' });

        this._container = null;
        this._clockWidget = null;
        this._cutoutArea = null;
        this._cutoutSurface = null;
        this._activeSubprocess = null;
        this._lastProcessedHash = null;
        this._requestToken = 0;
        this._wallpaperTimerId = null;

        this._setupActors();

        this._bgChangeId1 = this._bgSettings.connect('changed::picture-uri', () => this._scheduleWallpaperUpdate());
        this._bgChangeId2 = this._bgSettings.connect('changed::picture-uri-dark', () => this._scheduleWallpaperUpdate());
        this._bgChangeId3 = this._bgSettings.connect('changed::picture-options', () => this._scheduleWallpaperUpdate());
        this._interfaceChangeId = this._interfaceSettings.connect('changed::color-scheme', () => this._scheduleWallpaperUpdate());

        this._settingsDepthId = this._settings.connect('changed::enable-depth', () => {
            if (this._cutoutArea)
                this._cutoutArea.queue_repaint();
        });

        this._settingsAutoColorId = this._settings.connect('changed::auto-color', () => {
            if (this._settings.get_boolean('auto-color'))
                this._updateAutoColor();
        });

        this._settingsAutoAdaptId = this._settings.connect('changed::auto-adapt', () => {
            if (this._cutoutArea)
                this._cutoutArea.queue_repaint();
        });

        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => {
            this._relayout();
            this._scheduleWallpaperUpdate();
        });

        // Trigger initial wallpaper processing
        this._onWallpaperChanged();
    }

    _scheduleWallpaperUpdate() {
        if (this._wallpaperTimerId) {
            GLib.source_remove(this._wallpaperTimerId);
            this._wallpaperTimerId = null;
        }
        this._wallpaperTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            this._wallpaperTimerId = null;
            this._onWallpaperChanged();
            return GLib.SOURCE_REMOVE;
        });
    }

    _getPrimaryMonitor() {
        return Main.layoutManager.primaryMonitor || Main.layoutManager.monitors[0];
    }

    _setupActors() {
        const monitor = this._getPrimaryMonitor();
        if (!monitor) return;

        this._container = new Clutter.Actor({
            reactive: false,
        });
        this._container.set_position(monitor.x, monitor.y);
        this._container.set_size(monitor.width, monitor.height);

        // Child 0: Clock Widget
        this._clockWidget = new ClockWidget(this._settings, () => {
            const m = this._getPrimaryMonitor();
            return m ? { width: m.width, height: m.height } : null;
        });
        this._container.add_child(this._clockWidget);

        // Child 1: Foreground Cutout Area
        this._cutoutArea = new St.DrawingArea({
            reactive: false,
            can_focus: false,
        });
        this._cutoutArea.set_position(0, 0);
        this._cutoutArea.set_size(monitor.width, monitor.height);

        this._cutoutArea.connect('repaint', (area) => {
            const cr = area.get_context();
            cr.setOperator(cairo.Operator.CLEAR);
            cr.paint();

            const depthEnabled = this._settings.get_boolean('enable-depth');
            const autoAdapt = this._settings.get_boolean('auto-adapt');
            const depthViable = autoAdapt && this._depthViable !== undefined ? this._depthViable : true;
            if (depthEnabled && depthViable && this._cutoutSurface) {
                cr.setOperator(cairo.Operator.OVER);
                const sw = this._cutoutSurface.getWidth();
                const sh = this._cutoutSurface.getHeight();
                if (sw > 0 && sh > 0) {
                    cr.scale(area.width / sw, area.height / sh);
                    cr.setSourceSurface(this._cutoutSurface, 0, 0);
                    cr.paint();
                }
            }
            cr.$dispose();
        });

        this._container.add_child(this._cutoutArea);

        // Insert into background group
        this._bgGroup = Main.layoutManager._backgroundGroup;
        if (this._bgGroup) {
            this._bgGroup.add_child(this._container);
            if (this._bgGroup.set_child_above_sibling)
                this._bgGroup.set_child_above_sibling(this._container, null);
        } else {
            Main.layoutManager.addChrome(this._container);
        }

        // Adjust position once child sizes are laid out
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (this._clockWidget)
                this._clockWidget._applyPosition();
            return GLib.SOURCE_REMOVE;
        });
    }

    _relayout() {
        const monitor = this._getPrimaryMonitor();
        if (!monitor || !this._container) return;

        this._container.set_position(monitor.x, monitor.y);
        this._container.set_size(monitor.width, monitor.height);

        if (this._cutoutArea)
            this._cutoutArea.set_size(monitor.width, monitor.height);

        if (this._clockWidget)
            this._clockWidget._applyPosition();
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

    _onWallpaperChanged() {
        const wallpaperPath = this._getWallpaperPath();
        if (!wallpaperPath || !GLib.file_test(wallpaperPath, GLib.FileTest.EXISTS))
            return;

        const monitor = this._getPrimaryMonitor();
        if (!monitor) return;

        // Calculate crop ratios if spanned or multi-monitor hydrapaper
        const pictureOptions = this._bgSettings.get_string('picture-options');
        const isSpanned = pictureOptions === 'spanned' || wallpaperPath.includes('hydrapaper');
        let cropRatio = null;

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

            const rLeft = (monitor.x - minX) / totalW;
            const rTop = (monitor.y - minY) / totalH;
            const rRight = (monitor.x - minX + monitor.width) / totalW;
            const rBottom = (monitor.y - minY + monitor.height) / totalH;

            cropRatio = [rLeft.toFixed(4), rTop.toFixed(4), rRight.toFixed(4), rBottom.toFixed(4)];
        }

        if (this._settings.get_boolean('auto-color'))
            this._updateAutoColor();

        // Cache key calculation
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

        if (checksum === this._lastProcessedHash) return;
        this._lastProcessedHash = checksum;

        const cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'depth-clock']);
        GLib.mkdir_with_parents(cacheDir, 0o755);
        const cacheFile = GLib.build_filenamev([cacheDir, `${checksum}.png`]);

        if (GLib.file_test(cacheFile, GLib.FileTest.EXISTS)) {
            this._loadCutout(cacheFile);
        } else {
            this._cutoutSurface = null;
            if (this._cutoutArea)
                this._cutoutArea.queue_repaint();
            this._generateCutoutAsync(wallpaperPath, cacheFile, cropRatio);
        }
    }

    _loadCutout(cutoutPath) {
        try {
            this._cutoutSurface = cairo.ImageSurface.createFromPNG(cutoutPath);
            if (this._cutoutArea)
                this._cutoutArea.queue_repaint();
            console.log(`[DepthClock] Loaded cutout from ${cutoutPath}`);
        } catch (e) {
            console.error(`[DepthClock] Failed to load cutout surface: ${e}`);
            this._cutoutSurface = null;
        }

        const metaPath = cutoutPath.replace(/\.png$/, '.json');
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
                        if (this._cutoutArea)
                            this._cutoutArea.queue_repaint();
                    }
                }
            } catch (e) {
                console.warn(`[DepthClock] Failed to read cutout meta: ${e}`);
            }
        }
    }

    _updateAutoColor() {
        const wallpaperPath = this._getWallpaperPath();
        if (!wallpaperPath || !GLib.file_test(wallpaperPath, GLib.FileTest.EXISTS))
            return;

        const monitor = this._getPrimaryMonitor();
        if (!monitor) return;

        const pictureOptions = this._bgSettings.get_string('picture-options');
        const isSpanned = pictureOptions === 'spanned' || wallpaperPath.includes('hydrapaper');
        let cropRatio = null;

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
            cropRatio = [
                ((monitor.x - minX) / totalW).toFixed(4),
                ((monitor.y - minY) / totalH).toFixed(4),
                ((monitor.x - minX + monitor.width) / totalW).toFixed(4),
                ((monitor.y - minY + monitor.height) / totalH).toFixed(4),
            ];
        }

        const autoColor = this._extractWallpaperColor(wallpaperPath, cropRatio);
        if (autoColor && autoColor !== this._settings.get_string('clock-color'))
            this._settings.set_string('clock-color', autoColor);
    }

    _rgbToHls(r, g, b) {
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

    _hlsToRgb(h, l, s) {
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

    _extractWallpaperColor(path, cropRatio = null) {
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
                    const [hVal, lVal, sVal] = this._rgbToHls(r, g, b);
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

            const [fr, fg, fb] = this._hlsToRgb(bestH, targetL, targetS);
            const toHex = (n) => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, '0');
            return `#${toHex(fr)}${toHex(fg)}${toHex(fb)}`;
        } catch (e) {
            console.warn(`[DepthClock] Failed to extract wallpaper color: ${e}`);
            return null;
        }
    }

    _generateCutoutAsync(wallpaperPath, outputPng, cropRatio) {
        const pythonBin = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'share', 'depth-clock', 'venv', 'bin', 'python3']);
        const scriptPath = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'share', 'depth-clock', 'backend', 'segment.py']);

        if (!GLib.file_test(pythonBin, GLib.FileTest.EXISTS) || !GLib.file_test(scriptPath, GLib.FileTest.EXISTS)) {
            console.warn('[DepthClock] Python worker or segment script missing');
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

            proc.wait_async(null, (source, res) => {
                try {
                    source.wait_finish(res);
                    if (token !== this._requestToken)
                        return;

                    if (source.get_successful()) {
                        this._loadCutout(outputPng);
                    } else {
                        console.warn(`[DepthClock] Worker exited with code ${source.get_exit_status()}`);
                    }
                } catch (err) {
                    console.error(`[DepthClock] Subprocess wait error: ${err}`);
                }
            });
        } catch (e) {
            console.error(`[DepthClock] Failed to launch segmenter: ${e}`);
        }
    }

    disable() {
        if (this._wallpaperTimerId) {
            GLib.source_remove(this._wallpaperTimerId);
            this._wallpaperTimerId = null;
        }
        if (this._bgChangeId1) this._bgSettings.disconnect(this._bgChangeId1);
        if (this._bgChangeId2) this._bgSettings.disconnect(this._bgChangeId2);
        if (this._bgChangeId3) this._bgSettings.disconnect(this._bgChangeId3);
        if (this._interfaceChangeId) this._interfaceSettings.disconnect(this._interfaceChangeId);
        if (this._settingsDepthId) this._settings.disconnect(this._settingsDepthId);
        if (this._settingsAutoColorId) this._settings.disconnect(this._settingsAutoColorId);
        if (this._settingsAutoAdaptId) this._settings.disconnect(this._settingsAutoAdaptId);
        if (this._monitorsId) Main.layoutManager.disconnect(this._monitorsId);

        if (this._activeSubprocess) {
            try {
                this._activeSubprocess.force_exit();
            } catch (e) { }
            this._activeSubprocess = null;
        }

        if (this._clockWidget) {
            this._clockWidget.destroy();
            this._clockWidget = null;
        }

        if (this._cutoutArea) {
            this._cutoutArea.destroy();
            this._cutoutArea = null;
        }

        if (this._container) {
            if (this._bgGroup)
                this._bgGroup.remove_child(this._container);
            else
                Main.layoutManager.removeChrome(this._container);
            this._container.destroy();
            this._container = null;
        }

        this._cutoutSurface = null;
        this._bgGroup = null;
        this._settings = null;
        this._bgSettings = null;
        this._interfaceSettings = null;
    }
}
