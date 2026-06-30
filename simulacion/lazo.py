"""
Integración del lazo cerrado en el tiempo y armado de escenarios.

La función principal es `simular(params, eventos)`: integra el lazo paso a paso
con un dt fino (p. ej. 1 min) y actualiza el control cada Ts (p. ej. 5 min),
exactamente como un equipo real. Devuelve todas las señales del diagrama de
bloques para graficarlas una debajo de la otra:

    r(t)   referencia / set point          (θi)
    y(t)   glucemia real                    (θ0)
    ym(t)  glucemia medida por el CGM       (señal de medición)
    e(t)   error = r - ym                   (señal de error)
    u(t)   tasa de insulina                 (salida del controlador)
    d(t)   perturbaciones                   (comida / ejercicio / estrés)

Las perturbaciones se cargan como "efecto sobre la glucemia en lazo abierto"
[mg/dL], que es lo intuitivo para el usuario, y se convierten internamente a la
unidad de la entrada de la planta [U/h-equivalente] dividiendo por Kp y con el
signo correcto (la comida sube la glucemia, el ejercicio la baja).
"""

import math
import numpy as np

from .modelo import Planta, SensorCGM, actuador
from .controlador import PID
from . import metricas


# -----------------------------------------------------------------------------
# Perfiles temporales de las perturbaciones (en "efecto mg/dL sobre la glucemia")
# -----------------------------------------------------------------------------
def _bump_coseno(t, t0, dur, pico):
    """Pulso suave (coseno alzado): 0 -> pico -> 0 sobre [t0, t0+dur]."""
    if dur <= 0 or t < t0 or t > t0 + dur:
        return 0.0
    return pico * 0.5 * (1.0 - math.cos(2.0 * math.pi * (t - t0) / dur))


def _meseta(t, t0, dur, nivel):
    """Trapecio: rampa de subida, meseta y rampa de bajada sobre [t0, t0+dur]."""
    if dur <= 0 or t < t0 or t > t0 + dur:
        return 0.0
    rampa = dur * 0.25
    if t < t0 + rampa:
        return nivel * (t - t0) / rampa
    if t > t0 + dur - rampa:
        return nivel * (t0 + dur - t) / rampa
    return nivel


def _construir_referencia_y_perturbacion(eventos, n, dt, Kp, r0):
    """Arma r(t) [mg/dL] y d(t) [U/h-equiv] + efecto en mg/dL, a partir de los eventos."""
    r_arr = np.full(n, float(r0))
    efecto_arr = np.zeros(n)  # efecto neto de las perturbaciones sobre la glucemia [mg/dL]

    for ev in eventos:
        tipo = ev.get("tipo")
        t0 = float(ev.get("t_ini_h", 0.0)) * 60.0   # hora de inicio -> minutos
        dur = float(ev.get("dur_min", 0.0))          # duración [min]
        mag = float(ev.get("mag", 0.0))              # magnitud (ver cada tipo)

        if tipo == "escalon_sp":
            # Cambio permanente de la consigna a partir de t0 (mag en mg/dL, con signo).
            i0 = int(round(t0 / dt))
            r_arr[i0:] = r0 + mag
            continue

        for i in range(n):
            t = i * dt
            if tipo == "comida":
                efecto_arr[i] += _bump_coseno(t, t0, dur, +abs(mag))   # sube glucemia
            elif tipo == "ejercicio":
                efecto_arr[i] += _bump_coseno(t, t0, dur, -abs(mag))   # baja glucemia
            elif tipo == "estres":
                efecto_arr[i] += _meseta(t, t0, dur, +abs(mag))        # sube sostenido

    # d(t) en la entrada de la planta [U/h-equiv]: -Kp·d = efecto  =>  d = -efecto/Kp
    d_arr = -efecto_arr / Kp
    return r_arr, d_arr, efecto_arr


