import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import St from 'gi://St';
import cairo from 'gi://cairo';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { hexToRgba } from './colorUtils.js';

export const ClockWidget = GObject.registerClass(
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

