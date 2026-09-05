import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class DepthClockPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-desktop-wallpaper-symbolic',
        });
        window.add(page);

        // Group: Depth Effect
        const depthGroup = new Adw.PreferencesGroup({
            title: _('3D Depth Effect'),
            description: _('Place clock digits behind foreground objects in the wallpaper'),
        });
        page.add(depthGroup);

        const depthRow = new Adw.SwitchRow({
            title: _('Enable Depth Effect'),
            subtitle: _('Occlude clock text behind detected foreground subjects'),
        });
        settings.bind('enable-depth', depthRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        depthGroup.add(depthRow);

        const adaptRow = new Adw.SwitchRow({
            title: _('Auto-Adapt Legibility'),
            subtitle: _('Temporarily disable depth if foreground obscures more than 85% of time'),
        });
        settings.bind('auto-adapt', adaptRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        depthGroup.add(adaptRow);

        // Group: Appearance
        const appearGroup = new Adw.PreferencesGroup({
            title: _('Appearance'),
            description: _('Customize font, size, and layout'),
        });
        page.add(appearGroup);

        // Font
        const fontRow = new Adw.EntryRow({
            title: _('Font Family'),
            text: settings.get_string('clock-font'),
        });
        fontRow.connect('changed', (entry) => {
            const val = entry.get_text().trim();
            if (val.length > 0)
                settings.set_string('clock-font', val);
        });
        appearGroup.add(fontRow);

        // Text Color
        const colorRow = new Adw.EntryRow({
            title: _('Text Color (Hex)'),
            text: settings.get_string('clock-color'),
        });
        colorRow.connect('changed', (entry) => {
            const val = entry.get_text().trim();
            if (/^#[0-9a-fA-F]{6}$/.test(val))
                settings.set_string('clock-color', val);
        });
        appearGroup.add(colorRow);

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
        const stackRow = new Adw.SwitchRow({
            title: _('Stack Hours and Minutes'),
            subtitle: _('Display hour on top and minute below instead of single row'),
        });
        settings.bind('stack-digits', stackRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        appearGroup.add(stackRow);

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
