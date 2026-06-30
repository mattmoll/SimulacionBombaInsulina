"""
Métricas de Calidad de Servicio (QoS) sobre una corrida.

Se calculan sobre la glucemia real y(t) y se comparan con los objetivos del
Consenso Internacional sobre Tiempo en Rango (Diabetes Care, 2019) usados en el TP:

    TIR  (70-180 mg/dL)  > 70 %      Tiempo en rango
    TBR  (< 70 mg/dL)    < 4 %       Tiempo bajo rango
    TBR  (< 54 mg/dL)    < 1 %       Tiempo bajo rango severo
    TAR  (> 180 mg/dL)   < 25 %      Tiempo sobre rango
    TAR  (> 250 mg/dL)   < 5 %       Tiempo sobre rango severo
    CV   (coef. variación) <= 36 %   Variabilidad glucémica
"""

import numpy as np


# Objetivos (límite, sentido). sentido "<" => cumple si valor < límite.
OBJETIVOS = {
    "TIR_70_180": (70.0, ">"),
    "TBR_70": (4.0, "<"),
    "TBR_54": (1.0, "<"),
    "TAR_180": (25.0, "<"),
    "TAR_250": (5.0, "<"),
    "CV": (36.0, "<"),
}


def calcular(y, dt):
    """Devuelve un dict con los porcentajes QoS y si cada uno cumple el objetivo."""
    y = np.asarray(y, dtype=float)
    n = len(y)
    if n == 0:
        return {}

    def pct(mascara):
        return float(100.0 * np.count_nonzero(mascara) / n)

    media = float(np.mean(y))
    desvio = float(np.std(y))
    cv = (desvio / media * 100.0) if media != 0 else 0.0

    valores = {
        "TIR_70_180": pct((y >= 70.0) & (y <= 180.0)),
        "TBR_70": pct(y < 70.0),
        "TBR_54": pct(y < 54.0),
        "TAR_180": pct(y > 180.0),
        "TAR_250": pct(y > 250.0),
        "CV": cv,
        "media": media,
        "min": float(np.min(y)),
        "max": float(np.max(y)),
    }

    cumple = {}
    for clave, (limite, sentido) in OBJETIVOS.items():
        v = valores[clave]
        cumple[clave] = bool(v > limite) if sentido == ">" else bool(v < limite)

    return {"valores": valores, "cumple": cumple, "objetivos": OBJETIVOS}
