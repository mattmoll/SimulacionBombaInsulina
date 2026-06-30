"""
Bloques físicos del lazo (planta, sensor y actuador).

Cada bloque se modela como en el TP, en el dominio del tiempo, para poder
integrarlo paso a paso. El tiempo se maneja en MINUTOS en todo el proyecto.

    Planta (glucosa-insulina):   Gp(s) = -Kp * e^(-θ·s) / (τ·s + 1)   (FOPDT)
    Sensor CGM:                  H(s)  =  Ks / (τs·s + 1)
    Actuador (bomba):            Ga(s) =  Ka  (ganancia pura, dinámica despreciable)

El retardo θ de la planta NO se aproxima: se implementa con un buffer de retardo
real (clase BufferRetardo), tal como pide la consigna.
"""

from collections import deque


class BufferRetardo:
    """Línea de retardo de tiempo muerto θ.

    Guarda los últimos valores de la señal de entrada a la planta y devuelve el
    valor que ocurrió hace θ minutos. Implementa el e^(-θ·s) de forma exacta a
    nivel de la grilla de integración (sin aproximación de Padé).
    """

    def __init__(self, theta_min, dt_min, valor_inicial=0.0):
        # Cantidad de pasos de retardo (θ expresado en cantidad de muestras de dt).
        self.n = max(int(round(theta_min / dt_min)), 0)
        # La cola arranca llena con el valor de equilibrio inicial.
        self.cola = deque([valor_inicial] * (self.n + 1), maxlen=self.n + 1)

    def paso(self, valor_actual):
        """Inyecta la entrada actual y devuelve la de hace θ minutos."""
        self.cola.append(valor_actual)
        return self.cola[0]


class Planta:
    """Dinámica glucosa-insulina como sistema de primer orden con retardo (FOPDT).

    ED en términos absolutos de glucemia (mg/dL):

        τ · dy/dt + y = G0 - Kp · p(t - θ)

    donde:
        y(t) : glucemia real [mg/dL]
        p(t) : señal en la entrada de la planta [U/h-equivalente] = insulina u(t)
               sumada a la perturbación d(t) (mismo sumador, como en el diagrama).
        G0   : glucemia endógena en lazo abierto (producción hepática basal). Sin
               insulina ni control, la glucemia tendería a G0 (hiperglucemia).
        Kp   : ganancia estática (cuánto baja la glucemia por U/h de insulina).
        τ    : constante de tiempo del proceso.
        θ    : tiempo muerto (transporte intersticial + inicio de acción).

    El signo negativo de Kp refleja que más insulina BAJA la glucemia.
    """

    def __init__(self, Kp, tau, theta, G0, dt, y0):
        self.Kp = Kp
        self.tau = tau
        self.G0 = G0
        self.dt = dt
        self.y = y0  # estado: glucemia actual [mg/dL]
        # El buffer arranca en el valor de insulina basal que mantiene y0 en régimen.
        p_basal = (G0 - y0) / Kp
        self.retardo = BufferRetardo(theta, dt, valor_inicial=p_basal)

    def paso(self, p_entrada):
        """Avanza la glucemia un paso dt dado p(t) = u(t) + d(t) [U/h-equiv]."""
        p_retardada = self.retardo.paso(p_entrada)
        dydt = (self.G0 - self.Kp * p_retardada - self.y) / self.tau
        self.y += self.dt * dydt
        return self.y


class SensorCGM:
    """Sensor de glucosa continuo (CGM): primer orden con ganancia unitaria.

        τs · dym/dt + ym = Ks · y

    Aporta el retardo secundario del filtrado del transmisor (τs ≈ 5 min) y,
    opcionalmente, ruido de medición gaussiano.
    """

    def __init__(self, Ks, tau_s, dt, y0, ruido_sigma=0.0, rng=None):
        self.Ks = Ks
        self.tau_s = tau_s
        self.dt = dt
        self.ym = Ks * y0  # estado: medición filtrada (sin ruido)
        self.ruido_sigma = ruido_sigma
        self.rng = rng

    def paso(self, y):
        """Avanza la medición y devuelve (ym_con_ruido, ym_limpia)."""
        dymdt = (self.Ks * y - self.ym) / self.tau_s
        self.ym += self.dt * dymdt
        if self.ruido_sigma > 0.0 and self.rng is not None:
            return self.ym + self.rng.normal(0.0, self.ruido_sigma), self.ym
        return self.ym, self.ym


def actuador(comando, Ka=1.0):
    """Actuador (bomba): ganancia pura Ga = Ka. Traduce el comando a U/h."""
    return Ka * comando
