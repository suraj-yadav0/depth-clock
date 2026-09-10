import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Pango from 'gi://Pango';
import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class DepthClockPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-desktop-wallpaper-symbolic',
        });
        window.add(page);

        // Group: Subject Interaction Mode
        const modeGroup = new Adw.PreferencesGroup({
            title: _('Subject Interaction Mode'),
            description: _('Choose how clock digits interact with detected foreground subjects'),
        });
        page.add(modeGroup);

        const modeModel = new Gtk.StringList();
        modeModel.append(_('3D Depth (Behind Subject)'));
        modeModel.append(_('Contour-Adaptive (Over Subject)'));
        modeModel.append(_('Standard Flat Clock (No Interaction)'));

        const modeRow = new Adw.ComboRow({
            title: _('Clock Mode'),
            subtitle: _('Behind subject, contour hugging over subject, or standard flat'),
            model: modeModel,
        });
        modeGroup.add(modeRow);

        // 3D Depth mode options
        const adaptRow = new Adw.SwitchRow({
            title: _('Auto-Adapt Legibility'),
            subtitle: _('Temporarily disable depth if foreground obscures more than 85% of time'),
        });
        settings.bind('auto-adapt', adaptRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        modeGroup.add(adaptRow);

        // Contour Adaptive options
        const contourStyleModel = new Gtk.StringList();
        contourStyleModel.append(_('Vertical Stretch (Kinetic)'));
        contourStyleModel.append(_('Proportional Fit'));

        const contourStyleRow = new Adw.ComboRow({
            title: _('Contour Adaptation Style'),
            subtitle: _('Stretch vertically to hug contour, or scale proportionally'),
            model: contourStyleModel,
        });
        modeGroup.add(contourStyleRow);

        const dualToneRow = new Adw.SwitchRow({
            title: _('Dual-Tone Digits'),
            subtitle: _('Accent color for hours and contrasting tone for minutes over subject'),
        });
        settings.bind('dual-tone', dualToneRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        modeGroup.add(dualToneRow);

        const clearanceRow = new Adw.SpinRow({
            title: _('Contour Clearance (px)'),
            subtitle: _('Spacing between digits and subject silhouette'),
            adjustment: new Gtk.Adjustment({
                lower: -20,
                upper: 60,
                step_increment: 2,
                page_increment: 5,
                value: settings.get_int('contour-clearance'),
            }),
            digits: 0,
        });
        clearanceRow.connect('notify::value', (spin) => {
            settings.set_int('contour-clearance', Math.round(spin.get_value()));
        });
        settings.connect('changed::contour-clearance', () => {
            clearanceRow.set_value(settings.get_int('contour-clearance'));
        });
        modeGroup.add(clearanceRow);

        let stackRow = null;
        let isSyncing = false;

        const updateModeUI = () => {
            if (isSyncing) return;
            isSyncing = true;

            const modeStr = settings.get_string('clock-mode');
            const isContour = settings.get_boolean('contour-mode') || modeStr === 'contour-stretch';
            const isDepth = settings.get_boolean('enable-depth') && !isContour;

            let selectedIndex = 2;
            if (isContour) {
                selectedIndex = 1;
            } else if (isDepth || modeStr === 'depth') {
                selectedIndex = 0;
            }

            if (modeRow.selected !== selectedIndex)
                modeRow.selected = selectedIndex;

            const currentStyle = settings.get_string('contour-style');
            const styleIndex = currentStyle === 'fit' ? 1 : 0;
            if (contourStyleRow.selected !== styleIndex)
                contourStyleRow.selected = styleIndex;

            adaptRow.visible = (selectedIndex === 0);
            contourStyleRow.visible = (selectedIndex === 1);
            dualToneRow.visible = (selectedIndex === 1);
            clearanceRow.visible = (selectedIndex === 1);

            if (stackRow) {
                stackRow.sensitive = (selectedIndex !== 1);
                stackRow.subtitle = (selectedIndex === 1)
                    ? _('Contour-adaptive mode requires horizontal digit layout')
                    : _('Display hour on top and minute below instead of single row');
            }

            isSyncing = false;
        };

        modeRow.connect('notify::selected', () => {
            if (isSyncing) return;
            isSyncing = true;
            const sel = modeRow.selected;
            if (sel === 0) {
                settings.set_string('clock-mode', 'depth');
                settings.set_boolean('enable-depth', true);
                settings.set_boolean('contour-mode', false);
            } else if (sel === 1) {
                settings.set_string('clock-mode', 'contour-stretch');
                settings.set_boolean('enable-depth', false);
                settings.set_boolean('contour-mode', true);
            } else {
                settings.set_string('clock-mode', 'flat');
                settings.set_boolean('enable-depth', false);
                settings.set_boolean('contour-mode', false);
            }
            isSyncing = false;
            updateModeUI();
        });

        contourStyleRow.connect('notify::selected', () => {
            if (isSyncing) return;
            const style = contourStyleRow.selected === 1 ? 'fit' : 'stretch';
            settings.set_string('contour-style', style);
        });

        settings.connect('changed::clock-mode', updateModeUI);
        settings.connect('changed::contour-mode', updateModeUI);
        settings.connect('changed::enable-depth', updateModeUI);
        settings.connect('changed::contour-style', updateModeUI);

        // AI Model Backend Status & Setup
        const setupScript = `${this.path}/setup-backend.sh`;
        const pythonBin = `${GLib.get_home_dir()}/.local/share/depth-clock/venv/bin/python3`;
        const modelPath = `${GLib.get_home_dir()}/.local/share/depth-clock/models/rmbg-1.4.onnx`;

        const checkBackendInstalled = () => {
            if (!GLib.file_test(pythonBin, GLib.FileTest.EXISTS))
                return false;
            if (!GLib.file_test(modelPath, GLib.FileTest.EXISTS))
                return false;
            try {
                const info = Gio.File.new_for_path(modelPath).query_info(
                    Gio.FILE_ATTRIBUTE_STANDARD_SIZE,
                    Gio.FileQueryInfoFlags.NONE,
                    null
                );
                return info.get_size() >= 150000000;
            } catch (e) {
                return false;
            }
        };

        const backendRow = new Adw.ActionRow({
            title: _('AI Model Status'),
        });
        modeGroup.add(backendRow);

        const setupButton = new Gtk.Button({
            valign: Gtk.Align.CENTER,
        });
        backendRow.add_suffix(setupButton);

        const spinner = new Gtk.Spinner({
            valign: Gtk.Align.CENTER,
            visible: false,
        });
        backendRow.add_suffix(spinner);

        const updateBackendUI = (isInstalled) => {
            if (isInstalled) {
                backendRow.subtitle = _('RMBG-1.4 model ready (~176 MB)');
                setupButton.label = _('Reinstall');
                setupButton.remove_css_class('suggested-action');
                setupButton.sensitive = true;
                spinner.visible = false;
                spinner.spinning = false;
            } else {
                backendRow.subtitle = _('Model not installed. Download required for depth effect (~176 MB).');
                setupButton.label = _('Download & Set Up');
                setupButton.add_css_class('suggested-action');
                setupButton.sensitive = true;
                spinner.visible = false;
                spinner.spinning = false;
            }
        };

        updateBackendUI(checkBackendInstalled());

        setupButton.connect('clicked', () => {
            setupButton.sensitive = false;
            spinner.visible = true;
            spinner.spinning = true;
            backendRow.subtitle = _('Setting up AI backend (this may take 1-2 minutes)...');

            try {
                const proc = Gio.Subprocess.new(
                    ['/usr/bin/bash', setupScript, '--install'],
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
                );

                proc.communicate_utf8_async(null, null, (source, res) => {
                    try {
                        const [, stdout, stderr] = source.communicate_utf8_finish(res);
                        if (source.get_successful()) {
                            updateBackendUI(true);
                            const current = settings.get_boolean('enable-depth');
                            settings.set_boolean('enable-depth', !current);
                            settings.set_boolean('enable-depth', current);
                        } else {
                            const errMatch = (stderr || stdout || '').match(/\[ERROR\]\s*(.*)/);
                            const errMsg = errMatch ? errMatch[1] : _('Installation failed');
                            backendRow.subtitle = errMsg;
                            setupButton.sensitive = true;
                            spinner.visible = false;
                            spinner.spinning = false;
                        }
                    } catch (err) {
                        backendRow.subtitle = `${err}`;
                        setupButton.sensitive = true;
                        spinner.visible = false;
                        spinner.spinning = false;
                    }
                });
            } catch (e) {
                backendRow.subtitle = `${e}`;
                setupButton.sensitive = true;
                spinner.visible = false;
                spinner.spinning = false;
            }
        });

        // Group: Appearance
        const appearGroup = new Adw.PreferencesGroup({
            title: _('Appearance'),
            description: _('Customize font, size, and layout'),
        });
        page.add(appearGroup);

        // Font Selector
        const currentFont = settings.get_string('clock-font') || 'Antonio';
        const fontDesc = Pango.FontDescription.from_string(currentFont);
        fontDesc.unset_fields(Pango.FontMask.SIZE);

        const fontRow = new Adw.ActionRow({
            title: _('Font Family'),
            subtitle: currentFont,
        });

        const fontDialog = new Gtk.FontDialog({ modal: true });
        const fontButton = new Gtk.FontDialogButton({
            dialog: fontDialog,
            font_desc: fontDesc,
            use_font: true,
            use_size: false,
            valign: Gtk.Align.CENTER,
        });

        fontButton.connect('notify::font-desc', () => {
            const desc = fontButton.get_font_desc();
            if (!desc) return;
            desc.unset_fields(Pango.FontMask.SIZE);
            const fontName = desc.to_string();
            fontRow.subtitle = fontName;
            settings.set_string('clock-font', fontName);
        });

        settings.connect('changed::clock-font', () => {
            const val = settings.get_string('clock-font');
            fontRow.subtitle = val;
            const updatedDesc = Pango.FontDescription.from_string(val);
            updatedDesc.unset_fields(Pango.FontMask.SIZE);
            fontButton.set_font_desc(updatedDesc);
        });

        fontRow.add_suffix(fontButton);
        fontRow.activatable_widget = fontButton;
        appearGroup.add(fontRow);

        // Adaptive Wallpaper Color
        const autoColorRow = new Adw.SwitchRow({
            title: _('Adaptive Wallpaper Color'),
            subtitle: _('Automatically adjust clock color to harmonize with current wallpaper'),
        });
        settings.bind('auto-color', autoColorRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        appearGroup.add(autoColorRow);

        // Text Color Selector
        const currentColor = settings.get_string('clock-color') || '#dce9f8';
        const rgba = new Gdk.RGBA();
        if (!rgba.parse(currentColor))
            rgba.parse('#dce9f8');

        const colorRow = new Adw.ActionRow({
            title: _('Text Color'),
            subtitle: currentColor,
        });

        const colorDialog = new Gtk.ColorDialog({
            modal: true,
            with_alpha: false,
        });
        const colorButton = new Gtk.ColorDialogButton({
            dialog: colorDialog,
            rgba: rgba,
            valign: Gtk.Align.CENTER,
        });

        const toHex = (n) => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, '0');

        const syncColorState = () => {
            const isAuto = settings.get_boolean('auto-color');
            colorButton.sensitive = !isAuto;
            const val = settings.get_string('clock-color');
            colorRow.subtitle = isAuto ? `${val} (Auto)` : val;
        };

        colorButton.connect('notify::rgba', () => {
            const c = colorButton.get_rgba();
            const hex = `#${toHex(c.red)}${toHex(c.green)}${toHex(c.blue)}`;
            settings.set_string('clock-color', hex);
            syncColorState();
        });

        settings.connect('changed::clock-color', () => {
            const val = settings.get_string('clock-color');
            const updatedRgba = new Gdk.RGBA();
            if (updatedRgba.parse(val))
                colorButton.set_rgba(updatedRgba);
            syncColorState();
        });

        settings.connect('changed::auto-color', () => {
            syncColorState();
        });

        colorRow.add_suffix(colorButton);
        colorRow.activatable_widget = colorButton;
        appearGroup.add(colorRow);

        syncColorState();

        // Scale
        const scaleRow = new Adw.SpinRow({
            title: _('Scale Factor'),
            subtitle: _('Can also be adjusted by scrolling over the clock on desktop'),
            adjustment: new Gtk.Adjustment({
                lower: 0.3,
                upper: 3.0,
                step_increment: 0.05,
                page_increment: 0.1,
                value: settings.get_double('clock-scale'),
            }),
            digits: 2,
        });
        scaleRow.connect('notify::value', (spin) => {
            settings.set_double('clock-scale', spin.get_value());
        });
        appearGroup.add(scaleRow);

        // Opacity
        const opacityRow = new Adw.SpinRow({
            title: _('Opacity'),
            adjustment: new Gtk.Adjustment({
                lower: 0.1,
                upper: 1.0,
                step_increment: 0.05,
                page_increment: 0.1,
                value: settings.get_double('clock-opacity'),
            }),
            digits: 2,
        });
        opacityRow.connect('notify::value', (spin) => {
            settings.set_double('clock-opacity', spin.get_value());
        });
        appearGroup.add(opacityRow);

        // Stacked Digits
        stackRow = new Adw.SwitchRow({
            title: _('Stack Hours and Minutes'),
            subtitle: _('Display hour on top and minute below instead of single row'),
        });
        settings.bind('stack-digits', stackRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        appearGroup.add(stackRow);

        updateModeUI();

        // Group: Position
        const posGroup = new Adw.PreferencesGroup({
            title: _('Position'),
            description: _('Fine-tune clock placement on the desktop (or click & drag directly on desktop)'),
        });
        page.add(posGroup);

        // Horizontal Position
        const posXRow = new Adw.SpinRow({
            title: _('Horizontal Position (%)'),
            subtitle: _('0% = Left edge, 50% = Centered, 100% = Right edge'),
            adjustment: new Gtk.Adjustment({
                lower: 0.0,
                upper: 100.0,
                step_increment: 1.0,
                page_increment: 5.0,
                value: Math.round(settings.get_double('clock-x') * 100),
            }),
            digits: 0,
        });
        posXRow.connect('notify::value', (spin) => {
            settings.set_double('clock-x', spin.get_value() / 100.0);
        });
        posGroup.add(posXRow);

        // Vertical Position
        const posYRow = new Adw.SpinRow({
            title: _('Vertical Position (%)'),
            subtitle: _('0% = Top edge, 28% = Default, 100% = Bottom edge'),
            adjustment: new Gtk.Adjustment({
                lower: 0.0,
                upper: 100.0,
                step_increment: 1.0,
                page_increment: 5.0,
                value: Math.round(settings.get_double('clock-y') * 100),
            }),
            digits: 0,
        });
        posYRow.connect('notify::value', (spin) => {
            settings.set_double('clock-y', spin.get_value() / 100.0);
        });
        posGroup.add(posYRow);

        // Group: Time & Date
        const timeGroup = new Adw.PreferencesGroup({
            title: _('Time & Date'),
        });
        page.add(timeGroup);

        const format24Row = new Adw.SwitchRow({
            title: _('24-Hour Time Format'),
        });
        settings.bind('time-format-24h', format24Row, 'active', Gio.SettingsBindFlags.DEFAULT);
        timeGroup.add(format24Row);

        const dateRow = new Adw.SwitchRow({
            title: _('Show Date'),
        });
        settings.bind('show-date', dateRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        timeGroup.add(dateRow);
    }
}
