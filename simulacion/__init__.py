"""
Paquete de simulación del lazo de control de la bomba de insulina.

Módulos:
    modelo       -> bloques físicos: planta FOPDT con retardo, sensor CGM, actuador.
    controlador  -> PID discreto con saturación y anti-windup / IOB.
    lazo         -> integra el lazo cerrado en el tiempo y arma los escenarios.
    metricas     -> métricas de Calidad de Servicio (TIR / TBR / TAR / CV).

TP Integrador de Teoría de Control - UTN-FRBA - K4011 - 2026.
Tema: Bomba de insulina (lazo cerrado de regulación de glucemia).
"""

from . import modelo, controlador, lazo, metricas  # noqa: F401
