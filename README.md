# Battery Watts Monitor

Extensión de GNOME Shell que muestra el **consumo del sistema en vatios (W)** tomando como
referencia el flujo de energía de la batería, con un gráfico en tiempo real y controles de
energía integrados en el panel superior.

![GNOME Shell 45–48](https://img.shields.io/badge/GNOME%20Shell-45%E2%80%9348-4A86CF)
![Licencia GPL-3.0](https://img.shields.io/badge/licencia-GPL--3.0-blue)

## Características

- **Consumo en W en el panel** superior, junto a un icono que cambia según el estado:
  rayo de carga cuando está enchufado, icono de batería cuando funciona con batería.
- **Gráfico en tiempo real** del consumo (o de la potencia de carga) al abrir el menú.
- **Tiempo estimado**: hasta la carga completa cuando está enchufado, o autonomía restante
  cuando funciona con batería (mediante UPower).
- **Modos de energía**: cambia entre Rendimiento / Equilibrado / Ahorro de energía
  (vía `power-profiles-daemon`).
- **Protección de carga de la batería**: ajusta las configuraciones disponibles en tu
  equipo. Detecta automáticamente:
  - un umbral numérico de fin de carga (`charge_control_end_threshold`), o
  - los modos enumerados del firmware (`charge_types`, p. ej. Rápida / Estándar / Larga vida).
- Opción para **ocultar el icono de energía nativo de GNOME** y no ver dos indicadores.

## Requisitos

- GNOME Shell 45 a 48.
- Una batería que exponga datos en `/sys/class/power_supply/BAT*`.
- `power-profiles-daemon` para el selector de modos de energía (opcional).
- `pkexec` (Polkit) para aplicar la protección de carga, ya que requiere escribir en `/sys`
  como administrador.

## Instalación (desde el código fuente)

```bash
UUID="battery-watts-monitor@felipe.abarca"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
git clone https://github.com/DonWhario/battery-watts-monitor.git "$DEST"
# Compilar el esquema de configuración
glib-compile-schemas "$DEST/schemas"
```

Después reinicia GNOME Shell:

- **X11**: `Alt` + `F2`, escribe `r` y pulsa `Enter`.
- **Wayland**: cierra la sesión y vuelve a iniciarla.

Y activa la extensión:

```bash
gnome-extensions enable battery-watts-monitor@felipe.abarca
```

## Configuración

Abre las preferencias desde la app *Extensiones* o desde el propio menú de la extensión
(*Preferencias…*). Puedes ajustar el intervalo de actualización, el número de muestras del
gráfico, qué mostrar en el panel y si ocultar el icono nativo de GNOME.

## Nota sobre la protección de carga

Cambiar la protección de carga escribe en `/sys/class/power_supply/BAT*`, lo que exige
privilegios de administrador. La extensión usa `pkexec`, por lo que **pedirá la contraseña**
cada vez que cambies esa opción. Es un comportamiento esperado.

## Licencia

[GPL-3.0-or-later](LICENSE).
