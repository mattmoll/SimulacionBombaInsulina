"use strict";

// Motor de simulación en tiempo real (lado del navegador).
// Espeja EXACTAMENTE el modelo de Python (simulacion/modelo.py, controlador.py,
// lazo.py): planta FOPDT con retardo real, sensor CGM de primer orden y PID
// discreto con saturación, anti-windup e IOB. Integra el lazo paso a paso (dt)
// para poder avanzar el reloj en vivo e inyectar perturbaciones en el instante.

// Ruido gaussiano (Box–Muller) para el sensor, si se usa.
let _gSpare = null;
function gauss() {
  if (_gSpare !== null) { const v = _gSpare; _gSpare = null; return v; }
  const u = Math.random() || 1e-9, w = Math.random();
  const r = Math.sqrt(-2 * Math.log(u));
  _gSpare = r * Math.sin(2 * Math.PI * w);
  return r * Math.cos(2 * Math.PI * w);
}

class SimVivo {
  constructor(p) {
    this.p = p;
    this.dt = p.dt;
    this.kCtrl = Math.max(Math.round(p.Ts / p.dt), 1);
    this.reset();
  }

  reset() {
    const p = this.p;
    const y0 = p.r0;                                   // arranca en régimen, en el set point
    this.t = 0;
    this.k = 0;
    this.y = y0;
    this.ym = p.Ks * y0;
    this.ymPrev = null;
    this.uBasal = Math.max((p.G0 - p.r0) / p.Kp, 0);
    this.u = this.uBasal;
    // Con Ti = 0 se anula la acción integral (control P o PD): queda error en
    // estado estable, que es justamente lo que se quiere poder mostrar.
    this.integ = (p.Kc !== 0 && p.Ti > 0) ? (this.uBasal / p.Kc) * p.Ti : 0;
    // Buffer de retardo θ, inicializado en la insulina basal de equilibrio.
    this.nbuf = Math.max(Math.round(p.theta / this.dt), 0) + 1;
    const pBasal = (p.G0 - y0) / p.Kp;
    this.buf = new Array(this.nbuf).fill(pBasal);
    this.eventos = [];                                 // perturbaciones inyectadas en vivo
  }

  // Inyecta una perturbación en el instante actual. Magnitudes (efecto sobre la
  // glucemia, mg/dL) y duraciones tomadas de literatura:
  //   - Comida: subida transitoria (bump). Liviana ~+50, alta ~+130 mg/dL.
  //   - Ejercicio aeróbico moderado: BAJA la glucemia. ADA Position Statement
  //     (Colberg et al., Diabetes Care 2016) y T1DEXI (Diabetes Care 2023): el
  //     aeróbico produce la mayor caída; 30-60 min requieren HC/menos insulina
  //     para evitar hipo. Modelado: bajada sostenida ~-60 mg/dL durante ~45 min.
  //   - Estrés agudo: SUBE la glucemia (cortisol/adrenalina). Estudios en
  //     Psychoneuroendocrinology: ~+35 mg/dL en promedio (rango 20->100), pico a
  //     los 30-45 min, resolución 2-4 h. Modelado: +40 mg/dL sostenido ~150 min.
  inject(tipo) {
    const t = this.t;
    const defs = {
      liviana:   { dur: 90,  pico: +50,  forma: "bump",   nombre: "Comida liviana" },
      alta:      { dur: 150, pico: +130, forma: "bump",   nombre: "Comida alta" },
      ejercicio: { dur: 45,  pico: -60,  forma: "meseta", nombre: "Ejercicio" },
      estres:    { dur: 150, pico: +40,  forma: "meseta", nombre: "Estrés" },
    };
    const d = defs[tipo];
    if (d) this.eventos.push({ t0: t, tipo, ...d });
  }

  // Efecto neto de las perturbaciones activas sobre la glucemia [mg/dL].
  _efecto(t) {
    let e = 0;
    for (const ev of this.eventos) {
      if (t < ev.t0 || t > ev.t0 + ev.dur) continue;
      const x = (t - ev.t0) / ev.dur;
      if (ev.forma === "meseta") {
        const r = 0.25;
        let f = 1;
        if (x < r) f = x / r; else if (x > 1 - r) f = (1 - x) / r;
        e += ev.pico * f;
      } else {                                         // bump (coseno alzado)
        e += ev.pico * 0.5 * (1 - Math.cos(2 * Math.PI * x));
      }
    }
    return e;
  }

  _pid(r) {
    const p = this.p;
    const desv = this.ym - r;                          // acción inversa (planta de ganancia negativa)
    let deriv = 0;
    if (this.ymPrev !== null) deriv = (this.ym - this.ymPrev) / p.Ts;
    this.ymPrev = this.ym;

    const termI = (integ) => (p.Ti > 0 ? integ / p.Ti : 0);   // Ti = 0 => sin integral
    const calc = (integ) => p.Kc * (desv + termI(integ) + p.Td * deriv);
    const sat = (u) => {
      u = Math.min(u, this.uBasal + p.iob_max);        // tope IOB
      u = Math.max(p.u_min, Math.min(p.u_max, u));     // saturación física
      if (p.u_res > 0) u = Math.round(u / p.u_res) * p.u_res;
      return u;
    };

    const uTent = calc(this.integ);
    const uSat = sat(uTent);
    const satArr = uTent > uSat, satAb = uTent < uSat;
    if (p.Ti > 0 && !(satArr && desv > 0) && !(satAb && desv < 0)) this.integ += desv * p.Ts;
    return sat(calc(this.integ));
  }

  // Avanza un paso dt y devuelve el estado de todas las señales.
  step() {
    const p = this.p, dt = this.dt;
    const r = p.r0;

    if (this.k % this.kCtrl === 0) this.u = this._pid(r);   // control cada Ts

    const efecto = this._efecto(this.t);                    // mg/dL
    const dUh = -efecto / p.Kp;                             // a la entrada de la planta [U/h-equiv]
    const pin = p.Ka * this.u + dUh;

    // Planta FOPDT con retardo real.
    this.buf.push(pin);
    while (this.buf.length > this.nbuf) this.buf.shift();
    const pDel = this.buf[0];
    this.y += dt * (p.G0 - p.Kp * pDel - this.y) / p.tau;

    // Sensor CGM.
    this.ym += dt * (p.Ks * this.y - this.ym) / p.tau_s;
    let ymOut = this.ym;
    if (p.ruido_sigma > 0) ymOut += gauss() * p.ruido_sigma;

    this.t += dt;
    this.k += 1;
    return { t: this.t, r, y: this.y, ym: ymOut, e: r - ymOut, u: this.u, d: efecto };
  }
}
