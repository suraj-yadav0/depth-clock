import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import cairo from 'gi://cairo';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { hexToRgba } from './colorUtils.js';
import { ClockWidget } from './clockWidget.js';
import { WallpaperManager } from './wallpaperManager.js';

export default class DepthClockExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._bgSettings = new Gio.Settings({ schema: 'org.gnome.desktop.background' });
        this._interfaceSettings = new Gio.Settings({ schema: 'org.gnome.desktop.interface' });

        this._container = null;
        this._clockWidget = null;
        this._glowArea = null;
        this._cutoutArea = null;
        this._overlayArea = null;
        this._cachedCutoutPattern = null;
        this._layoutIdleId = null;
        this._stageMotionId = null;
        this._parallaxIdleId = null;
        this._lastParallaxX = 0;
        this._lastParallaxY = 0;
        this._pendingPointerX = 0;
        this._pendingPointerY = 0;

        this._wallpaperManager = new WallpaperManager(
            this.path,
            this._settings,
            this._bgSettings,
            this._interfaceSettings,
            {
                onCutoutUpdated: (_surface, contour) => {
                    this._cachedCutoutPattern = null;
                    if (this._clockWidget)
                        this._clockWidget.updateContourData(contour);
                    this._updateAreaVisibilities();
                },
                onCutoutCleared: () => {
                    this._cachedCutoutPattern = null;
                    this._updateAreaVisibilities();
                },
            }
        );

        this._setupActors();

        this._bgChangeId1 = this._bgSettings.connect('changed::picture-uri', () => this._wallpaperManager.scheduleUpdate());
        this._bgChangeId2 = this._bgSettings.connect('changed::picture-uri-dark', () => this._wallpaperManager.scheduleUpdate());
        this._bgChangeId3 = this._bgSettings.connect('changed::picture-options', () => this._wallpaperManager.scheduleUpdate());
        this._interfaceChangeId = this._interfaceSettings.connect('changed::color-scheme', () => this._wallpaperManager.scheduleUpdate());

        this._settingsDepthId = this._settings.connect('changed::enable-depth', () => {
            this._updateAreaVisibilities();
        });

        this._settingsContourId = this._settings.connect('changed::contour-mode', () => {
            if (this._clockWidget)
                this._clockWidget.updateMode();
            this._updateAreaVisibilities();
        });

        this._settingsModeId = this._settings.connect('changed::clock-mode', () => {
            if (this._clockWidget)
                this._clockWidget.updateMode();
            this._updateParallaxState();
            this._updateAreaVisibilities();
        });

        this._settingsDualToneId = this._settings.connect('changed::dual-tone', () => {
            if (this._clockWidget)
                this._clockWidget.updateContourData();
        });

        this._settingsContourClearanceId = this._settings.connect('changed::contour-clearance', () => {
            if (this._clockWidget)
                this._clockWidget.updateContourData();
        });

        this._settingsContourStyleId = this._settings.connect('changed::contour-style', () => {
            if (this._clockWidget)
                this._clockWidget.updateContourData();
        });

        this._settingsInvertStyleId = this._settings.connect('changed::invert-style', () => {
            this._cachedCutoutPattern = null;
            if (this._overlayArea && this._overlayArea.visible)
                this._overlayArea.queue_repaint();
        });

        this._settingsParallaxIntensityId = this._settings.connect('changed::parallax-intensity', () => {
            this._applyParallax();
        });

        this._settingsGlowColorId = this._settings.connect('changed::glow-color', () => {
            if (this._glowArea && this._glowArea.visible)
                this._glowArea.queue_repaint();
        });

        this._settingsGlowRadiusId = this._settings.connect('changed::glow-radius', () => {
            if (this._glowArea && this._glowArea.visible)
                this._glowArea.queue_repaint();
        });

        this._settingsGlowIntensityId = this._settings.connect('changed::glow-intensity', () => {
            if (this._glowArea && this._glowArea.visible)
                this._glowArea.queue_repaint();
        });

        this._settingsFlowClearanceId = this._settings.connect('changed::flow-clearance', () => {
            if (this._clockWidget)
                this._clockWidget.updateContourData();
        });

        this._settingsAutoColorId = this._settings.connect('changed::auto-color', () => {
            if (this._settings.get_boolean('auto-color'))
                this._wallpaperManager.updateAutoColor();
        });

        this._settingsAutoAdaptId = this._settings.connect('changed::auto-adapt', () => {
            this._updateAreaVisibilities();
        });

        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => this._onMonitorsChanged());

        this._wallpaperManager.update();
        this._updateParallaxState();
        this._updateAreaVisibilities();
    }

    _onMonitorsChanged() {
        if (this._layoutIdleId) {
            GLib.source_remove(this._layoutIdleId);
            this._layoutIdleId = null;
        }
        this._layoutIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._layoutIdleId = null;
            this._relayout();
            if (this._wallpaperManager)
                this._wallpaperManager.update();
            this._updateAreaVisibilities();
            return GLib.SOURCE_REMOVE;
        });
    }

    _getPrimaryMonitor() {
        return Main.layoutManager.primaryMonitor || Main.layoutManager.monitors[0];
    }

    _shouldRenderCutout() {
        if (!this._settings.get_boolean('enable-depth'))
            return false;
        const mode = this._settings.get_string('clock-mode');
        if (mode === 'flat' || mode === 'contour-stretch' || mode === 'contour-flow')
            return false;
        const autoAdapt = this._settings.get_boolean('auto-adapt');
        const depthViable = autoAdapt && this._wallpaperManager ? this._wallpaperManager.depthViable : true;
        return depthViable;
    }

    _updateAreaVisibilities() {
        const mode = this._settings ? this._settings.get_string('clock-mode') : 'depth';
        const hasCutout = !!(this._wallpaperManager && this._wallpaperManager.cutoutSurface);
        const hasContour = !!(this._wallpaperManager && this._wallpaperManager.contourProfile && this._wallpaperManager.contourProfile.length > 0);

        const showCutout = this._shouldRenderCutout() && hasCutout;
        const showGlow = (mode === 'rim-glow') && hasContour;
        const showOverlay = (mode === 'silhouette-invert') && hasCutout;

        if (this._cutoutArea) {
            this._cutoutArea.visible = showCutout;
            if (showCutout)
                this._cutoutArea.queue_repaint();
        }
        if (this._glowArea) {
            this._glowArea.visible = showGlow;
            if (showGlow)
                this._glowArea.queue_repaint();
        }
        if (this._overlayArea) {
            this._overlayArea.visible = showOverlay;
            if (showOverlay)
                this._overlayArea.queue_repaint();
        }
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
        this._clockWidget = new ClockWidget(
            this._settings,
            () => {
                const m = this._getPrimaryMonitor();
                return m ? { x: m.x, y: m.y, width: m.width, height: m.height } : null;
            },
            () => (this._wallpaperManager ? this._wallpaperManager.contourProfile : null),
            () => {
                if (this._glowArea)
                    this._glowArea.queue_repaint();
                if (this._overlayArea)
                    this._overlayArea.queue_repaint();
            }
        );
        this._container.add_child(this._clockWidget);

        // Child 1: Backlit Rim Glow Area (behind foreground subject)
        this._glowArea = new St.DrawingArea({
            reactive: false,
            can_focus: false,
            visible: false,
        });
        this._glowArea.set_position(0, 0);
        this._glowArea.set_size(monitor.width, monitor.height);
        this._glowArea.connect('repaint', (area) => this._paintGlow(area));
        this._container.add_child(this._glowArea);

        // Child 2: Foreground Cutout Layer
        this._cutoutArea = new St.DrawingArea({
            reactive: false,
            can_focus: false,
            visible: false,
        });
        this._cutoutArea.set_position(0, 0);
        this._cutoutArea.set_size(monitor.width, monitor.height);
        this._cutoutArea.connect('repaint', (area) => this._paintCutout(area));
        this._container.add_child(this._cutoutArea);

        // Child 3: Top Inverted Silhouette Overlay Layer
        this._overlayArea = new St.DrawingArea({
            reactive: false,
            can_focus: false,
            visible: false,
        });
        this._overlayArea.set_position(0, 0);
        this._overlayArea.set_size(monitor.width, monitor.height);
        this._overlayArea.connect('repaint', (area) => this._paintOverlay(area));
        this._container.add_child(this._overlayArea);

        this._bgGroup = null;
        if (Main.layoutManager._backgroundGroup) {
            this._bgGroup = Main.layoutManager._backgroundGroup;
            this._bgGroup.add_child(this._container);
        } else {
            Main.layoutManager.addChrome(this._container, {
                affectsInputRegion: false,
                trackFullscreen: true,
            });
        }
    }

    _paintCutout(area) {
        const cr = area.get_context();
        cr.setOperator(cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(cairo.Operator.OVER);

        const cutoutSurface = this._wallpaperManager ? this._wallpaperManager.cutoutSurface : null;
        if (this._shouldRenderCutout() && cutoutSurface) {
            const sw = cutoutSurface.getWidth();
            const sh = cutoutSurface.getHeight();
            if (sw > 0 && sh > 0) {
                const scaleX = area.width / sw;
                const scaleY = area.height / sh;
                const scale = Math.max(scaleX, scaleY);
                const offsetX = (area.width - sw * scale) / 2;
                const offsetY = (area.height - sh * scale) / 2;

                cr.save();
                cr.translate(offsetX, offsetY);
                cr.scale(scale, scale);
                cr.setSourceSurface(cutoutSurface, 0, 0);
                cr.paint();
                cr.restore();
            }
        }

        cr.$dispose();
    }

    _paintGlow(area) {
        const cr = area.get_context();
        cr.setOperator(cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(cairo.Operator.OVER);

        const mode = this._settings ? this._settings.get_string('clock-mode') : null;
        if (mode === 'rim-glow')
            this._paintRimGlow(cr, area);

        cr.$dispose();
    }

    _paintOverlay(area) {
        const cr = area.get_context();
        cr.setOperator(cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(cairo.Operator.OVER);

        const mode = this._settings ? this._settings.get_string('clock-mode') : null;
        if (mode === 'silhouette-invert')
            this._paintSilhouetteInvert(cr, area);

        cr.$dispose();
    }

    _paintSilhouetteInvert(cr, area) {
        const cutoutSurface = this._wallpaperManager ? this._wallpaperManager.cutoutSurface : null;
        if (!cutoutSurface || !this._clockWidget) return;

        const invertStyle = this._settings.get_string('invert-style') || 'contrast';
        const clockColorHex = this._settings.get_string('clock-color') || '#ffffff';
        const baseColor = hexToRgba(clockColorHex);
        const [r, g, b] = [baseColor[0], baseColor[1], baseColor[2]];
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;

        let contrastColor;
        if (invertStyle === 'accent') {
            contrastColor = lum > 0.6 ? [0.95, 0.45, 0.20, 1.0] : [0.20, 0.85, 0.95, 1.0];
        } else if (invertStyle === 'outline') {
            contrastColor = lum > 0.5 ? [0.98, 0.98, 0.99, 0.95] : [0.12, 0.14, 0.18, 0.95];
        } else {
            contrastColor = lum > 0.55 ? [0.10, 0.12, 0.16, 0.96] : [0.98, 0.98, 1.0, 0.96];
        }

        const sw = cutoutSurface.getWidth();
        const sh = cutoutSurface.getHeight();
        if (sw === 0 || sh === 0) return;

        const scaleX = area.width / sw;
        const scaleY = area.height / sh;
        const scale = Math.max(scaleX, scaleY);
        const offsetX = (area.width - sw * scale) / 2;
        const offsetY = (area.height - sh * scale) / 2;

        cr.pushGroup();
        this._clockWidget.paintTimeLayout(cr, contrastColor, invertStyle);
        const textPattern = cr.popGroup();

        if (!this._cachedCutoutPattern) {
            cr.pushGroup();
            cr.save();
            cr.translate(offsetX, offsetY);
            cr.scale(scale, scale);
            cr.setSourceSurface(cutoutSurface, 0, 0);
            cr.paint();
            cr.restore();
            this._cachedCutoutPattern = cr.popGroup();
        }

        cr.save();
        cr.setSource(textPattern);
        cr.mask(this._cachedCutoutPattern);
        cr.restore();
    }

    _paintRimGlow(cr, area) {
        const contour = this._wallpaperManager ? this._wallpaperManager.contourProfile : null;
        if (!contour || contour.length === 0 || !this._clockWidget) return;

        const [rangeLeft, rangeRight] = this._clockWidget.getHorizontalRange();
        const scale = this._clockWidget ? (this._clockWidget._currentScale ?? this._settings.get_double('clock-scale')) : 1.0;
        const effectiveScale = Math.max(0.7, scale);
        const pad = Math.round(40 * effectiveScale);
        const startX = Math.max(0, rangeLeft - pad);
        const endX = Math.min(area.width, rangeRight + pad);
        if (endX <= startX) return;

        const glowRadius = this._settings.get_int('glow-radius');
        const glowIntensity = this._settings.get_double('glow-intensity');
        const effectiveRadius = glowRadius * effectiveScale;
        let glowColorHex = this._settings.get_string('glow-color') || '#ffffff';
        if (glowColorHex === '#ffffff') {
            const clockColor = this._settings.get_string('clock-color');
            if (clockColor) glowColorHex = clockColor;
        }
        const [gr, gg, gb] = hexToRgba(glowColorHex);

        const clockY = this._clockWidget.y;
        const clockH = this._clockWidget.height > 0 ? this._clockWidget.height : this._clockWidget._getBaseClockHeight();
        const padGlow = Math.round(120 * effectiveScale);
        const minY = Math.max(0, clockY - padGlow);
        const maxY = Math.min(area.height, clockY + clockH + padGlow);

        const segments = [];
        let currSeg = [];
        const step = Math.max(2, Math.round(3 * effectiveScale));

        for (let x = startX; x <= endX; x += step) {
            const normX = Math.max(0, Math.min(1, x / area.width));
            const idx = Math.min(contour.length - 1, Math.floor(normX * contour.length));
            const ratio = contour[idx];
            const y = ratio * area.height;

            if (ratio < 0.95 && y >= minY && y <= maxY) {
                currSeg.push(x, y);
            } else {
                if (currSeg.length >= 4)
                    segments.push(currSeg);
                currSeg = [];
            }
        }
        if (currSeg.length >= 4)
            segments.push(currSeg);

        if (segments.length === 0) return;

        cr.save();
        cr.setLineCap(cairo.LineCap.ROUND);
        cr.setLineJoin(cairo.LineJoin.ROUND);

        cr.newPath();
        for (const seg of segments) {
            cr.moveTo(seg[0], seg[1]);
            for (let i = 2; i < seg.length; i += 2) {
                cr.lineTo(seg[i], seg[i + 1]);
            }
        }

        cr.setLineWidth(effectiveRadius * 2.2);
        cr.setSourceRGBA(gr, gg, gb, glowIntensity * 0.15);
        cr.strokePreserve();

        cr.setLineWidth(effectiveRadius * 1.1);
        cr.setSourceRGBA(gr, gg, gb, glowIntensity * 0.35);
        cr.strokePreserve();

        cr.setLineWidth(Math.max(2, Math.round(effectiveRadius * 0.35)));
        cr.setSourceRGBA(gr, gg, gb, glowIntensity * 0.75);
        cr.strokePreserve();

        cr.setLineWidth(Math.max(1.5, 1.5 * effectiveScale));
        cr.setSourceRGBA(1.0, 1.0, 1.0, glowIntensity * 0.95);
        cr.stroke();

        cr.restore();
    }

    _updateParallaxState() {
        const mode = this._settings.get_string('clock-mode');
        const isParallax = mode === 'depth-parallax';
        if (isParallax && !this._stageMotionId) {
            this._enableParallax();
        } else if (!isParallax && this._stageMotionId) {
            this._disableParallax();
        }
    }

    _enableParallax() {
        if (this._stageMotionId) return;
        this._stageMotionId = global.stage.connect('captured-event', (_stage, event) => {
            if (event.type() === Clutter.EventType.MOTION) {
                const [stageX, stageY] = event.get_coords();
                this._queueParallaxUpdate(stageX, stageY);
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _queueParallaxUpdate(stageX, stageY) {
        this._pendingPointerX = stageX;
        this._pendingPointerY = stageY;
        if (this._parallaxIdleId) return;
        this._parallaxIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._parallaxIdleId = null;
            this._applyParallax(this._pendingPointerX, this._pendingPointerY);
            return GLib.SOURCE_REMOVE;
        });
    }

    _applyParallax(px, py) {
        const mode = this._settings ? this._settings.get_string('clock-mode') : null;
        if (mode !== 'depth-parallax') return;

        const monitor = this._getPrimaryMonitor();
        if (!monitor || !this._clockWidget || this._clockWidget._isDragging) return;

        if (px === undefined || py === undefined) {
            [px, py] = global.get_pointer();
        }

        const cx = monitor.x + monitor.width / 2;
        const cy = monitor.y + monitor.height / 2;

        const normX = Math.max(-1, Math.min(1, (px - cx) / (monitor.width / 2)));
        const normY = Math.max(-1, Math.min(1, (py - cy) / (monitor.height / 2)));

        const intensity = this._settings.get_int('parallax-intensity');
        const tx = Math.round(normX * intensity);
        const ty = Math.round(normY * intensity * 0.6);

        if (tx === this._lastParallaxX && ty === this._lastParallaxY)
            return;

        this._lastParallaxX = tx;
        this._lastParallaxY = ty;
        this._clockWidget.set_translation(tx, ty, 0);
    }

    _disableParallax() {
        if (this._stageMotionId) {
            global.stage.disconnect(this._stageMotionId);
            this._stageMotionId = null;
        }
        if (this._parallaxIdleId) {
            GLib.source_remove(this._parallaxIdleId);
            this._parallaxIdleId = null;
        }
        this._lastParallaxX = 0;
        this._lastParallaxY = 0;
        if (this._clockWidget)
            this._clockWidget.set_translation(0, 0, 0);
        if (this._cutoutArea)
            this._cutoutArea.set_translation(0, 0, 0);
        if (this._glowArea)
            this._glowArea.set_translation(0, 0, 0);
        if (this._overlayArea)
            this._overlayArea.set_translation(0, 0, 0);
    }

    _relayout() {
        const monitor = this._getPrimaryMonitor();
        if (!monitor || !this._container) return;

        this._cachedCutoutPattern = null;

        this._container.set_position(monitor.x, monitor.y);
        this._container.set_size(monitor.width, monitor.height);

        if (this._cutoutArea)
            this._cutoutArea.set_size(monitor.width, monitor.height);
        if (this._glowArea)
            this._glowArea.set_size(monitor.width, monitor.height);
        if (this._overlayArea)
            this._overlayArea.set_size(monitor.width, monitor.height);

        if (this._clockWidget) {
            this._clockWidget._applyStyles();
            this._clockWidget._applyPosition();
        }
    }

    disable() {
        this._cachedCutoutPattern = null;
        if (this._layoutIdleId) {
            GLib.source_remove(this._layoutIdleId);
            this._layoutIdleId = null;
        }
        if (this._bgChangeId1) this._bgSettings.disconnect(this._bgChangeId1);
        if (this._bgChangeId2) this._bgSettings.disconnect(this._bgChangeId2);
        if (this._bgChangeId3) this._bgSettings.disconnect(this._bgChangeId3);
        if (this._interfaceChangeId) this._interfaceSettings.disconnect(this._interfaceChangeId);
        if (this._settingsDepthId) this._settings.disconnect(this._settingsDepthId);
        if (this._settingsContourId) this._settings.disconnect(this._settingsContourId);
        if (this._settingsModeId) this._settings.disconnect(this._settingsModeId);
        if (this._settingsDualToneId) this._settings.disconnect(this._settingsDualToneId);
        if (this._settingsContourClearanceId) this._settings.disconnect(this._settingsContourClearanceId);
        if (this._settingsContourStyleId) this._settings.disconnect(this._settingsContourStyleId);
        if (this._settingsInvertStyleId) this._settings.disconnect(this._settingsInvertStyleId);
        if (this._settingsParallaxIntensityId) this._settings.disconnect(this._settingsParallaxIntensityId);
        if (this._settingsGlowColorId) this._settings.disconnect(this._settingsGlowColorId);
        if (this._settingsGlowRadiusId) this._settings.disconnect(this._settingsGlowRadiusId);
        if (this._settingsGlowIntensityId) this._settings.disconnect(this._settingsGlowIntensityId);
        if (this._settingsFlowClearanceId) this._settings.disconnect(this._settingsFlowClearanceId);
        if (this._settingsAutoColorId) this._settings.disconnect(this._settingsAutoColorId);
        if (this._settingsAutoAdaptId) this._settings.disconnect(this._settingsAutoAdaptId);
        if (this._monitorsId) Main.layoutManager.disconnect(this._monitorsId);

        this._disableParallax();

        if (this._wallpaperManager) {
            this._wallpaperManager.destroy();
            this._wallpaperManager = null;
        }

        if (this._clockWidget) {
            this._clockWidget.destroy();
            this._clockWidget = null;
        }

        if (this._glowArea) {
            this._glowArea.destroy();
            this._glowArea = null;
        }

        if (this._cutoutArea) {
            this._cutoutArea.destroy();
            this._cutoutArea = null;
        }

        if (this._overlayArea) {
            this._overlayArea.destroy();
            this._overlayArea = null;
        }

        if (this._container) {
            if (this._bgGroup)
                this._bgGroup.remove_child(this._container);
            else
                Main.layoutManager.removeChrome(this._container);
            this._container.destroy();
            this._container = null;
        }

        this._bgGroup = null;
        this._settings = null;
        this._bgSettings = null;
        this._interfaceSettings = null;
    }
}
