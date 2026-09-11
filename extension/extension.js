import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import cairo from 'gi://cairo';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function hexToRgba(hex, alpha = 1.0) {
    if (!hex) return [1.0, 1.0, 1.0, alpha];
    let clean = hex.replace('#', '').trim();
    if (clean.length === 3)
        clean = clean.split('').map(c => c + c).join('');
    if (clean.length !== 6)
        return [1.0, 1.0, 1.0, alpha];
    const num = parseInt(clean, 16);
    return [
        ((num >> 16) & 255) / 255,
        ((num >> 8) & 255) / 255,
        (num & 255) / 255,
        alpha
    ];
}

const ClockWidget = GObject.registerClass(
    class ClockWidget extends St.BoxLayout {
        _init(settings, getMonitorBounds, getContourData, onRepaintOverlay = null) {
            super._init({
                vertical: true,
                reactive: true,
                track_hover: true,
                style_class: 'depth-clock-widget',
            });

            this._settings = settings;
            this._getMonitorBounds = getMonitorBounds;
            this._getContourData = getContourData;
            this._onRepaintOverlay = onRepaintOverlay;
            this._isDragging = false;
            this._isSavingPosition = false;
            this._grab = null;
            this._dragStartX = 0;
            this._dragStartY = 0;
            this._dragActorStartX = 0;
            this._dragActorStartY = 0;
            this._scrollTimerId = null;
            this._positionIdleId = null;
            this._currentScale = null;
            this._digitMetrics = null;
            this._cachedFontDesc = null;
            this._cachedDateDesc = null;
            this._lastTimeString = '';
            this._lastDateString = '';

            // Date label
            this._dateLabel = new St.Label({
                text: '',
                style_class: 'depth-clock-date',
                x_align: Clutter.ActorAlign.CENTER,
            });
            this._dateLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            this.add_child(this._dateLabel);

            // Time label (standard depth and flat mode)
            this._timeLabel = new St.Label({
                text: '',
                style_class: 'depth-clock-time',
                x_align: Clutter.ActorAlign.CENTER,
            });
            this._timeLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            this.add_child(this._timeLabel);

            // Contour adaptive drawing area (contour-stretch mode)
            this._contourArea = new St.DrawingArea({
                reactive: false,
                can_focus: false,
                x_align: Clutter.ActorAlign.CENTER,
            });
            this._contourArea.connect('repaint', (area) => this._paintContourClock(area));
            this.add_child(this._contourArea);

            // Re-center whenever actor bounds or layout change without feedback loops
            this.connect('notify::allocation', () => {
                if (!this._isDragging && !this._isSavingPosition) {
                    const bounds = this._getMonitorBounds();
                    if (!bounds || bounds.width === 0 || bounds.height === 0) return;
                    const rx = this._settings.get_double('clock-x');
                    const ry = this._settings.get_double('clock-y');
                    const baseH = this._getBaseClockHeight();
                    const padY = (this._digitMetrics && this._isContourMode()) ? this._digitMetrics.padY : 0;
                    const clockW = (this._isContourMode() && this._digitMetrics) ? this._digitMetrics.totalW : this.width;
                    const targetX = Math.round(bounds.width * rx - clockW / 2);
                    const targetY = Math.round(bounds.height * ry - (baseH / 2 + padY));
                    if (this.x !== targetX || this.y !== targetY) {
                        if (this._positionIdleId) {
                            GLib.source_remove(this._positionIdleId);
                            this._positionIdleId = null;
                        }
                        this._positionIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                            this._positionIdleId = null;
                            if (!this._isDragging && !this._isSavingPosition)
                                this.set_position(targetX, targetY);
                            return GLib.SOURCE_REMOVE;
                        });
                    }
                }
            });

            // Drag positioning
            this.connect('button-press-event', (_actor, event) => {
                if (event.get_button() === 1) {
                    this._isDragging = true;
                    this._grab = global.stage.grab(this);
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
                    if (this._contourArea && this._contourArea.visible)
                        this._contourArea.queue_repaint();
                    const mode = this._settings.get_string('clock-mode');
                    if (this._onRepaintOverlay && (mode === 'silhouette-invert' || mode === 'rim-glow'))
                        this._onRepaintOverlay();
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
                } else if (
                    key === 'clock-scale' ||
                    key === 'clock-font' ||
                    key === 'clock-color' ||
                    key === 'clock-opacity' ||
                    key === 'stack-digits' ||
                    key === 'clock-mode' ||
                    key === 'contour-mode' ||
                    key === 'dual-tone' ||
                    key === 'contour-clearance' ||
                    key === 'contour-style' ||
                    key === 'invert-style' ||
                    key === 'glow-radius' ||
                    key === 'glow-color' ||
                    key === 'glow-intensity' ||
                    key === 'flow-clearance'
                ) {
                    this._currentScale = this._settings.get_double('clock-scale');
                    this._applyStyles();
                    this._applyPosition();
                    const mode = this._settings.get_string('clock-mode');
                    if (this._onRepaintOverlay && (mode === 'silhouette-invert' || mode === 'rim-glow'))
                        this._onRepaintOverlay();
                } else if (key === 'time-format-24h' || key === 'show-date' || key === 'stack-digits') {
                    this._lastTimeString = '';
                    this._lastDateString = '';
                    this._updateClock();
                    this._scheduleNextTick();
                }
            });

            this._currentScale = this._settings.get_double('clock-scale');
            this._applyStyles();
            this._applyPosition();
            this._updateClock();
            this._scheduleNextTick();
        }

        _scheduleNextTick() {
            if (this._tickerId) {
                GLib.source_remove(this._tickerId);
                this._tickerId = null;
            }
            const now = GLib.DateTime.new_now_local();
            const msUntilNextMinute = (60 - now.get_second()) * 1000 - Math.floor(now.get_microsecond() / 1000) + 100;
            const delay = Math.max(250, msUntilNextMinute);
            this._tickerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                this._tickerId = null;
                this._updateClock();
                this._scheduleNextTick();
                return GLib.SOURCE_REMOVE;
            });
        }

        _isContourMode() {
            const mode = this._settings.get_string('clock-mode');
            if (mode === 'contour-stretch' || mode === 'contour-flow')
                return true;
            if (mode === 'depth' && this._settings.get_boolean('contour-mode'))
                return true;
            return false;
        }

        _getBaseClockHeight() {
            const isContour = this._isContourMode();
            const scale = this._currentScale ?? this._settings.get_double('clock-scale');
            if (isContour)
                return this._digitMetrics ? this._digitMetrics.baseDigitH : Math.round(250 * scale);
            return this.height > 0 ? this.height : Math.round(250 * scale);
        }

        _applyStyles(overrideScale = null) {
            const scale = overrideScale !== null ? overrideScale : this._settings.get_double('clock-scale');
            const font = this._settings.get_string('clock-font');
            const color = this._settings.get_string('clock-color');
            const opacity = Math.round(this._settings.get_double('clock-opacity') * 255);
            const isStacked = this._settings.get_boolean('stack-digits');
            const isContour = this._isContourMode();

            const baseFontSize = (isStacked && !isContour) ? 190 : 250;
            const fontSize = Math.round(baseFontSize * scale);
            const dateSize = Math.round(24 * scale);

            const fontDesc = Pango.FontDescription.from_string(font);
            fontDesc.set_size(fontSize * Pango.SCALE);
            if (!fontDesc.get_weight() || fontDesc.get_weight() === Pango.Weight.NORMAL)
                fontDesc.set_weight(Pango.Weight.BOLD);
            this._cachedFontDesc = fontDesc;

            const fontFamily = fontDesc.get_family() || font;
            const fontWeight = fontDesc.get_weight();
            const weightCss = fontWeight && fontWeight !== Pango.Weight.NORMAL
                ? `font-weight: ${fontWeight};`
                : 'font-weight: 700;';
            const styleCss = fontDesc.get_style() !== Pango.Style.NORMAL
                ? 'font-style: italic;'
                : '';

            this._cachedDateDesc = Pango.FontDescription.from_string(`${fontFamily} ${dateSize}px`);

            this._timeLabel.set_style(
                `font-family: '${fontFamily}', sans-serif; ${weightCss} ${styleCss} font-size: ${fontSize}px; color: ${color}; line-height: ${isStacked ? 0.82 : 0.9};`
            );
            this._dateLabel.set_style(
                `font-size: ${dateSize}px; color: ${color}; opacity: 0.9;`
            );
            this.set_opacity(opacity);

            if (isContour) {
                this._timeLabel.hide();
                this._contourArea.show();

                const tempSurface = new cairo.ImageSurface(cairo.Format.ARGB32, 1, 1);
                const cr = new cairo.Context(tempSurface);
                const layoutDesc = fontDesc;

                const layout = PangoCairo.create_layout(cr);
                layout.set_font_description(layoutDesc);

                let maxDigitW = 0;
                let baseDigitH = 0;
                for (let i = 0; i <= 9; i++) {
                    layout.set_text(i.toString(), -1);
                    const [w, h] = layout.get_pixel_size();
                    if (w > maxDigitW) maxDigitW = w;
                    if (h > baseDigitH) baseDigitH = h;
                }
                cr.$dispose();
                tempSurface.finish();

                const colW = Math.max(maxDigitW, Math.round(fontSize * 0.44));
                const gap = Math.round(14 * scale);
                const midGap = Math.round(32 * scale);
                const totalW = 4 * colW + 2 * gap + midGap;
                const padY = Math.round(baseDigitH * 1.0);
                const totalH = Math.round(baseDigitH * 3.65);

                this._digitMetrics = {
                    colW,
                    gap,
                    midGap,
                    baseDigitH,
                    padY,
                    totalW,
                    totalH,
                    fontSize,
                    fontDesc: layoutDesc,
                };

                this._contourArea.set_size(totalW, totalH);
                this._contourArea.set_width(totalW);
                this._contourArea.set_height(totalH);
                this._contourArea.queue_repaint();
            } else {
                this._contourArea.hide();
                this._timeLabel.show();
            }
        }

        _applyPosition() {
            const bounds = this._getMonitorBounds();
            if (!bounds || bounds.width === 0 || bounds.height === 0) return;

            const rx = this._settings.get_double('clock-x');
            const ry = this._settings.get_double('clock-y');
            const baseH = this._getBaseClockHeight();
            const padY = (this._digitMetrics && this._isContourMode()) ? this._digitMetrics.padY : 0;
            const clockW = (this._isContourMode() && this._digitMetrics) ? this._digitMetrics.totalW : this.width;

            let targetX = Math.round(bounds.width * rx - clockW / 2);
            let targetY = Math.round(bounds.height * ry - (baseH / 2 + padY));

            if (bounds.width >= clockW) {
                targetX = Math.max(0, Math.min(bounds.width - clockW, targetX));
            } else {
                targetX = Math.round((bounds.width - clockW) / 2);
            }

            const minY = -padY;
            const maxY = Math.max(-padY, bounds.height - (baseH + padY));
            targetY = Math.max(minY, Math.min(maxY, targetY));

            this.set_position(targetX, targetY);
            if (this._contourArea && this._contourArea.visible)
                this._contourArea.queue_repaint();
            if (this._onRepaintOverlay)
                this._onRepaintOverlay();
        }

        _savePosition() {
            const bounds = this._getMonitorBounds();
            if (!bounds || bounds.width === 0 || bounds.height === 0) return;

            const baseH = this._getBaseClockHeight();
            const padY = (this._digitMetrics && this._isContourMode()) ? this._digitMetrics.padY : 0;
            const clockW = (this._isContourMode() && this._digitMetrics) ? this._digitMetrics.totalW : this.width;
            const centerX = this.x + clockW / 2;
            const centerY = this.y + baseH / 2 + padY;

            const rx = Math.max(0.05, Math.min(0.95, centerX / bounds.width));
            const ry = Math.max(0.05, Math.min(0.95, centerY / bounds.height));

            this._isSavingPosition = true;
            this._settings.set_double('clock-x', Math.round(rx * 1000) / 1000);
            this._settings.set_double('clock-y', Math.round(ry * 1000) / 1000);
            this._isSavingPosition = false;

            this._applyPosition();
        }

        _getContourScale(screenX, digitW, baseDigitH, anchorY, bounds) {
            if (!bounds || bounds.width === 0 || bounds.height === 0)
                return { sx: 1.0, sy: 1.0, offsetY: 0 };

            const contour = this._getContourData ? this._getContourData() : null;
            if (!contour || contour.length === 0)
                return { sx: 1.0, sy: 1.0, offsetY: 0 };

            const hasAnyObject = contour.some(v => v < 0.95);
            if (!hasAnyObject)
                return { sx: 1.0, sy: 1.0, offsetY: 0 };

            const nSamples = contour.length;
            let minContourRatio = 1.0;
            let hasFgUnderDigit = false;

            const steps = 8;
            for (let s = 0; s <= steps; s++) {
                const px = screenX + (s / steps) * digitW;
                const normX = Math.max(0, Math.min(1, px / bounds.width));
                const idx = Math.min(nSamples - 1, Math.floor(normX * nSamples));
                const val = contour[idx];
                if (val < minContourRatio)
                    minContourRatio = val;
                if (val < 0.95)
                    hasFgUnderDigit = true;
            }

            if (!hasFgUnderDigit || minContourRatio >= 0.95)
                return { sx: 1.0, sy: 1.0, offsetY: 0 };

            const clearance = this._settings.get_int('contour-clearance');
            const style = this._settings.get_string('contour-style') || 'stretch';
            const objectY = minContourRatio * bounds.height;
            const availableH = objectY - anchorY - clearance;

            if (availableH <= baseDigitH * 0.35)
                return { sx: 1.0, sy: 1.0, offsetY: 0 };

            const targetScale = availableH / baseDigitH;

            if (style === 'fit') {
                const uniformScale = Math.max(0.65, Math.min(1.35, targetScale));
                return {
                    sx: uniformScale,
                    sy: uniformScale,
                    offsetY: (1.0 - uniformScale) * baseDigitH * 0.5,
                };
            }

            const sy = Math.max(0.55, Math.min(2.35, targetScale));
            return { sx: 1.0, sy, offsetY: 0 };
        }

        _getFlowOffset(screenX, digitW, baseDigitH, anchorY, bounds) {
            if (!bounds || bounds.width === 0 || bounds.height === 0)
                return { sx: 1.0, sy: 1.0, offsetY: 0, tanAngle: 0 };

            const contour = this._getContourData ? this._getContourData() : null;
            if (!contour || contour.length === 0)
                return { sx: 1.0, sy: 1.0, offsetY: 0, tanAngle: 0 };

            const hasAnyObject = contour.some(v => v < 0.95);
            if (!hasAnyObject)
                return { sx: 1.0, sy: 1.0, offsetY: 0, tanAngle: 0 };

            const nSamples = contour.length;
            let minContourRatio = 1.0;
            let firstX = null, firstY = null;
            let lastX = null, lastY = null;
            const steps = 8;

            for (let s = 0; s <= steps; s++) {
                const px = screenX + (s / steps) * digitW;
                const normX = Math.max(0, Math.min(1, px / bounds.width));
                const idx = Math.min(nSamples - 1, Math.floor(normX * nSamples));
                const val = contour[idx];
                if (val < minContourRatio)
                    minContourRatio = val;
                if (val < 0.95) {
                    const py = val * bounds.height;
                    if (firstX === null) {
                        firstX = px;
                        firstY = py;
                    }
                    lastX = px;
                    lastY = py;
                }
            }

            if (minContourRatio >= 0.96)
                return { sx: 1.0, sy: 1.0, offsetY: 0, tanAngle: 0 };

            let tanAngle = 0;
            if (firstX !== null && lastX !== null && (lastX - firstX) >= digitW * 0.35) {
                const slope = (lastY - firstY) / (lastX - firstX);
                tanAngle = Math.max(-0.22, Math.min(0.22, Math.atan(slope)));
            }

            const clearance = this._settings.get_int('flow-clearance');
            const targetBottomY = minContourRatio * bounds.height - clearance;
            const defaultBottomY = anchorY + baseDigitH;
            const rawOffset = targetBottomY - defaultBottomY;
            const maxDisplacement = Math.round(baseDigitH * 0.85);
            const offsetY = Math.max(-maxDisplacement, Math.min(maxDisplacement, rawOffset));

            return { sx: 1.0, sy: 1.0, offsetY, tanAngle };
        }

        _paintContourClock(area) {
            if (!this._digitMetrics) return;

            const cr = area.get_context();
            cr.setOperator(cairo.Operator.CLEAR);
            cr.paint();
            cr.setOperator(cairo.Operator.OVER);

            const { colW, gap, midGap, baseDigitH, padY, fontDesc, totalW } = this._digitMetrics;
            const now = GLib.DateTime.new_now_local();
            const is24h = this._settings.get_boolean('time-format-24h');
            let hour = now.get_hour();
            const min = now.get_minute();
            if (!is24h)
                hour = hour % 12 || 12;

            const hh = hour < 10 ? `0${hour}` : `${hour}`;
            const mm = min < 10 ? `0${min}` : `${min}`;
            const digits = [hh[0], hh[1], mm[0], mm[1]];

            const bounds = this._getMonitorBounds();
            const monRelX = this.x + (this._contourArea ? this._contourArea.x : 0);
            const monRelY = this.y + (this._contourArea ? this._contourArea.y : 0);
            const fallbackX = bounds ? Math.round(bounds.width * this._settings.get_double('clock-x') - totalW / 2) : 0;
            const fallbackY = bounds ? Math.round(bounds.height * this._settings.get_double('clock-y') - (baseDigitH / 2 + padY)) : 0;
            const anchorX = (this.width > 0) ? monRelX : fallbackX;
            const anchorY = (this.width > 0) ? (monRelY + padY) : (fallbackY + padY);
            const scale = this._currentScale ?? this._settings.get_double('clock-scale');

            const dualTone = this._settings.get_boolean('dual-tone');
            const clockColorHex = this._settings.get_string('clock-color') || '#ffffff';
            const baseColor = hexToRgba(clockColorHex);
            const [r, g, b] = [baseColor[0], baseColor[1], baseColor[2]];
            const max = Math.max(r, g, b);
            const minC = Math.min(r, g, b);
            const sat = max === 0 ? 0 : (max - minC) / max;
            const hourLum = 0.2126 * r + 0.7152 * g + 0.0722 * b;

            let hourColor = [...baseColor];
            let minuteColor = [...baseColor];
            if (dualTone) {
                if (sat > 0.18) {
                    minuteColor = hourLum > 0.65 ? [0.12, 0.14, 0.18, 0.95] : [0.98, 0.98, 0.99, 0.95];
                } else {
                    hourColor = [0.98, 0.62, 0.35, 1.0];
                    minuteColor = [0.95, 0.96, 0.98, 0.95];
                }
            }

            const layout = PangoCairo.create_layout(cr);
            layout.set_font_description(fontDesc);

            const isFlow = this._settings.get_string('clock-mode') === 'contour-flow';
            let currX = 0;
            const topY = padY;

            for (let i = 0; i < 4; i++) {
                layout.set_text(digits[i], -1);
                const [w] = layout.get_pixel_size();
                const xOffset = Math.round((colW - w) / 2);
                const digitScreenX = anchorX + currX + xOffset;
                const digitLocalX = currX + xOffset;

                const { sx, sy, offsetY, tanAngle = 0 } = isFlow
                    ? this._getFlowOffset(digitScreenX, w, baseDigitH, anchorY, bounds)
                    : this._getContourScale(digitScreenX, w, baseDigitH, anchorY, bounds);
                const col = i < 2 ? hourColor : minuteColor;

                if (isFlow) {
                    // Flow mode: rotate digit around bottom center to sit on contour tangent
                    cr.save();
                    cr.translate(digitLocalX + w / 2, topY + offsetY + baseDigitH + Math.round(5 * scale));
                    if (tanAngle !== 0) cr.rotate(tanAngle);
                    cr.translate(-w / 2, -baseDigitH);
                    cr.setSourceRGBA(0, 0, 0, 0.40);
                    PangoCairo.show_layout(cr, layout);
                    cr.restore();

                    cr.save();
                    cr.translate(digitLocalX + w / 2, topY + offsetY + baseDigitH + Math.round(2 * scale));
                    if (tanAngle !== 0) cr.rotate(tanAngle);
                    cr.translate(-w / 2, -baseDigitH);
                    cr.setSourceRGBA(0, 0, 0, 0.30);
                    PangoCairo.show_layout(cr, layout);
                    cr.restore();

                    cr.save();
                    cr.translate(digitLocalX + w / 2, topY + offsetY + baseDigitH);
                    if (tanAngle !== 0) cr.rotate(tanAngle);
                    cr.translate(-w / 2, -baseDigitH);
                    cr.setSourceRGBA(col[0], col[1], col[2], col[3] ?? 1.0);
                    PangoCairo.show_layout(cr, layout);
                    cr.restore();
                } else {
                    // Stretch / Fit mode: anchor top at topY and scale downwards
                    cr.save();
                    cr.translate(digitLocalX, topY + offsetY + Math.round(5 * scale));
                    cr.scale(sx, sy);
                    cr.setSourceRGBA(0, 0, 0, 0.40);
                    PangoCairo.show_layout(cr, layout);
                    cr.restore();

                    cr.save();
                    cr.translate(digitLocalX, topY + offsetY + Math.round(2 * scale));
                    cr.scale(sx, sy);
                    cr.setSourceRGBA(0, 0, 0, 0.30);
                    PangoCairo.show_layout(cr, layout);
                    cr.restore();

                    cr.save();
                    cr.translate(digitLocalX, topY + offsetY);
                    cr.scale(sx, sy);
                    cr.setSourceRGBA(col[0], col[1], col[2], col[3] ?? 1.0);
                    PangoCairo.show_layout(cr, layout);
                    cr.restore();
                }

                currX += colW + gap;
                if (i === 1) currX += (midGap - gap);
            }

            cr.$dispose();
        }

        _updateClock() {
            const now = GLib.DateTime.new_now_local();
            const showDate = this._settings.get_boolean('show-date');
            const is24h = this._settings.get_boolean('time-format-24h');
            const isStacked = this._settings.get_boolean('stack-digits');
            const mode = this._settings.get_string('clock-mode');

            let dateStr = '';
            if (showDate) {
                const dayStr = DAYS[now.get_day_of_week() % 7];
                const monthStr = MONTHS[now.get_month() - 1];
                const dayNum = now.get_day_of_month();
                dateStr = `${dayNum} ${monthStr} ${dayStr}`;
            }

            let hour = now.get_hour();
            const min = now.get_minute();
            if (!is24h)
                hour = hour % 12 || 12;

            const hh = hour < 10 ? `0${hour}` : `${hour}`;
            const mm = min < 10 ? `0${min}` : `${min}`;
            const timeStr = `${hh}:${mm}`;

            if (timeStr === this._lastTimeString && dateStr === this._lastDateString)
                return;

            this._lastTimeString = timeStr;
            this._lastDateString = dateStr;

            if (showDate) {
                this._dateLabel.set_text(dateStr);
                this._dateLabel.show();
            } else {
                this._dateLabel.hide();
            }

            if (mode === 'contour-stretch' || mode === 'contour-flow') {
                if (this._contourArea && this._contourArea.visible)
                    this._contourArea.queue_repaint();
            } else {
                if (isStacked)
                    this._timeLabel.set_text(`${hh}\n${mm}`);
                else
                    this._timeLabel.set_text(`${hh}${mm}`);
                const needsOverlay = mode === 'silhouette-invert' || mode === 'rim-glow';
                if (this._onRepaintOverlay && needsOverlay)
                    this._onRepaintOverlay();
            }
        }

        paintTimeLayout(cr, colorRgba, style = 'contrast') {
            const text = this._timeLabel.get_text();
            if (!text) return;

            const isStacked = this._settings.get_boolean('stack-digits');
            const scale = this._currentScale ?? this._settings.get_double('clock-scale');
            const fontDesc = this._cachedFontDesc ?? (() => {
                const font = this._settings.get_string('clock-font');
                const baseFontSize = isStacked ? 190 : 250;
                const fontSize = Math.round(baseFontSize * scale);
                const fd = Pango.FontDescription.from_string(font);
                fd.set_size(fontSize * Pango.SCALE);
                if (!fd.get_weight() || fd.get_weight() === Pango.Weight.NORMAL)
                    fd.set_weight(Pango.Weight.BOLD);
                return fd;
            })();

            const layout = PangoCairo.create_layout(cr);
            layout.set_font_description(fontDesc);
            layout.set_text(text, -1);
            layout.set_line_spacing(isStacked ? 0.82 : 0.90);
            layout.set_alignment(isStacked ? Pango.Alignment.CENTER : Pango.Alignment.LEFT);

            let drawX = this.x;
            let drawY = this.y;
            if (this._timeLabel) {
                drawX += this._timeLabel.x;
                drawY += this._timeLabel.y;
                const [lw] = layout.get_pixel_size();
                const targetW = this._timeLabel.width > 0 ? this._timeLabel.width : lw;
                if (isStacked)
                    layout.set_width(Math.round(targetW * Pango.SCALE));
            }

            cr.save();
            cr.translate(drawX, drawY);

            if (style === 'outline') {
                cr.save();
                cr.setSourceRGBA(colorRgba[0], colorRgba[1], colorRgba[2], 0.15);
                PangoCairo.show_layout(cr, layout);
                cr.restore();

                cr.setLineJoin(cairo.LineJoin.ROUND);
                cr.setLineCap(cairo.LineCap.ROUND);
                cr.setLineWidth(Math.max(2, Math.round(3.5 * scale)));
                cr.setSourceRGBA(colorRgba[0], colorRgba[1], colorRgba[2], colorRgba[3] ?? 1.0);
                PangoCairo.layout_path(cr, layout);
                cr.stroke();
            } else {
                cr.save();
                cr.translate(Math.round(4 * scale), Math.round(4 * scale));
                cr.setSourceRGBA(0, 0, 0, 0.45);
                PangoCairo.show_layout(cr, layout);
                cr.restore();

                cr.setSourceRGBA(colorRgba[0], colorRgba[1], colorRgba[2], colorRgba[3] ?? 1.0);
                PangoCairo.show_layout(cr, layout);
            }

            cr.restore();

            if (this._dateLabel && this._dateLabel.visible) {
                const dateText = this._dateLabel.get_text();
                if (dateText) {
                    const dateDesc = this._cachedDateDesc ?? Pango.FontDescription.from_string(`${fontDesc.get_family() || 'Cantarell'} ${Math.round(24 * scale)}px`);
                    const dateLayout = PangoCairo.create_layout(cr);
                    dateLayout.set_font_description(dateDesc);
                    dateLayout.set_text(dateText, -1);
                    const drawDateX = this.x + this._dateLabel.x;
                    const drawDateY = this.y + this._dateLabel.y;
                    cr.save();
                    cr.translate(drawDateX, drawDateY);
                    cr.setSourceRGBA(colorRgba[0], colorRgba[1], colorRgba[2], 0.9);
                    PangoCairo.show_layout(cr, dateLayout);
                    cr.restore();
                }
            }
        }

        getHorizontalRange() {
            const bounds = this._getMonitorBounds();
            const startX = Math.max(0, this.x);
            const w = this.width > 0 ? this.width : (this._digitMetrics ? this._digitMetrics.totalW : 600);
            const endX = Math.min(bounds?.width ?? 1920, startX + w);
            return [startX, endX];
        }

        updateMode() {
            this._lastTimeString = '';
            this._lastDateString = '';
            this._applyStyles();
            this._applyPosition();
            this._updateClock();
        }

        updateContourData() {
            if (this._contourArea && this._contourArea.visible)
                this._contourArea.queue_repaint();
        }

        destroy() {
            this._onRepaintOverlay = null;
            if (this._grab) {
                this._grab.dismiss();
                this._grab = null;
            }
            if (this._tickerId) {
                GLib.source_remove(this._tickerId);
                this._tickerId = null;
            }
            if (this._positionIdleId) {
                GLib.source_remove(this._positionIdleId);
                this._positionIdleId = null;
            }
            if (this._scrollTimerId) {
                GLib.source_remove(this._scrollTimerId);
                this._scrollTimerId = null;
            }
            if (this._settingsId) {
                this._settings.disconnect(this._settingsId);
                this._settingsId = null;
            }
            this._cachedFontDesc = null;
            this._cachedDateDesc = null;
            this._contourArea = null;
            this._digitMetrics = null;
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
        this._glowArea = null;
        this._cutoutArea = null;
        this._overlayArea = null;
        this._cutoutSurface = null;
        this._cachedCutoutPattern = null;
        this._contourProfile = null;
        this._activeSubprocess = null;
        this._lastProcessedHash = null;
        this._requestToken = 0;
        this._wallpaperTimerId = null;
        this._layoutIdleId = null;
        this._stageMotionId = null;
        this._parallaxIdleId = null;
        this._lastParallaxX = 0;
        this._lastParallaxY = 0;
        this._pendingPointerX = 0;
        this._pendingPointerY = 0;

        this._setupActors();

        this._bgChangeId1 = this._bgSettings.connect('changed::picture-uri', () => this._scheduleWallpaperUpdate());
        this._bgChangeId2 = this._bgSettings.connect('changed::picture-uri-dark', () => this._scheduleWallpaperUpdate());
        this._bgChangeId3 = this._bgSettings.connect('changed::picture-options', () => this._scheduleWallpaperUpdate());
        this._interfaceChangeId = this._interfaceSettings.connect('changed::color-scheme', () => this._scheduleWallpaperUpdate());

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
            this._updateAreaVisibilities();
            this._updateParallaxState();
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
                this._updateAutoColor();
        });

        this._settingsAutoAdaptId = this._settings.connect('changed::auto-adapt', () => {
            this._updateAreaVisibilities();
        });

        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => {
            this._relayout();
            this._scheduleWallpaperUpdate();
        });

        this._updateParallaxState();

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

    _isContourMode() {
        const mode = this._settings.get_string('clock-mode');
        if (mode === 'contour-stretch' || mode === 'contour-flow')
            return true;
        if (mode === 'depth' && this._settings.get_boolean('contour-mode'))
            return true;
        return false;
    }

    _shouldRenderCutout() {
        if (!this._settings.get_boolean('enable-depth'))
            return false;
        const mode = this._settings.get_string('clock-mode');
        if (mode === 'flat' || mode === 'contour-stretch' || mode === 'contour-flow')
            return false;
        const autoAdapt = this._settings.get_boolean('auto-adapt');
        const depthViable = autoAdapt && this._depthViable !== undefined ? this._depthViable : true;
        return depthViable;
    }

    _updateAreaVisibilities() {
        const mode = this._settings ? this._settings.get_string('clock-mode') : 'depth';
        const hasCutout = !!this._cutoutSurface;
        const hasContour = !!(this._contourProfile && this._contourProfile.length > 0);

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
            () => this._contourProfile,
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
        this._glowArea.connect('repaint', (area) => {
            const cr = area.get_context();
            cr.setOperator(cairo.Operator.CLEAR);
            cr.paint();
            cr.setOperator(cairo.Operator.OVER);

            const mode = this._settings ? this._settings.get_string('clock-mode') : null;
            if (mode === 'rim-glow')
                this._paintRimGlow(cr, area);

            cr.$dispose();
        });
        this._container.add_child(this._glowArea);

        // Child 2: Foreground Cutout Area
        this._cutoutArea = new St.DrawingArea({
            reactive: false,
            can_focus: false,
            visible: false,
        });
        this._cutoutArea.set_position(0, 0);
        this._cutoutArea.set_size(monitor.width, monitor.height);

        this._cutoutArea.connect('repaint', (area) => {
            const cr = area.get_context();
            cr.setOperator(cairo.Operator.CLEAR);
            cr.paint();

            if (this._shouldRenderCutout() && this._cutoutSurface) {
                cr.setOperator(cairo.Operator.OVER);
                const sw = this._cutoutSurface.getWidth();
                const sh = this._cutoutSurface.getHeight();
                if (sw > 0 && sh > 0) {
                    const scaleX = area.width / sw;
                    const scaleY = area.height / sh;
                    const scale = Math.max(scaleX, scaleY);
                    const offsetX = (area.width - sw * scale) / 2;
                    const offsetY = (area.height - sh * scale) / 2;

                    cr.translate(offsetX, offsetY);
                    cr.scale(scale, scale);
                    cr.setSourceSurface(this._cutoutSurface, 0, 0);
                    cr.paint();
                }
            }
            cr.$dispose();
        });

        this._container.add_child(this._cutoutArea);

        // Child 3: Overlay Area (for silhouette inversion on top of foreground subject)
        this._overlayArea = new St.DrawingArea({
            reactive: false,
            can_focus: false,
            visible: false,
        });
        this._overlayArea.set_position(0, 0);
        this._overlayArea.set_size(monitor.width, monitor.height);
        this._overlayArea.connect('repaint', (area) => this._paintOverlay(area));
        this._container.add_child(this._overlayArea);

        this._updateAreaVisibilities();

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
        if (this._layoutIdleId) {
            GLib.source_remove(this._layoutIdleId);
            this._layoutIdleId = null;
        }
        this._layoutIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._layoutIdleId = null;
            if (this._clockWidget)
                this._clockWidget._applyPosition();
            return GLib.SOURCE_REMOVE;
        });
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
        if (!this._cutoutSurface || !this._clockWidget) return;

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

        const sw = this._cutoutSurface.getWidth();
        const sh = this._cutoutSurface.getHeight();
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
            cr.setSourceSurface(this._cutoutSurface, 0, 0);
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
        if (!this._contourProfile || !this._clockWidget) return;
        const contour = this._contourProfile;
        if (contour.length === 0) return;

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

    _onWallpaperChanged() {
        const wallpaperPath = this._getWallpaperPath();
        if (!wallpaperPath || !GLib.file_test(wallpaperPath, GLib.FileTest.EXISTS))
            return;

        const monitor = this._getPrimaryMonitor();
        if (!monitor) return;

        const cropRatio = this._calculateCropRatio(wallpaperPath, monitor);

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
        this._pruneCache(cacheDir, 8);
        const cacheFile = GLib.build_filenamev([cacheDir, `${checksum}.png`]);

        if (GLib.file_test(cacheFile, GLib.FileTest.EXISTS)) {
            this._loadCutout(cacheFile);
        } else {
            if (this._cutoutSurface) {
                try {
                    this._cutoutSurface.finish();
                } catch (e) {}
                this._cutoutSurface = null;
            }
            this._cachedCutoutPattern = null;
            this._updateAreaVisibilities();
            this._generateCutoutAsync(wallpaperPath, cacheFile, cropRatio);
        }
    }

    _loadCutout(cutoutPath) {
        if (this._cutoutSurface) {
            try {
                this._cutoutSurface.finish();
            } catch (e) {}
            this._cutoutSurface = null;
        }
        this._cachedCutoutPattern = null;

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

        if (this._clockWidget)
            this._clockWidget.updateContourData(this._contourProfile);

        this._updateAreaVisibilities();
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
                } catch (e) { }
            }
            return samples;
        } catch (e) {
            console.warn(`[DepthClock] Failed to extract contour from cutout: ${e}`);
            return null;
        }
    }

    _updateAutoColor() {
        const wallpaperPath = this._getWallpaperPath();
        if (!wallpaperPath || !GLib.file_test(wallpaperPath, GLib.FileTest.EXISTS))
            return;

        const monitor = this._getPrimaryMonitor();
        if (!monitor) return;

        const cropRatio = this._calculateCropRatio(wallpaperPath, monitor);
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
        let scriptPath = GLib.build_filenamev([this.path, 'backend', 'segment.py']);
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

    disable() {
        this._cachedCutoutPattern = null;
        if (this._wallpaperTimerId) {
            GLib.source_remove(this._wallpaperTimerId);
            this._wallpaperTimerId = null;
        }
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

        if (this._cutoutSurface) {
            try {
                this._cutoutSurface.finish();
            } catch (e) {}
            this._cutoutSurface = null;
        }
        this._contourProfile = null;
        this._bgGroup = null;
        this._settings = null;
        this._bgSettings = null;
        this._interfaceSettings = null;
    }
}
