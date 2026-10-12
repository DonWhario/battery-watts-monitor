'use strict';

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

// ---------------------------------------------------------------------------
// Constantes de UPower
// ---------------------------------------------------------------------------
const UP_STATE = {
    UNKNOWN: 0,
    CHARGING: 1,
    DISCHARGING: 2,
    EMPTY: 3,
    FULLY_CHARGED: 4,
    PENDING_CHARGE: 5,
    PENDING_DISCHARGE: 6,
};

const UPOWER_BUS = 'org.freedesktop.UPower';
const UPOWER_DEV_IFACE = 'org.freedesktop.UPower.Device';

const PP_BUS = 'net.hadess.PowerProfiles';
const PP_PATH = '/net/hadess/PowerProfiles';
const PP_IFACE = 'net.hadess.PowerProfiles';

const PROPS_IFACE = 'org.freedesktop.DBus.Properties';

// Nombres legibles para los modos de energía.
// Nota: no se usa gettext aquí porque estas constantes se evalúan al cargar
// el módulo, y _() solo puede llamarse en tiempo de ejecución.
const PROFILE_LABELS = {
    'performance': 'Rendimiento',
    'balanced': 'Equilibrado',
    'power-saver': 'Ahorro de energía',
};

// Nombres legibles para la protección de carga (charge_types de sysfs)
const CHARGE_TYPE_LABELS = {
    'Fast': 'Rápida (sin límite)',
    'Standard': 'Estándar',
    'Long_Life': 'Larga vida (limita la carga)',
    'Adaptive': 'Adaptativa',
    'Custom': 'Personalizada',
};

// ---------------------------------------------------------------------------
// Utilidades sysfs
// ---------------------------------------------------------------------------
function findBatteryPath() {
    const base = '/sys/class/power_supply';
    try {
        const dir = Gio.File.new_for_path(base);
        const en = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = en.next_file(null)) !== null) {
            const name = info.get_name();
            if (name.startsWith('BAT'))
                return `${base}/${name}`;
        }
    } catch (_e) {}
    return null;
}

function readSysfs(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        if (ok)
            return new TextDecoder().decode(bytes).trim();
    } catch (_e) {}
    return null;
}

function fileExists(path) {
    return GLib.file_test(path, GLib.FileTest.EXISTS);
}

// ---------------------------------------------------------------------------
// Área de dibujo del gráfico de consumo (Cairo)
// ---------------------------------------------------------------------------
const GraphArea = GObject.registerClass(
class GraphArea extends St.DrawingArea {
    _init() {
        super._init({
            style_class: 'bwm-graph',
            x_expand: true,
            height: 90,
        });
        this._data = [];
        this._maxSamples = 60;
        this.connect('repaint', this._onRepaint.bind(this));
    }

    setMaxSamples(n) {
        this._maxSamples = n;
        while (this._data.length > n)
            this._data.shift();
    }

    push(value) {
        this._data.push(value);
        while (this._data.length > this._maxSamples)
            this._data.shift();
        this.queue_repaint();
    }

    clear() {
        this._data = [];
        this.queue_repaint();
    }

    _onRepaint(area) {
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();
        const pad = 4;

        // Rejilla / fondo
        cr.setLineWidth(1);
        cr.setSourceRGBA(1, 1, 1, 0.08);
        for (let i = 1; i < 4; i++) {
            const y = pad + (height - 2 * pad) * i / 4;
            cr.moveTo(pad, y);
            cr.lineTo(width - pad, y);
        }
        cr.stroke();

        if (this._data.length < 2) {
            cr.$dispose();
            return;
        }

        const maxVal = Math.max(5, ...this._data) * 1.15;
        const n = this._data.length;
        const usableW = width - 2 * pad;
        const usableH = height - 2 * pad;
        const xStep = usableW / (this._maxSamples - 1);
        const x0 = width - pad - (n - 1) * xStep;

        const px = i => x0 + i * xStep;
        const py = v => pad + usableH - (v / maxVal) * usableH;

        // Relleno bajo la curva
        cr.moveTo(px(0), height - pad);
        for (let i = 0; i < n; i++)
            cr.lineTo(px(i), py(this._data[i]));
        cr.lineTo(px(n - 1), height - pad);
        cr.closePath();
        cr.setSourceRGBA(0.30, 0.68, 1.0, 0.20);
        cr.fill();

        // Línea de la curva
        cr.setLineWidth(2);
        cr.setSourceRGBA(0.30, 0.68, 1.0, 1.0);
        cr.moveTo(px(0), py(this._data[0]));
        for (let i = 1; i < n; i++)
            cr.lineTo(px(i), py(this._data[i]));
        cr.stroke();

        cr.$dispose();
    }
});