# -----------------------------------------------------------------------------
# Simulación principal
# -----------------------------------------------------------------------------
def simular(params, eventos=None):
    eventos = eventos or []
    p = _defaults()
    p.update(params or {})

    dt = float(p["dt"])
    Ts = float(p["Ts"])
    T_total = float(p["T_horas"]) * 60.0
    n = int(round(T_total / dt)) + 1
    k_ctrl = max(int(round(Ts / dt)), 1)

    Kp = float(p["Kp"])
    r0 = float(p["r0"])
    G0 = float(p["G0"])
    y0 = float(p["y0"]) if p["y0"] is not None else r0

    # Insulina basal del punto de operación: la que mantiene y0 en régimen.
    u_basal = max((G0 - r0) / Kp, 0.0)

    r_arr, d_arr, efecto_arr = _construir_referencia_y_perturbacion(
        eventos, n, dt, Kp, r0)

    rng = np.random.default_rng(int(p["semilla"])) if p["ruido_sigma"] > 0 else None

    planta = Planta(Kp=Kp, tau=float(p["tau"]), theta=float(p["theta"]),
                    G0=G0, dt=dt, y0=y0)
    sensor = SensorCGM(Ks=float(p["Ks"]), tau_s=float(p["tau_s"]), dt=dt, y0=y0,
                       ruido_sigma=float(p["ruido_sigma"]), rng=rng)
    pid = PID(Kc=float(p["Kc"]), Ti=float(p["Ti"]), Td=float(p["Td"]), Ts=Ts,
              u_min=float(p["u_min"]), u_max=float(p["u_max"]),
              u_res=float(p["u_res"]), u_basal=u_basal, iob_max=float(p["iob_max"]))

    # Arrays de salida.
    t_h = np.arange(n) * dt / 60.0
    y_out = np.zeros(n)
    ym_out = np.zeros(n)
    u_out = np.zeros(n)
    e_out = np.zeros(n)

    # Medición inicial para el primer cálculo del control.
    ym = sensor.Ks * y0
    u = u_basal

    for i in range(n):
        r = r_arr[i]

        # Actualización del control cada Ts (retención entre actualizaciones).
        if i % k_ctrl == 0:
            u = pid.actualizar(r, ym)

        # Entrada a la planta: insulina (a través del actuador) + perturbación.
        p_entrada = actuador(u, Ka=float(p["Ka"])) + d_arr[i]

        y = planta.paso(p_entrada)
        ym, _ = sensor.paso(y)

        y_out[i] = y
        ym_out[i] = ym
        u_out[i] = u
        e_out[i] = r - ym

    qos = metricas.calcular(y_out, dt)

    return {
        "t_h": t_h.tolist(),
        "r": r_arr.tolist(),
        "y": y_out.tolist(),
        "ym": ym_out.tolist(),
        "e": e_out.tolist(),
        "u": u_out.tolist(),
        "d_efecto": efecto_arr.tolist(),   # efecto de la perturbación [mg/dL]
        "u_basal": u_basal,
        "qos": qos,
        "params": p,
    }


def _defaults():
    """Parámetros por defecto (todos editables desde el panel)."""
    return {
        # Referencia y punto de operación
        "r0": 100.0,        # set point [mg/dL]
        "y0": None,         # glucemia inicial [mg/dL]; None => arranca en r0
        "G0": 180.0,        # glucemia endógena en lazo abierto [mg/dL]
        # Planta FOPDT
        "Kp": 36.0, "tau": 70.0, "theta": 20.0,
        # Sensor CGM
        "Ks": 1.0, "tau_s": 5.0, "ruido_sigma": 0.0, "semilla": 7,
        # Actuador
        "Ka": 1.0,
        # Controlador PID
        "Kc": 0.05, "Ti": 80.0, "Td": 20.0,
        # Saturación / IOB de la bomba
        "u_min": 0.0, "u_max": 10.0, "u_res": 0.01, "iob_max": 6.0,
        # Tiempos de simulación
        "Ts": 5.0, "dt": 1.0, "T_horas": 24.0,
    }
