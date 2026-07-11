"""
Controlador PID discreto de la bomba de insulina.

Ley de control (forma estándar del TP):

    Gc(s) = Kc · ( 1 + 1/(Ti·s) + Td·s )

Implementación digital, equivalente a un equipo real:
    * Se actualiza cada Ts minutos (muestreo del sensor / actualización del control).
    * Entre actualizaciones la salida se mantiene (retención de orden cero, ZOH).
    * Saturación de la insulina u(t) a [u_min, u_max] y cuantización a la resolución
      de dosificación de la bomba.
    * Anti-windup por clamping: cuando la salida satura no se sigue acumulando el
      término integral (evita la sobredosis por acumulación).
    * Tope de Insulina a Bordo (IOB): limita la insulina por encima de la basal,
      protección extra contra la hipoglucemia.

El término derivativo se calcula sobre la MEDICIÓN (no sobre el error) para evitar
el "derivative kick" ante un escalón de la referencia.

Nota de signo: la planta tiene ganancia negativa (la insulina BAJA la glucemia),
por lo que para que la realimentación sea negativa (estabilizante) el control
actúa sobre la desviación  desv = ym - r  (glucemia por encima de la consigna ->
más insulina). El "error" e = r - ym del TP se sigue reportando para graficarlo,
pero la acción de control se calcula sobre desv = -e.
"""


class PID:
    def __init__(self, Kc, Ti, Td, Ts,
                 u_min=0.0, u_max=10.0, u_res=0.01,
                 u_basal=0.0, iob_max=6.0):
        self.Kc = Kc
        self.Ti = Ti
        self.Td = Td
        self.Ts = Ts                # período de actualización del control [min]
        self.u_min = u_min
        self.u_max = u_max
        self.u_res = u_res
        self.u_basal = u_basal      # insulina basal del punto de operación [U/h]
        self.iob_max = iob_max      # insulina máx. por encima de la basal [U/h]

        # Integral cebada para arrancar en la basal con error nulo:
        #   u = Kc·(e + integ/Ti + ...)  ->  con e=0 queremos u = u_basal.
        # Con Ti = 0 se ANULA la acción integral (queda un control P o PD, que
        # deja error en estado estable: es justamente lo que se quiere mostrar).
        self.integ = (u_basal / Kc) * Ti if (Kc != 0 and Ti > 0) else 0.0
        self.ym_prev = None
        self.u = u_basal            # última salida retenida (ZOH)

    def _termino_integral(self):
        """Aporte del término integral (0 si la acción integral está anulada)."""
        return self.integ / self.Ti if self.Ti > 0 else 0.0

    def _saturar(self, u):
        """Aplica tope IOB, saturación física y cuantización de la bomba."""
        u_tope = self.u_basal + self.iob_max          # tope por IOB
        u = min(u, u_tope)
        u = max(self.u_min, min(self.u_max, u))       # saturación física
        if self.u_res > 0:                            # cuantización (micro-pasos)
            u = round(u / self.u_res) * self.u_res
        return u

    def actualizar(self, r, ym):
        """Calcula una nueva salida de control a partir de la referencia y la medición."""
        # Desviación con el signo correcto para el actuador (insulina baja glucemia):
        # glucemia por encima de la consigna (ym > r) => más insulina.
        desv = ym - r

        # Derivada sobre la medición: con r constante d(desv)/dt = d(ym)/dt.
        # Si la glucemia sube rápido (tras una comida) el término derivativo se
        # anticipa y agrega insulina antes de que el valor se vuelva peligroso.
        if self.ym_prev is None:
            deriv = 0.0
        else:
            deriv = (ym - self.ym_prev) / self.Ts
        self.ym_prev = ym

        # Salida tentativa con la integral actual (todavía sin integrar este paso).
        u_tentativa = self.Kc * (desv + self._termino_integral() + self.Td * deriv)
        u_sat = self._saturar(u_tentativa)

        # Anti-windup por clamping: solo se acumula la integral si la salida NO
        # está saturada, o si la nueva desviación tiende a sacarla de la saturación.
        satura_arriba = u_tentativa > u_sat
        satura_abajo = u_tentativa < u_sat
        if self.Ti > 0 and not (satura_arriba and desv > 0) and not (satura_abajo and desv < 0):
            self.integ += desv * self.Ts

        # Salida definitiva recalculada con la integral ya actualizada.
        u_final = self.Kc * (desv + self._termino_integral() + self.Td * deriv)
        self.u = self._saturar(u_final)
        return self.u
