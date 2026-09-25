'use strict';

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const BIND = Gio.SettingsBindFlags.DEFAULT;

export default class BatteryWattsPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'battery-full-symbolic',
        });
        window.add(page);

        // --- Grupo: Panel ---
        const panelGroup = new Adw.PreferencesGroup({
            title: _('Panel superior'),
            description: _('Qué mostrar junto al icono en la barra superior'),
        });
        page.add(panelGroup);

        const wattsRow = new Adw.SwitchRow({
            title: _('Mostrar consumo en W'),
            subtitle: _('Muestra los vatios actuales junto al icono'),
        });
        settings.bind('show-watts-in-panel', wattsRow, 'active', BIND);
        panelGroup.add(wattsRow);

        const pctRow = new Adw.SwitchRow({
            title: _('Mostrar porcentaje'),
            subtitle: _('Añade el porcentaje de batería en el panel'),
        });
        settings.bind('show-percentage-in-panel', pctRow, 'active', BIND);
        panelGroup.add(pctRow);

        const hideRow = new Adw.SwitchRow({
            title: _('Ocultar el icono de energía de GNOME'),
            subtitle: _('Evita ver dos indicadores de batería a la vez'),
        });
        settings.bind('hide-system-power-icon', hideRow, 'active', BIND);
        panelGroup.add(hideRow);

        // --- Grupo: Gráfico y refresco ---
        const graphGroup = new Adw.PreferencesGroup({
            title: _('Gráfico y actualización'),
        });
        page.add(graphGroup);

        const intervalRow = new Adw.SpinRow({
            title: _('Intervalo de actualización'),
            subtitle: _('Cada cuántos segundos se leen los datos'),
            adjustment: new Gtk.Adjustment({
                lower: 1, upper: 30, step_increment: 1, page_increment: 5,
            }),
        });
        settings.bind('refresh-interval', intervalRow, 'value', BIND);
        graphGroup.add(intervalRow);

        const historyRow = new Adw.SpinRow({
            title: _('Muestras del gráfico'),
            subtitle: _('Cuántos puntos mantiene el histórico de consumo'),
            adjustment: new Gtk.Adjustment({
                lower: 20, upper: 300, step_increment: 10, page_increment: 20,
            }),
        });
        settings.bind('history-length', historyRow, 'value', BIND);
        graphGroup.add(historyRow);

        // --- Grupo: Info ---
        const infoGroup = new Adw.PreferencesGroup({
            title: _('Protección de carga'),
        });
        page.add(infoGroup);
        infoGroup.add(new Adw.ActionRow({
            title: _('Requiere privilegios de administrador'),
            subtitle: _('Al cambiar la protección de carga se pedirá la contraseña (pkexec) para escribir en el sistema.'),
        }));
    }
}