// ---------------------------------------------------------------------------
// Indicador principal del panel
// ---------------------------------------------------------------------------
const BatteryIndicator = GObject.registerClass(
class BatteryIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, _('Battery Watts Monitor'));
        this._extension = extension;
        this._settings = extension.getSettings();

        this._batPath = findBatteryPath();
        this._chargeProtection = this._detectChargeProtection();

        // --- Panel: icono + etiqueta ---
        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._icon = new St.Icon({
            icon_name: 'battery-full-symbolic',
            style_class: 'system-status-icon',
        });
        this._panelLabel = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'bwm-panel-label',
        });
        box.add_child(this._icon);
        box.add_child(this._panelLabel);
        this.add_child(box);

        this._buildMenu();
        this._connectUPower();

        // Refresco periódico
        this._refreshInterval = this._settings.get_int('refresh-interval');
        this._graph.setMaxSamples(this._settings.get_int('history-length'));
        this._startTimer();

        this._settingsChangedId = this._settings.connect('changed', () => {
            this._refreshInterval = this._settings.get_int('refresh-interval');
            this._graph.setMaxSamples(this._settings.get_int('history-length'));
            this._startTimer();
            this._syncSystemPowerIcon();
            this._update();
        });

        // Ocultar (o no) el indicador de energía nativo de GNOME
        this._systemPowerHidden = [];
        this._syncSystemPowerIcon();

        this._update();
    }

    // ----- Ocultar el icono de energía nativo de GNOME -----
    // Devuelve los actores del indicador de energía del panel (icono + %).
    _findSystemPowerActors() {
        const qs = Main.panel.statusArea.quickSettings;
        if (!qs || !qs._system)
            return [];
        const sys = qs._system;
        const actors = [];
        // Nombres usados por GNOME 45–48
        if (sys._indicator)
            actors.push(sys._indicator);
        if (sys._percentageLabel)
            actors.push(sys._percentageLabel);
        // Respaldo: si cambian los nombres internos, ocultamos los iconos/labels
        // que cuelgan directamente del contenedor de indicadores del sistema.
        if (actors.length === 0 && typeof sys.get_children === 'function') {
            for (const child of sys.get_children()) {
                if (child.constructor?.name === 'St_Icon' ||
                    child.constructor?.name === 'St_Label')
                    actors.push(child);
            }
        }
        // Volcado de depuración una sola vez (para verificar en el journal)
        if (!this._loggedPowerActors) {
            this._loggedPowerActors = true;
            const names = actors.map(a => a.constructor?.name).join(', ');
            log(`[BWM] indicador de energía nativo: ${actors.length} actor(es) [${names}]`);
        }
        return actors;
    }

    _syncSystemPowerIcon() {
        const hide = this._settings.get_boolean('hide-system-power-icon');
        if (hide)
            this._hideSystemPowerIcon();
        else
            this._restoreSystemPowerIcon();
    }

    _hideSystemPowerIcon() {
        if (this._systemPowerHidden.length > 0)
            return; // ya oculto
        for (const actor of this._findSystemPowerActors()) {
            // Guardamos estado y forzamos oculto incluso cuando GNOME haga _sync()
            const entry = {
                actor,
                wasVisible: actor.visible,
                notifyId: actor.connect('notify::visible', () => {
                    if (actor.visible)
                        actor.visible = false;
                }),
            };
            actor.visible = false;
            this._systemPowerHidden.push(entry);
        }
    }

    _restoreSystemPowerIcon() {
        for (const entry of this._systemPowerHidden) {
            if (entry.notifyId)
                entry.actor.disconnect(entry.notifyId);
            entry.actor.visible = entry.wasVisible;
        }
        this._systemPowerHidden = [];
    }

    // ----- Construcción del menú -----
    _buildMenu() {
        // Cabecera: estado grande
        this._headerLabel = new St.Label({
            text: '—',
            style_class: 'bwm-header',
            x_align: Clutter.ActorAlign.CENTER,
        });
        const headerItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        headerItem.add_child(this._headerLabel);
        this.menu.addMenuItem(headerItem);

        // Watts en grande + subtítulo
        this._wattsLabel = new St.Label({
            text: '— W',
            style_class: 'bwm-watts',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._subLabel = new St.Label({
            text: '',
            style_class: 'bwm-sub',
            x_align: Clutter.ActorAlign.CENTER,
        });
        const wattsBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        wattsBox.add_child(this._wattsLabel);
        wattsBox.add_child(this._subLabel);
        const wattsItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        wattsItem.add_child(wattsBox);
        this.menu.addMenuItem(wattsItem);

        // Gráfico
        this._graph = new GraphArea();
        const graphItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        graphItem.add_child(this._graph);
        this.menu.addMenuItem(graphItem);

        // Detalles (tiempo restante / carga, porcentaje)
        this._timeItem = new PopupMenu.PopupImageMenuItem(_('Calculando…'), 'preferences-system-time-symbolic', {reactive: false});
        this.menu.addMenuItem(this._timeItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // --- Modos de energía ---
        this._profileSection = new PopupMenu.PopupSubMenuMenuItem(_('Modo de energía'), true);
        this._profileSection.icon.icon_name = 'power-profile-balanced-symbolic';
        this.menu.addMenuItem(this._profileSection);
        this._profileItems = {};
        this._buildProfilesMenu();

        // --- Protección de carga ---
        if (this._chargeProtection) {
            this._protSection = new PopupMenu.PopupSubMenuMenuItem(_('Protección de carga'), true);
            this._protSection.icon.icon_name = 'battery-level-100-charged-symbolic';
            this.menu.addMenuItem(this._protSection);
            this._protItems = {};
            this._buildProtectionMenu();
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Ajustes
        const prefsItem = new PopupMenu.PopupMenuItem(_('Preferencias…'));
        prefsItem.connect('activate', () => this._extension.openPreferences());
        this.menu.addMenuItem(prefsItem);
    }

    // ----- Modos de energía (power-profiles-daemon) -----
    _buildProfilesMenu() {
        this._profileProxy = null;
        try {
            this._profileProxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
                PP_BUS, PP_PATH, PP_IFACE, null);
        } catch (_e) {
            this._profileProxy = null;
        }

        if (!this._profileProxy) {
            this._profileSection.menu.addMenuItem(
                new PopupMenu.PopupMenuItem(_('No disponible (power-profiles-daemon)'), {reactive: false}));
            return;
        }

        let profiles = [];
        try {
            const val = this._profileProxy.get_cached_property('Profiles');
            if (val) {
                for (const p of val.recursiveUnpack())
                    profiles.push(p['Profile']);
            }
        } catch (_e) {}
        if (profiles.length === 0)
            profiles = ['power-saver', 'balanced', 'performance'];

        for (const prof of profiles) {
            const label = PROFILE_LABELS[prof] || prof;
            const item = new PopupMenu.PopupMenuItem(label);
            item.connect('activate', () => this._setProfile(prof));
            this._profileSection.menu.addMenuItem(item);
            this._profileItems[prof] = item;
        }

        // Reaccionar a cambios externos del perfil
        this._profileProxy.connect('g-properties-changed', () => this._updateProfile());
    }

    _setProfile(prof) {
        try {
            this._profileProxy.set_cached_property('ActiveProfile', new GLib.Variant('s', prof));
            Gio.DBus.system.call(
                PP_BUS, PP_PATH, PROPS_IFACE, 'Set',
                new GLib.Variant('(ssv)', [PP_IFACE, 'ActiveProfile', new GLib.Variant('s', prof)]),
                null, Gio.DBusCallFlags.NONE, -1, null,
                (conn, res) => {
                    try { conn.call_finish(res); } catch (e) { logError(e); }
                    this._updateProfile();
                });
        } catch (e) {
            logError(e);
        }
    }

    _updateProfile() {
        if (!this._profileProxy)
            return;
        let active = null;
        try {
            const val = this._profileProxy.get_cached_property('ActiveProfile');
            if (val)
                active = val.unpack();
        } catch (_e) {}
        for (const [prof, item] of Object.entries(this._profileItems))
            item.setOrnament(prof === active ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        if (active) {
            const label = PROFILE_LABELS[active] || active;
            this._profileSection.label.text = `${_('Modo de energía')}: ${label}`;
            this._profileSection.icon.icon_name = `power-profile-${active}-symbolic`;
        }
    }

    // ----- Protección de carga -----
    _detectChargeProtection() {
        if (!this._batPath)
            return null;

        // 1) Umbral numérico charge_control_end_threshold (más común: Lenovo, etc.)
        const endPath = `${this._batPath}/charge_control_end_threshold`;
        if (fileExists(endPath)) {
            const startPath = `${this._batPath}/charge_control_start_threshold`;
            return {
                kind: 'threshold',
                endPath,
                startPath: fileExists(startPath) ? startPath : null,
            };
        }

        // 2) Modos enumerados charge_types (p. ej. Fast Standard [Long_Life])
        const typesPath = `${this._batPath}/charge_types`;
        if (fileExists(typesPath)) {
            const raw = readSysfs(typesPath);
            if (raw) {
                const options = raw.split(/\s+/).map(t => t.replace(/[[\]]/g, ''));
                return {kind: 'types', path: typesPath, options};
            }
        }
        return null;
    }

    _buildProtectionMenu() {
        const cp = this._chargeProtection;
        if (cp.kind === 'types') {
            for (const opt of cp.options) {
                const label = CHARGE_TYPE_LABELS[opt] || opt;
                const item = new PopupMenu.PopupMenuItem(label);
                item.connect('activate', () => this._writeChargeProtection(cp.path, opt));
                this._protSection.menu.addMenuItem(item);
                this._protItems[opt] = item;
            }
        } else if (cp.kind === 'threshold') {
            // Presets habituales de umbral de fin de carga
            const presets = [
                {label: _('Máximo (100%)'), value: 100},
                {label: _('Equilibrado (80%)'), value: 80},
                {label: _('Conservador (60%)'), value: 60},
            ];
            for (const p of presets) {
                const item = new PopupMenu.PopupMenuItem(`${p.label}`);
                item.connect('activate', () =>
                    this._writeChargeProtection(cp.endPath, String(p.value)));
                this._protSection.menu.addMenuItem(item);
                this._protItems[String(p.value)] = item;
            }
        }
    }

    // Escribe en sysfs vía pkexec (requiere privilegios de administrador)
    _writeChargeProtection(path, value) {
        const cmd = `echo '${value}' > '${path}'`;
        try {
            const proc = Gio.Subprocess.new(
                ['pkexec', 'sh', '-c', cmd],
                Gio.SubprocessFlags.STDERR_PIPE);
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    const [, , stderr] = p.communicate_utf8_finish(res);
                    if (p.get_exit_status() === 0) {
                        Main.notify(_('Protección de carga'),
                            `${_('Configuración aplicada')}: ${value}`);
                    } else {
                        Main.notify(_('Protección de carga'),
                            _('No se pudo aplicar (permiso denegado).'));
                        if (stderr)
                            log(`[BWM] pkexec: ${stderr}`);
                    }
                } catch (e) {
                    logError(e);
                }
                this._updateProtection();
            });
        } catch (e) {
            logError(e);
        }
    }

    _updateProtection() {
        const cp = this._chargeProtection;
        if (!cp || !this._protItems)
            return;
        if (cp.kind === 'types') {
            const raw = readSysfs(cp.path) || '';
            const m = raw.match(/\[([^\]]+)\]/);
            const current = m ? m[1] : null;
            for (const [opt, item] of Object.entries(this._protItems))
                item.setOrnament(opt === current ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
            if (current) {
                const label = CHARGE_TYPE_LABELS[current] || current;
                this._protSection.label.text = `${_('Protección de carga')}: ${label}`;
            }
        } else if (cp.kind === 'threshold') {
            const cur = readSysfs(cp.endPath);
            for (const [val, item] of Object.entries(this._protItems))
                item.setOrnament(val === cur ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
            if (cur)
                this._protSection.label.text = `${_('Protección de carga')}: ${cur}%`;
        }
    }

    // ----- UPower -----
    _connectUPower() {
        this._devProxy = null;
        try {
            this._devProxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
                UPOWER_BUS,
                '/org/freedesktop/UPower/devices/DisplayDevice',
                UPOWER_DEV_IFACE, null);
            // DisplayDevice agrega todas las baterías; si no hay energía,
            // caemos a la batería real detectada por sysfs vía UPower.
            if (!this._devProxy.get_cached_property('IsPresent') ||
                !this._devProxy.get_cached_property('IsPresent').unpack()) {
                this._devProxy = this._realBatteryProxy() || this._devProxy;
            }
        } catch (_e) {
            this._devProxy = this._realBatteryProxy();
        }
    }

    _realBatteryProxy() {
        try {
            const name = this._batPath ? this._batPath.split('/').pop() : 'BAT1';
            return Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
                UPOWER_BUS,
                `/org/freedesktop/UPower/devices/battery_${name}`,
                UPOWER_DEV_IFACE, null);
        } catch (_e) {
            return null;
        }
    }

    _upProp(name) {
        try {
            const v = this._devProxy.get_cached_property(name);
            return v ? v.unpack() : null;
        } catch (_e) {
            return null;
        }
    }

    // ----- Formato de tiempo -----
    _fmtTime(seconds) {
        if (!seconds || seconds <= 0)
            return null;
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        if (h > 0)
            return `${h} h ${m.toString().padStart(2, '0')} min`;
        return `${m} min`;
    }

    // ----- Actualización principal -----
    _update() {
        if (!this._devProxy)
            this._connectUPower();

        let state = this._upProp('State');
        let rate = this._upProp('EnergyRate');       // W
        let pct = this._upProp('Percentage');        // %
        let toEmpty = this._upProp('TimeToEmpty');   // s
        let toFull = this._upProp('TimeToFull');     // s

        // Respaldo desde sysfs si UPower no diera potencia
        if ((rate === null || rate === 0) && this._batPath) {
            const pw = readSysfs(`${this._batPath}/power_now`);
            if (pw !== null)
                rate = parseInt(pw, 10) / 1e6;
        }
        if (pct === null && this._batPath) {
            const c = readSysfs(`${this._batPath}/capacity`);
            if (c !== null)
                pct = parseInt(c, 10);
        }
        if (state === null && this._batPath) {
            const s = readSysfs(`${this._batPath}/status`);
            state = s === 'Charging' ? UP_STATE.CHARGING
                : s === 'Full' ? UP_STATE.FULLY_CHARGED
                : UP_STATE.DISCHARGING;
        }

        const charging = state === UP_STATE.CHARGING || state === UP_STATE.PENDING_CHARGE;
        const full = state === UP_STATE.FULLY_CHARGED;
        const w = rate !== null ? rate : 0;

        // --- Icono del panel ---
        if (charging)
            this._icon.icon_name = 'battery-full-charging-symbolic';
        else if (full)
            this._icon.icon_name = 'battery-full-charged-symbolic';
        else
            this._icon.icon_name = this._iconForLevel(pct);

        // --- Etiqueta del panel ---
        const parts = [];
        if (this._settings.get_boolean('show-watts-in-panel'))
            parts.push(`${w.toFixed(1)} W`);
        if (this._settings.get_boolean('show-percentage-in-panel') && pct !== null)
            parts.push(`${Math.round(pct)}%`);
        this._panelLabel.text = parts.join('  ');
        this._panelLabel.visible = parts.length > 0;

        // --- Cabecera del menú ---
        let stateText;
        if (charging)
            stateText = _('Cargando');
        else if (full)
            stateText = _('Cargada (enchufada)');
        else
            stateText = _('Con batería');
        if (pct !== null)
            stateText += ` · ${Math.round(pct)}%`;
        this._headerLabel.text = stateText;

        // --- Watts grande ---
        this._wattsLabel.text = `${w.toFixed(2)} W`;
        this._subLabel.text = charging
            ? _('Potencia de carga')
            : _('Consumo del sistema');

        // --- Gráfico ---
        this._graph.push(w);

        // --- Tiempo ---
        let timeText;
        if (charging) {
            const t = this._fmtTime(toFull);
            timeText = t
                ? `${_('Tiempo hasta carga completa')}: ${t}`
                : _('Calculando tiempo de carga…');
            this._timeItem.setIcon('battery-full-charging-symbolic');
        } else if (full) {
            timeText = _('Batería completa');
            this._timeItem.setIcon('battery-full-charged-symbolic');
        } else {
            const t = this._fmtTime(toEmpty);
            timeText = t
                ? `${_('Tiempo restante de batería')}: ${t}`
                : _('Calculando autonomía…');
            this._timeItem.setIcon('preferences-system-time-symbolic');
        }
        this._timeItem.label.text = timeText;

        // --- Submenús ---
        this._updateProfile();
        this._updateProtection();

        return GLib.SOURCE_CONTINUE;
    }

    _iconForLevel(pct) {
        if (pct === null)
            return 'battery-good-symbolic';
        if (pct >= 90) return 'battery-full-symbolic';
        if (pct >= 60) return 'battery-good-symbolic';
        if (pct >= 30) return 'battery-low-symbolic';
        if (pct >= 10) return 'battery-caution-symbolic';
        return 'battery-empty-symbolic';
    }

    _startTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, this._refreshInterval,
            () => this._update());
    }

    destroy() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        // Restaurar el icono de energía nativo de GNOME
        this._restoreSystemPowerIcon();
        this._devProxy = null;
        this._profileProxy = null;
        super.destroy();
    }
});

// ---------------------------------------------------------------------------
// Punto de entrada de la extensión
// ---------------------------------------------------------------------------
export default class BatteryWattsExtension extends Extension {
    enable() {
        this._indicator = new BatteryIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
