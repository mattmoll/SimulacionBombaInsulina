"use strict";

// Ids de inputs editables que se mapean 1:1 a los parámetros de la simulación.
// (La planta y el sensor quedan fijos en sus valores del TP; el PID sí se ajusta
//  para poder mostrar el efecto de cada acción: P, I y D.)
const PARAM_IDS = ["r0", "Kc", "Ti", "Td", "u_min", "u_max", "u_res", "iob_max",
                   "T_horas", "Ts", "dt"];

let eventos = [];           // perturbaciones cargadas por el usuario (modo estático)
let extraParams = {};       // parámetros del escenario que no son inputs (p. ej. y0)
let ultimoResultado = null;

// --- Estado del simulador en tiempo real ---
let velocidad = 1;          // multiplicador de velocidad (slider)
const BASE_MINPS = 12;      // minutos simulados por segundo real, a 1×

// --- Navegación del eje de tiempo (zoom / paneo) ---
const VENTANAS = [60, 120, 240, 360, 720, 1440, 2880];  // anchos disponibles [min]
const MAX_PTS = 1200;       // puntos dibujados por señal (se decima si hay más)
const MAX_HIST = 200000;    // tope de historia guardada [muestras] (~139 días sim.)
let ventana = 240;          // ancho de la ventana visible en vivo [min]
let lastVentana = null;     // último ancho aplicado (para reajustar las marcas)
let seguir = true;          // la vista sigue el borde en vivo
let xIni = 0;               // borde izquierdo de la ventana cuando no se sigue
let hist = null;            // historia COMPLETA de la corrida en vivo
let sim = null;             // instancia de SimVivo en curso
let liveOn = false;         // hay una sesión de tiempo real activa
let liveRunning = false;    // el reloj está avanzando (no pausado)
let liveRaf = null;
let liveLast = 0;           // último timestamp real
let liveAcc = 0;            // minutos simulados pendientes (parte fraccionaria)
let liveQoSlast = 0;        // throttle del cálculo de QoS en vivo
let liveDrawLast = 0;       // throttle del redibujado (~30 fps)
let liveShapesBase = [];    // shapes de fondo (bandas, umbrales, basal, saturación)
let liveAnnBase = [];       // anotaciones de fondo (etiquetas de las señales)
let liveRangos = [];        // último rango vertical aplicado a cada señal
let ultimoRangoAplicado = null;  // [x0,x1] que acabamos de escribir nosotros

// -------------------------------------------------------------- utilidades
const $ = (id) => document.getElementById(id);

function setVal(id, v) {
  const el = $(id);
  if (!el) return;
  el.value = (v === null || v === undefined) ? "" : v;
}

function aplicarDefaults() {
  PARAM_IDS.forEach((id) => {
    const v = window.DEFAULTS[id];
    setVal(id, (v === null || v === undefined) ? "" : v);
  });
}

function leerParams() {
  const p = { ...extraParams };
  PARAM_IDS.forEach((id) => {
    const raw = $(id).value;
    if (raw === "") return;              // vacío => el backend usa su valor por defecto
    p[id] = parseFloat(raw);
  });
  return p;
}

// Parámetros COMPLETOS del modelo (defaults del backend + overrides visibles).
// El backend inyecta todos los defaults en window.DEFAULTS (Kp, τ, θ, G0, Ks,
// τs, Kc, Ti, Td, Ka, ...), así el lazo se puede correr en el navegador.
function leerParamsCompletos() {
  const p = {};
  Object.keys(window.DEFAULTS).forEach((k) => {
    const v = window.DEFAULTS[k];
    if (v !== null && v !== undefined) p[k] = v;
  });
  PARAM_IDS.forEach((id) => {
    const raw = $(id).value;
    if (raw !== "") p[id] = parseFloat(raw);
  });
  if (p.r0 === undefined) p.r0 = 100;
  return p;
}

// Metadatos de las seis señales, en el orden de graficado.
// `rango` define cómo se calcula la escala vertical dinámica de cada una:
//   minSpan: alto mínimo (para que una señal plana no desaparezca)
//   step:    redondeo de los extremos (evita que el eje tiemble)
//   floor:   cota inferior dura (la insulina nunca es negativa)
const SIGNALS = [
  { color: "#9aa3b5", label: "Referencia θᵢ  ·  r [mg/dL]",        rango: { minSpan: 10, step: 1 } },
  { color: "#4da3ff", label: "Glucemia θ₀  ·  y [mg/dL]",          rango: { minSpan: 30, step: 5 } },
  { color: "#2ecc71", label: "Salida del controlador  ·  u [U/h]", rango: { minSpan: 1, step: 0.5, floor: 0 } },
  { color: "#b07bff", label: "Señal de medición  ·  yₘ [mg/dL]",   rango: { minSpan: 30, step: 5 } },
  { color: "#f5a623", label: "Error  ·  e = r − yₘ [mg/dL]",       rango: { minSpan: 20, step: 5 } },
  { color: "#ff6b6b", label: "Perturbación  ·  d [mg/dL]",         rango: { minSpan: 20, step: 5 } },
];

// Bandas de perturbación: relleno MUY suave (se acumulan cuando se superponen
// varias, por eso el alfa es bajo) y una línea fina en el instante de inicio,
// que es la que realmente marca el evento sin ensuciar el gráfico.
const COLOR_EVENTO = {
  comida:    "rgba(245,166,35,0.035)",
  liviana:   "rgba(46,204,113,0.035)",
  alta:      "rgba(245,120,35,0.045)",
  ejercicio: "rgba(77,163,255,0.045)",
  estres:    "rgba(176,123,255,0.045)",
};
const BORDE_EVENTO = {
  comida:    "rgba(245,166,35,0.45)",
  liviana:   "rgba(46,204,113,0.45)",
  alta:      "rgba(245,120,35,0.5)",
  ejercicio: "rgba(77,163,255,0.5)",
  estres:    "rgba(176,123,255,0.5)",
};

// Comparación de leyes de control encimadas sobre el run actual.
// Cada variante quita términos: PI sin derivativa, PD sin integral, P sin ambas.
let comparar = { PI: false, PD: false, P: false };
const OVL = {
  PI: { color: "#eb6834", dash: "dash" },
  PD: { color: "#378add", dash: "dot" },
  P:  { color: "#e87ba4", dash: "dashdot" },
};
const OVL_FILAS = [[2, "u"]];  // sólo la salida del controlador (fila 2 -> campo u)
const LEYES_COMP = ["PI", "PD", "P"];               // orden fijo de las variantes
const DEFS_COMP = { PI: { Td: 0 }, PD: { Ti: 0 }, P: { Ti: 0, Td: 0 } };
// En tiempo real: una simulación "sombra" por ley activa, que recibe las mismas
// perturbaciones y avanza en sincronía con la principal. { law: {sim, u:[...]} }
let simsComp = {};

// Densidad de marcas del eje de tiempo (en minutos) según el tramo visible.
// Debe acotar SIEMPRE la cantidad de marcas: con un zoom out muy grande, un
// dtick fijo generaría decenas de miles de líneas de grilla y colgaría el dibujo.
function densidadTicks(span) {
  if (span <= 120)   return { major: 30,   minor: 10,  mostrarMinor: true };
  if (span <= 360)   return { major: 60,   minor: 20,  mostrarMinor: true };
  if (span <= 720)   return { major: 120,  minor: 30,  mostrarMinor: true };
  if (span <= 1440)  return { major: 240,  minor: 60,  mostrarMinor: true };
  if (span <= 4320)  return { major: 720,  minor: 180, mostrarMinor: true };   // ≤ 3 días
  if (span <= 14400) return { major: 1440, minor: 360, mostrarMinor: true };   // ≤ 10 días
  // Tramos enormes: se escala el paso y se apaga la grilla menor.
  const major = Math.pow(10, Math.ceil(Math.log10(span / 8)));
  return { major, minor: major / 2, mostrarMinor: false };
}

// Escala vertical dinámica: se ajusta a los datos (para ver el detalle de las
// subidas y bajadas) garantizando que la señal NUNCA quede fuera de rango.
function rangoDin(vals, opt) {
  opt = opt || {};
  const pad = opt.pad !== undefined ? opt.pad : 0.15;
  const minSpan = opt.minSpan !== undefined ? opt.minSpan : 10;
  const step = opt.step !== undefined ? opt.step : 1;

  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (!isFinite(v)) continue;          // ignora NaN/Infinity por seguridad
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!isFinite(lo) || !isFinite(hi)) { lo = 0; hi = 1; }

  let span = hi - lo;
  if (span < minSpan) {                  // señal plana: se le da un alto mínimo
    const c = (hi + lo) / 2;
    lo = c - minSpan / 2;
    hi = c + minSpan / 2;
    span = minSpan;
  }
  lo -= span * pad;
  hi += span * pad;
  if (opt.floor !== undefined) lo = Math.max(lo, opt.floor);

  lo = Math.floor(lo / step) * step;     // redondeo: el eje no tiembla
  hi = Math.ceil(hi / step) * step;
  if (hi - lo < step) hi = lo + step;
  return [lo, hi];
}

// Bandas + etiquetas que muestran cuánto dura cada perturbación.
// La banda cruza las seis señales (yref 'paper') para ver la correlación temporal.
// Las etiquetas se escalonan en tres alturas para que no se pisen entre eventos.
function bandasPerturbacion(evs) {
  const shapes = [], anns = [];
  evs.forEach((ev, i) => {
    const t0 = ev.t0, t1 = ev.t0 + ev.dur;
    shapes.push({
      type: "rect", xref: "x", yref: "paper", x0: t0, x1: t1, y0: 0, y1: 1,
      fillcolor: COLOR_EVENTO[ev.tipo] || "rgba(255,255,255,0.03)",
      line: { width: 0 }, layer: "below",
    });
    shapes.push({          // instante exacto de inicio del evento
      type: "line", xref: "x", yref: "paper", x0: t0, x1: t0, y0: 0, y1: 1,
      line: { color: BORDE_EVENTO[ev.tipo] || "rgba(255,255,255,0.4)", width: 1, dash: "dot" },
      layer: "below",
    });
    anns.push({
      xref: "x6", yref: "y6 domain", x: (t0 + t1) / 2, y: 0.97 - (i % 3) * 0.16,
      xanchor: "center", yanchor: "top",
      text: `${ev.nombre} · ${ev.dur} min`, showarrow: false,
      font: { size: 9.5, color: "#aab4c8" },
    });
  });
  return { shapes, anns };
}

// -------------------------------------------------------------- eventos (estático)
const ETIQUETA = { comida: "Comida", ejercicio: "Ejercicio", estres: "Estrés" };

function renderEventos() {
  const tb = $("ev-tabla").querySelector("tbody");
  tb.innerHTML = "";
  eventos.forEach((ev, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td>${ETIQUETA[ev.tipo]}</td><td>${ev.t_ini_h} h</td>` +
      `<td>${ev.dur_min}</td><td>${ev.mag}</td>` +
      `<td><button data-i="${i}">✕</button></td>`;
    tb.appendChild(tr);
  });
  tb.querySelectorAll("button").forEach((b) => {
    b.onclick = () => { eventos.splice(parseInt(b.dataset.i), 1); renderEventos(); simular(); };
  });
}

function agregarEvento() {
  eventos.push({
    tipo: $("ev-tipo").value,
    t_ini_h: parseFloat($("ev-hora").value) || 0,
    dur_min: parseFloat($("ev-dur").value) || 0,
    mag: parseFloat($("ev-mag").value) || 0,
  });
  renderEventos();
  simular();
}

// -------------------------------------------------------------- simulación estática
let timer = null;
function simularDebounce() {
  clearTimeout(timer);
  timer = setTimeout(simular, 250);
}

// Corre el lazo en el backend con los parámetros actuales más un override.
async function fetchRun(override) {
  const params = Object.assign({}, leerParams(), override || {});
  const resp = await fetch("/simular", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ params, eventos }),
  });
  return resp.json();
}

async function simular() {
  stopLive();   // cualquier recálculo/edición sale del modo tiempo real
  const defs = { PI: { Td: 0 }, PD: { Ti: 0 }, P: { Ti: 0, Td: 0 } };
  const activos = ["PI", "PD", "P"].filter((l) => comparar[l]);
  try {
    const res = await fetchRun({});
    ultimoResultado = res;

    // Variantes a encimar (se descartan las que resulten idénticas al run actual).
    const mTi = res.params.Ti, mTd = res.params.Td;
    const variantes = [];
    await Promise.all(activos.map(async (law) => {
      const ov = defs[law];
      const vTi = "Ti" in ov ? ov.Ti : mTi;
      const vTd = "Td" in ov ? ov.Td : mTd;
      if (vTi === mTi && vTd === mTd) return;      // igual al run actual: no duplicar
      variantes.push({ law, res: await fetchRun(ov) });
    }));
    variantes.sort((a, b) => ["PI", "PD", "P"].indexOf(a.law) - ["PI", "PD", "P"].indexOf(b.law));

    dibujar(res, variantes);
    dibujarQoS(res.qos);
    actualizarToolbar();
  } catch (err) {
    console.error("Error al simular:", err);
  }
}

// -------------------------------------------------------------- gráficos (estático)
function dibujar(res, variantes) {
  variantes = variantes || [];
  const t = res.t_h.map((v) => v * 60);       // eje de tiempo en MINUTOS
  const tmax = t[t.length - 1];
  const ax = (i) => (i === 0 ? "" : i + 1);   // sufijo de eje: '', 2, 3, ...
  const { major: majorDt, minor: minorDt, mostrarMinor } = densidadTicks(tmax);

  // Orden de las señales (error debajo de la medición).
  const datos = [res.r, res.y, res.u, res.ym, res.e, res.d_efecto];
  const filas = SIGNALS.map((s, i) => ({ y: datos[i], color: s.color, label: s.label }));
  const FILA_GLUCEMIA = 1;   // banda objetivo + umbrales
  const FILA_INSULINA = 2;   // líneas de saturación

  // Series extra por fila que aportan las variantes encimadas (para el rango).
  const extraFila = {};
  variantes.forEach((v) => OVL_FILAS.forEach(([fila, campo]) =>
    (extraFila[fila] = extraFila[fila] || []).push(v.res[campo])));

  const trazas = filas.map((f, i) => ({
    x: t, y: f.y, mode: "lines",
    line: { color: f.color, width: 1.8 },
    xaxis: "x" + ax(i), yaxis: "y" + ax(i),
  }));

  // Trazas encimadas de cada ley de control (líneas punteadas de color).
  variantes.forEach((v) => {
    const o = OVL[v.law];
    const tv = v.res.t_h.map((h) => h * 60);
    OVL_FILAS.forEach(([fila, campo]) => trazas.push({
      x: tv, y: v.res[campo], mode: "lines",
      line: { color: o.color, width: 1.3, dash: o.dash },
      xaxis: "x" + ax(fila), yaxis: "y" + ax(fila),
    }));
  });

  const layout = {
    height: 960,
    margin: { l: 52, r: 16, t: 32, b: 38 },
    paper_bgcolor: "#0f1420", plot_bgcolor: "#0f1420",
    font: { color: "#e6ebf5", size: 11 },
    showlegend: false,
    grid: { rows: 6, columns: 1, pattern: "independent", roworder: "top to bottom", ygap: 0.17 },
    hovermode: "x",
    shapes: [],
    annotations: [],
  };

  filas.forEach((f, i) => {
    const s = ax(i);
    layout["xaxis" + s] = {
      matches: i === 0 ? undefined : "x",
      showticklabels: i === 5,
      title: i === 5 ? { text: "Tiempo [min]" } : undefined,
      tick0: 0, dtick: majorDt,
      minor: { dtick: minorDt, showgrid: mostrarMinor, gridcolor: "#1a2233" },
      gridcolor: "#222a3a", zeroline: false,
      showspikes: true, spikemode: "across", spikethickness: 1,
      spikecolor: "#6b7790", spikedash: "dot", spikesnap: "cursor",
    };
    // Escala vertical dinámica, ajustada a los datos de esta señal MÁS los de
    // las variantes encimadas, para que ninguna quede fuera de rango.
    layout["yaxis" + s] = {
      gridcolor: "#222a3a", zeroline: false,
      range: rangoDin(f.y.concat(...(extraFila[i] || [])), SIGNALS[i].rango),
    };
    layout.annotations.push({
      xref: "x" + s + " domain", yref: "y" + s + " domain",
      x: 0, y: 1, xanchor: "left", yanchor: "bottom", yshift: 2,
      text: "<b>" + f.label + "</b>", showarrow: false, textangle: 0,
      font: { size: 13, color: "#e6ebf5" },
    });
  });

  // Bandas que marcan la duración de cada perturbación, a lo largo de las 6 señales.
  const evsBanda = eventos.map((ev) => ({
    t0: ev.t_ini_h * 60, dur: ev.dur_min, tipo: ev.tipo, nombre: ETIQUETA[ev.tipo],
  }));
  const banda = bandasPerturbacion(evsBanda);
  layout.shapes.push(...banda.shapes);
  layout.annotations.push(...banda.anns);

  // Banda objetivo y umbrales sobre la glucemia (xref 'paper': cubren todo el
  // ancho y no afectan el autorango del eje de tiempo).
  const sg = ax(FILA_GLUCEMIA);
  const lineaG = (y, color, dash, ancho) => ({
    type: "line", xref: "paper", yref: "y" + sg, x0: 0, x1: 1, y0: y, y1: y,
    line: { color, width: ancho || 1, dash: dash || "dash" }, layer: "below",
  });
  layout.shapes.push(
    { type: "rect", xref: "paper", yref: "y" + sg, x0: 0, x1: 1, y0: 70, y1: 180,
      fillcolor: "rgba(46,204,113,0.07)", line: { width: 0 }, layer: "below" },
    lineaG(res.r[0], "#9aa3b5", "solid", 1),     // set point
    lineaG(70, "#f5a623", "dash"), lineaG(180, "#f5a623", "dash"),
  );

  // Insulina: la escala ya es dinámica (con piso en 0). Se marca la basal y,
  // sólo si entra en la escala, el tope de saturación.
  const si = ax(FILA_INSULINA);
  const p = res.params;
  const insTop = layout["yaxis" + si].range[1];
  layout.shapes.push({
    type: "line", xref: "paper", yref: "y" + si, x0: 0, x1: 1, y0: res.u_basal, y1: res.u_basal,
    line: { color: "#6b7790", width: 1, dash: "dot" }, layer: "below",
  });
  if (p.u_max <= insTop) {
    layout.shapes.push({
      type: "line", xref: "paper", yref: "y" + si, x0: 0, x1: 1, y0: p.u_max, y1: p.u_max,
      line: { color: "#ff6b6b", width: 1, dash: "dash" }, layer: "below",
    });
  }

  Plotly.react("plots", trazas, layout, {
    responsive: true, displaylogo: false,
    modeBarButtonsToRemove: ["lasso2d", "select2d"],
  });
  legendaComparacion(res, variantes);
}

// Nombre de la ley de control según qué términos están activos.
function nombreLey(ti, td) {
  return (ti > 0 && td > 0) ? "PID" : (ti > 0 ? "PI" : (td > 0 ? "PD" : "P"));
}

// Leyenda de las leyes encimadas (sólo visible cuando hay comparaciones).
function legendaComparacion(res, variantes) {
  const el = $("cmp-legend");
  if (!el) return;
  if (!variantes.length) { el.innerHTML = ""; el.style.display = "none"; return; }
  const main = nombreLey(res.params.Ti, res.params.Td);
  let html = `<span class="cmp-item"><span class="cmp-sw cmp-sol"></span>${main} actual (línea llena)</span>`;
  variantes.forEach((v) => {
    const o = OVL[v.law];
    const est = o.dash === "dot" ? "dotted" : "dashed";
    html += `<span class="cmp-item"><span class="cmp-sw" style="border-top:2px ${est} ${o.color}"></span>${v.law}</span>`;
  });
  el.innerHTML = html;
  el.style.display = "flex";
}

// -------------------------------------------------------------- QoS
const QOS_INFO = {
  TIR_70_180: {
    nombre: "TIR 70–180", u: "%", obj: "> 70 %",
    desc: "TIR — Tiempo en Rango: porcentaje del tiempo con la glucemia entre 70 y 180 mg/dL. Es el indicador principal de buen control. Objetivo del Consenso: > 70 % del día.",
  },
  TBR_70: {
    nombre: "TBR < 70", u: "%", obj: "< 4 %",
    desc: "TBR — Tiempo Bajo Rango: porcentaje del tiempo con la glucemia por debajo de 70 mg/dL (hipoglucemia, el riesgo más peligroso). Objetivo: < 4 %.",
  },
  TAR_180: {
    nombre: "TAR > 180", u: "%", obj: "< 25 %",
    desc: "TAR — Tiempo Sobre Rango: porcentaje del tiempo con la glucemia por encima de 180 mg/dL (hiperglucemia). Objetivo: < 25 %.",
  },
};

function dibujarQoS(qos) {
  const cont = $("qos");
  cont.innerHTML = "";
  if (!qos || !qos.valores) return;
  Object.keys(QOS_INFO).forEach((k) => {
    const info = QOS_INFO[k];
    const v = qos.valores[k];
    const ok = qos.cumple[k];
    const card = document.createElement("div");
    card.className = "qos-card " + (ok ? "ok" : "bad");
    card.title = info.desc;
    card.innerHTML =
      `<div class="k">${info.nombre}</div>` +
      `<div class="v">${v.toFixed(1)}${info.u}</div>` +
      `<div class="obj">objetivo ${info.obj}</div>`;
    cont.appendChild(card);
  });
  const val = qos.valores;
  const card = document.createElement("div");
  card.className = "qos-card";
  card.title = "Glucemia promedio de la corrida, con sus valores mínimo y máximo (mg/dL).";
  card.innerHTML =
    `<div class="k">Glucemia</div>` +
    `<div class="v">${val.media.toFixed(0)} mg/dL</div>` +
    `<div class="obj">mín ${val.min.toFixed(0)} · máx ${val.max.toFixed(0)}</div>`;
  cont.appendChild(card);
}

// QoS calculado en el navegador sobre toda la corrida en vivo. Un solo recorrido,
// sin `apply` ni arreglos intermedios: soporta historias largas sin problemas.
function jsQoS(y) {
  const n = y.length;
  if (!n) return null;
  let tir = 0, tbr = 0, tar = 0, suma = 0, mn = Infinity, mx = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = y[i];
    suma += v;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
    if (v >= 70 && v <= 180) tir++;
    if (v < 70) tbr++;
    if (v > 180) tar++;
  }
  const valores = {
    TIR_70_180: 100 * tir / n,
    TBR_70: 100 * tbr / n,
    TAR_180: 100 * tar / n,
    media: suma / n, min: mn, max: mx,
  };
  const cumple = {
    TIR_70_180: valores.TIR_70_180 > 70,
    TBR_70: valores.TBR_70 < 4,
    TAR_180: valores.TAR_180 < 25,
  };
  return { valores, cumple };
}

// -------------------------------------------------------------- export
function descargarPNG() {
  Plotly.downloadImage("plots", {
    format: "png", width: 1200, height: 1500,
    filename: "simulacion_bomba_insulina",
  });
}

// -------------------------------------------------------------- SIMULADOR EN TIEMPO REAL
// Integra el lazo en el navegador paso a paso (SimVivo, en livesim.js) y va
// dibujando las señales a medida que avanza un reloj. Mientras corre se pueden
// inyectar comidas en el instante actual y ver el impacto propagarse por todas
// las señales con sus retardos.

function setPlay(label, activo) {
  const b = $("btn-play");
  b.textContent = label;
  b.classList.toggle("activo", !!activo);
}

function initLivePlot(p) {
  const ax = (i) => (i === 0 ? "" : i + 1);
  const { major, minor, mostrarMinor } = densidadTicks(ventana);
  lastVentana = ventana;
  const y0 = p.r0;
  const init = [p.r0, y0, Math.max((p.G0 - p.r0) / p.Kp, 0), p.Ks * y0, 0, 0];
  // Escala inicial dinámica a partir del punto de arranque (en régimen).
  const yr = SIGNALS.map((s, i) => rangoDin([init[i]], s.rango));

  const trazas = SIGNALS.map((s, i) => ({
    x: [0], y: [init[i]], mode: "lines",
    line: { color: s.color, width: 1.8 },
    xaxis: "x" + ax(i), yaxis: "y" + ax(i),
  }));

  // Trazas de comparación (índices 6,7,8): sólo sobre la salida del controlador
  // (subplot de la fila 2 => ejes x3/y3). Arrancan vacías y se llenan si la ley
  // está activa. Orden fijo PI, PD, P.
  LEYES_COMP.forEach((law) => {
    const o = OVL[law];
    trazas.push({
      x: [], y: [], mode: "lines",
      line: { color: o.color, width: 1.4, dash: o.dash },
      xaxis: "x3", yaxis: "y3",
    });
  });

  const layout = {
    height: 960,
    margin: { l: 52, r: 16, t: 32, b: 38 },
    paper_bgcolor: "#0f1420", plot_bgcolor: "#0f1420",
    font: { color: "#e6ebf5", size: 11 },
    showlegend: false,
    grid: { rows: 6, columns: 1, pattern: "independent", roworder: "top to bottom", ygap: 0.17 },
    hovermode: "x",
    shapes: [],
    annotations: [],
  };

  SIGNALS.forEach((s, i) => {
    const k = ax(i);
    layout["xaxis" + k] = {
      matches: i === 0 ? undefined : "x",
      showticklabels: i === 5,
      title: i === 5 ? { text: "Tiempo [min]" } : undefined,
      tick0: 0, dtick: major,
      minor: { dtick: minor, showgrid: mostrarMinor, gridcolor: "#1a2233" },
      gridcolor: "#222a3a", zeroline: false,
      range: [0, ventana],
    };
    layout["yaxis" + k] = { gridcolor: "#222a3a", zeroline: false, range: yr[i].slice() };
    layout.annotations.push({
      xref: "x" + k + " domain", yref: "y" + k + " domain",
      x: 0, y: 1, xanchor: "left", yanchor: "bottom", yshift: 2,
      text: "<b>" + s.label + "</b>", showarrow: false, font: { size: 13, color: "#e6ebf5" },
    });
  });

  // Banda objetivo y umbrales de glucemia (fila 2). Van con xref 'paper' para
  // cubrir siempre todo el ancho SIN afectar el autorango del eje de tiempo.
  const lg = (y, c, d, w) => ({
    type: "line", xref: "paper", yref: "y2", x0: 0, x1: 1, y0: y, y1: y,
    line: { color: c, width: w || 1, dash: d || "dash" }, layer: "below",
  });
  layout.shapes.push(
    { type: "rect", xref: "paper", yref: "y2", x0: 0, x1: 1, y0: 70, y1: 180,
      fillcolor: "rgba(46,204,113,0.07)", line: { width: 0 }, layer: "below" },
    lg(p.r0, "#9aa3b5", "solid", 1), lg(70, "#f5a623", "dash"), lg(180, "#f5a623", "dash"),
  );
  // Insulina basal y saturación (fila 3).
  const basal = Math.max((p.G0 - p.r0) / p.Kp, 0);
  layout.shapes.push({
    type: "line", xref: "paper", yref: "y3", x0: 0, x1: 1, y0: basal, y1: basal,
    line: { color: "#6b7790", width: 1, dash: "dot" }, layer: "below",
  });
  // Tope de saturación: al ser la escala explícita, la línea sólo se ve cuando
  // la insulina realmente se acerca al tope (si no, queda recortada).
  layout.shapes.push({
    type: "line", xref: "paper", yref: "y3", x0: 0, x1: 1, y0: p.u_max, y1: p.u_max,
    line: { color: "#ff6b6b", width: 1, dash: "dash" }, layer: "below",
  });

  // Se guardan como base para poder sumarles después las bandas de perturbación.
  liveShapesBase = layout.shapes.slice();
  liveAnnBase = layout.annotations.slice();

  const gd = $("plots");
  const pr = Plotly.newPlot(gd, trazas, layout, {
    responsive: true, displaylogo: false,
    modeBarButtonsToRemove: ["lasso2d", "select2d"],
  });
  // Zoom/paneo nativo (modebar, rueda, arrastre, doble clic) -> recortar de la
  // historia. Se engancha ya mismo (no dentro del .then) para no perder eventos.
  const enganchar = () => {
    if (gd.removeAllListeners) gd.removeAllListeners("plotly_relayout");
    gd.on("plotly_relayout", onRelayoutVivo);
  };
  if (gd.on) enganchar(); else pr.then(enganchar);
}

// Redibuja las bandas de duración de las perturbaciones inyectadas en vivo.
function refrescarBandasVivo() {
  if (!liveOn || !sim) return;
  const banda = bandasPerturbacion(sim.eventos);
  Plotly.relayout("plots", {
    shapes: liveShapesBase.concat(banda.shapes),
    annotations: liveAnnBase.concat(banda.anns),
  });
}

// Historia completa de la corrida (no se recorta con la ventana visible), para
// poder retroceder y revisar toda la corrida.
function nuevaHist(p) {
  const y0 = p.r0;
  const init = [p.r0, y0, Math.max((p.G0 - p.r0) / p.Kp, 0), p.Ks * y0, 0, 0];
  return { t: [0], s: init.map((v) => [v]) };
}

// Crea una simulación "sombra" de una ley de control y reconstruye su salida u
// alineada por posición con la historia actual (replaya los mismos eventos).
function crearSombra(law) {
  const p = Object.assign({}, sim.p, DEFS_COMP[law]);
  const s = new SimVivo(p);
  s.eventos = sim.eventos.map((e) => Object.assign({}, e));   // mismas perturbaciones (mismos t0)
  const t0 = hist.t[0];
  for (let i = 0; i < t0; i++) s.step();                      // por si la historia fue recortada
  const u = [s.u];
  for (let k = 1; k < hist.t.length; k++) u.push(s.step().u);
  return { sim: s, u };
}

// (Re)crea las sombras según las casillas activas, descartando las que coincidan
// con la ley actual del run principal.
function rebuildSombras() {
  simsComp = {};
  if (!liveOn || !sim) return;
  LEYES_COMP.forEach((law) => {
    if (!comparar[law]) return;
    const ov = DEFS_COMP[law];
    const vTi = "Ti" in ov ? ov.Ti : sim.p.Ti;
    const vTd = "Td" in ov ? ov.Td : sim.p.Td;
    if (vTi === sim.p.Ti && vTd === sim.p.Td) return;
    simsComp[law] = crearSombra(law);
  });
}

// Muestra en la leyenda las leyes encimadas activas en el modo vivo.
function legendaVivo() {
  const activos = LEYES_COMP.filter((l) => simsComp[l]).map((law) => ({ law }));
  legendaComparacion({ params: sim.p }, activos);
}

function startLive() {
  const leg = $("cmp-legend");           // la comparación encimada es sólo del modo estático
  if (leg) { leg.innerHTML = ""; leg.style.display = "none"; }
  const p = leerParamsCompletos();
  sim = new SimVivo(p);
  hist = nuevaHist(p);
  seguir = true;
  xIni = 0;
  initLivePlot(p);
  liveRangos = [];
  liveOn = true;
  liveRunning = true;
  liveAcc = 0;
  liveLast = performance.now();
  liveQoSlast = 0;
  rebuildSombras();                      // sombras de comparación según las casillas
  legendaVivo();
  setPlay("⏸ Pausar", true);
  dibujarQoS(jsQoS(hist.s[1]));
  actualizarToolbar();
  liveRaf = requestAnimationFrame(liveFrame);
}

function liveFrame(now) {
  if (!liveOn || !liveRunning) return;
  let dtReal = (now - liveLast) / 1000;
  liveLast = now;
  if (dtReal > 0.25) dtReal = 0.25;                  // si la pestaña estuvo en segundo plano
  liveAcc += BASE_MINPS * velocidad * dtReal;
  let pasos = Math.floor(liveAcc);
  liveAcc -= pasos;

  if (pasos > 0) {
    if (pasos > 400) pasos = 400;
    for (let s = 0; s < pasos; s++) {
      const o = sim.step();
      hist.t.push(o.t);
      hist.s[0].push(o.r); hist.s[1].push(o.y); hist.s[2].push(o.u);
      hist.s[3].push(o.ym); hist.s[4].push(o.e); hist.s[5].push(o.d);
    }
    for (const law in simsComp) {                    // sombras de comparación, en sincronía
      const sc = simsComp[law];
      for (let s = 0; s < pasos; s++) sc.u.push(sc.sim.step().u);
    }
    if (hist.t.length > MAX_HIST) {                  // tope de memoria (raro de alcanzar)
      const ex = hist.t.length - MAX_HIST;
      hist.t.splice(0, ex);
      hist.s.forEach((a) => a.splice(0, ex));
      for (const law in simsComp) simsComp[law].u.splice(0, ex);
    }
    // Ritmo de dibujo adaptado al zoom: con la ventana ancha cada píxel cubre
    // más minutos, así que redibujar menos seguido no se nota y ahorra CPU.
    const intervalo = ventana <= 360 ? 33 : (ventana <= 1440 ? 66 : 100);
    if (now - liveDrawLast >= intervalo) {
      liveDrawLast = now;
      renderVivo();
    }

    if (now - liveQoSlast > 600) {                   // QoS en vivo sobre toda la corrida
      liveQoSlast = now;
      dibujarQoS(jsQoS(hist.s[1]));
    }
  }
  liveRaf = requestAnimationFrame(liveFrame);
}

// Dibuja la porción de la historia que cae dentro de la ventana visible,
// decimando si hay demasiados puntos. Sirve tanto en marcha como en pausa.
function renderVivo() {
  if (!liveOn || !hist || !sim) return;
  const dt = sim.dt;
  const n = hist.t.length;
  const tIni = hist.t[0], tFin = hist.t[n - 1];

  const maxIni = Math.max(tIni, tFin - ventana);
  if (seguir) xIni = maxIni;
  else xIni = Math.min(Math.max(tIni, xIni), maxIni);

  let i0 = Math.max(0, Math.floor((xIni - tIni) / dt) - 1);
  let i1 = Math.min(n - 1, Math.ceil((xIni + ventana - tIni) / dt) + 1);

  const paso = Math.max(1, Math.ceil((i1 - i0 + 1) / MAX_PTS));
  const idx = [];
  for (let k = i0; k <= i1; k += paso) idx.push(k);
  if (idx[idx.length - 1] !== i1) idx.push(i1);

  const xv = idx.map((k) => hist.t[k]);
  const xs = [], ys = [];
  for (let s = 0; s < 6; s++) { xs.push(xv); ys.push(idx.map((k) => hist.s[s][k])); }

  // Trazas de comparación (índices 6,7,8) sobre la salida del controlador.
  const idxTraces = [0, 1, 2, 3, 4, 5];
  LEYES_COMP.forEach((law, j) => {
    idxTraces.push(6 + j);
    const sc = simsComp[law];
    if (sc) { xs.push(xv); ys.push(idx.map((k) => sc.u[k])); }
    else { xs.push([]); ys.push([]); }
  });

  const patch = { "xaxis.range": [xIni, xIni + ventana] };

  if (ventana !== lastVentana) {                     // cambió el zoom: reajustar marcas
    const { major, minor, mostrarMinor } = densidadTicks(ventana);
    for (let i = 0; i < 6; i++) {
      const k = i === 0 ? "" : i + 1;
      patch["xaxis" + k + ".dtick"] = major;
      patch["xaxis" + k + ".minor.dtick"] = minor;
      patch["xaxis" + k + ".minor.showgrid"] = mostrarMinor;
    }
    lastVentana = ventana;
    liveRangos = [];                                 // fuerza recalcular las escalas
  }

  // Escala vertical dinámica sobre lo que está DENTRO de la ventana visible.
  // La fila del controlador (i=2) incluye las curvas de comparación para que no
  // se salgan de rango.
  for (let i = 0; i < 6; i++) {
    let datosRango = ys[i];
    if (i === 2) {
      const extra = LEYES_COMP.map((l, j) => (simsComp[l] ? ys[6 + j] : null)).filter(Boolean);
      if (extra.length) datosRango = ys[2].concat(...extra);
    }
    const r = rangoDin(datosRango, SIGNALS[i].rango);
    const prev = liveRangos[i];
    if (!prev || prev[0] !== r[0] || prev[1] !== r[1]) {
      patch["yaxis" + (i === 0 ? "" : i + 1) + ".range"] = r;
      liveRangos[i] = r;
    }
  }

  ultimoRangoAplicado = [xIni, xIni + ventana];
  Plotly.update("plots", { x: xs, y: ys }, patch, idxTraces);
  actualizarToolbar();
}

// El usuario puede mover el eje con la modebar, la rueda o arrastrando. En vivo
// Plotly sólo tiene la ventana visible, así que hay que volver a recortar la
// historia completa cada vez que el rango cambia por fuera de nuestro código.
// La guarda es idempotente: si el rango entrante es el que acabamos de escribir,
// el evento viene de nuestro propio dibujo y se ignora (evita realimentación).
function onRelayoutVivo(ev) {
  if (!liveOn || !hist || !ev) return;
  const tIni = hist.t[0], tFin = hist.t[hist.t.length - 1];

  if (ev["xaxis.autorange"]) {                 // botón de autoescala / doble clic
    seguir = true;
    ventana = Math.max(VENTANAS[0], tFin - tIni);
    redibujarDiferido();
    return;
  }
  if (ev["xaxis.range[0]"] === undefined && ev["xaxis.range"] === undefined) return;

  const r = $("plots")._fullLayout.xaxis.range;
  const w = Math.max(5, Math.min(r[1] - r[0], 200000));   // ancho sensato
  if (!(w > 0)) return;
  if (ultimoRangoAplicado &&
      Math.abs(r[0] - ultimoRangoAplicado[0]) < 1e-6 &&
      Math.abs(r[1] - ultimoRangoAplicado[1]) < 1e-6) return;   // lo escribimos nosotros

  ventana = w;
  xIni = r[0];
  seguir = (xIni + ventana) >= tFin - 1e-6;    // si quedó pegado al borde, sigue en vivo
  redibujarDiferido();
}

// Redibuja FUERA del handler: llamar a Plotly desde dentro de su propio evento
// 'plotly_relayout' re-entra en su cola de dibujo y la traba.
let redibujoPendiente = null;
function redibujarDiferido() {
  if (redibujoPendiente) return;
  redibujoPendiente = setTimeout(() => {
    redibujoPendiente = null;
    renderVivo();
  }, 0);
}

// -------------------------------------------------------------- eje de tiempo
function fmtDur(min) {
  if (min >= 120) return (Math.round((min / 60) * 10) / 10) + " h";
  return Math.round(min) + " min";
}

function actualizarToolbar() {
  const gd = $("plots");
  let w = ventana;
  if (!liveOn && gd && gd._fullLayout && gd._fullLayout.xaxis) {
    const r = gd._fullLayout.xaxis.range;
    w = r[1] - r[0];
  }
  $("tt-ventana").textContent = fmtDur(w);
  const b = $("tt-vivo");
  b.classList.toggle("activo", liveOn && seguir);
  b.disabled = !liveOn;
}

// dir = +1 expandir (más detalle) · dir = -1 comprimir (ver más tiempo)
function zoomTiempo(dir) {
  const gd = $("plots");
  if (!liveOn) {                                     // modo estático: escalar el rango
    const r = gd._fullLayout.xaxis.range;
    const c = (r[0] + r[1]) / 2;
    const h = ((r[1] - r[0]) / 2) * (dir > 0 ? 1 / 1.6 : 1.6);
    const patch = { "xaxis.range": [c - h, c + h] };
    const { major, minor, mostrarMinor } = densidadTicks(2 * h);
    for (let i = 0; i < 6; i++) {
      const k = i === 0 ? "" : i + 1;
      patch["xaxis" + k + ".dtick"] = major;
      patch["xaxis" + k + ".minor.dtick"] = minor;
      patch["xaxis" + k + ".minor.showgrid"] = mostrarMinor;
    }
    Plotly.relayout("plots", patch);
    actualizarToolbar();
    return;
  }
  const centro = xIni + ventana / 2;
  ventana = siguienteVentana(ventana, dir);
  if (!seguir) xIni = centro - ventana / 2;
  renderVivo();
}

// Salta al siguiente ancho de la escalera, partiendo de un ancho cualquiera
// (el zoom nativo de Plotly deja anchos arbitrarios).
function siguienteVentana(actual, dir) {
  if (dir < 0) {                                     // comprimir: el próximo mayor
    for (let i = 0; i < VENTANAS.length; i++) if (VENTANAS[i] > actual + 1e-6) return VENTANAS[i];
    return VENTANAS[VENTANAS.length - 1];
  }
  for (let i = VENTANAS.length - 1; i >= 0; i--) {   // expandir: el mayor de los menores
    if (VENTANAS[i] < actual - 1e-6) return VENTANAS[i];
  }
  return VENTANAS[0];
}

// dir = -1 retroceder · dir = +1 avanzar
function panTiempo(dir) {
  const gd = $("plots");
  if (!liveOn) {
    const r = gd._fullLayout.xaxis.range;
    const w = r[1] - r[0];
    Plotly.relayout("plots", { "xaxis.range": [r[0] + dir * w * 0.5, r[1] + dir * w * 0.5] });
    return;
  }
  const tIni = hist.t[0], tFin = hist.t[hist.t.length - 1];
  const maxIni = Math.max(tIni, tFin - ventana);
  if (seguir) xIni = maxIni;
  seguir = false;
  xIni = Math.min(Math.max(tIni, xIni + dir * ventana * 0.5), maxIni);
  if (xIni >= maxIni - 1e-9) seguir = true;          // llegó al borde en vivo
  renderVivo();
}

function irEnVivo() {
  if (!liveOn) return;
  seguir = true;
  renderVivo();
}

function stopLive() {
  if (liveRaf) { cancelAnimationFrame(liveRaf); liveRaf = null; }
  liveOn = false;
  liveRunning = false;
  sim = null;
  hist = null;
  simsComp = {};
  seguir = true;
  xIni = 0;
  setPlay("▶ Iniciar tiempo real", false);
}

function togglePlay() {
  if (!liveOn) { startLive(); return; }
  if (liveRunning) {                                 // pausar
    liveRunning = false;
    if (liveRaf) { cancelAnimationFrame(liveRaf); liveRaf = null; }
    setPlay("▶ Reanudar", false);
  } else {                                           // reanudar
    liveRunning = true;
    liveLast = performance.now();
    setPlay("⏸ Pausar", true);
    liveRaf = requestAnimationFrame(liveFrame);
  }
}

// Inyecta una perturbación (comida / ejercicio / estrés) en el instante actual,
// arrancando el tiempo real si hace falta.
function inyectar(tipo) {
  if (!liveOn) startLive();
  if (sim) {
    sim.inject(tipo);
    for (const law in simsComp) simsComp[law].sim.inject(tipo);   // misma perturbación a las sombras
    refrescarBandasVivo();
  }
}

function reiniciarLive() {
  if (!liveOn) { startLive(); return; }
  sim.reset();
  hist = nuevaHist(sim.p);
  seguir = true;
  xIni = 0;
  initLivePlot(sim.p);
  rebuildSombras();
  legendaVivo();
  liveRangos = [];
  liveAcc = 0;
  liveLast = performance.now();
  actualizarToolbar();
}

// Velocidad: el bucle en vivo la lee en cada frame, el cambio es inmediato.
// El slider recorre una escalera de valores (índice -> multiplicador).
const VELOCIDADES = [0.3, 0.5, 0.75, 1, 1.5, 2, 3, 4];
function setVelocidad(idx) {
  const i = Math.min(VELOCIDADES.length - 1, Math.max(0, Math.round(idx)));
  velocidad = VELOCIDADES[i];
  $("velLabel").textContent = velocidad + "×";
}

// -------------------------------------------------------------- parámetros / PID
// Al editar un parámetro: si el tiempo real está corriendo se aplica en caliente
// (el paso lee sim.p en cada iteración), si no se recalcula la corrida estática.
function onParamInput() {
  actualizarModoPID();
  if (liveOn && sim) {
    const p = leerParamsCompletos();
    Object.assign(sim.p, p);
    sim.uBasal = Math.max((p.G0 - p.r0) / p.Kp, 0);
    for (const law in simsComp) {                     // las sombras siguen el mismo cambio
      const sp = Object.assign({}, p, DEFS_COMP[law]);
      Object.assign(simsComp[law].sim.p, sp);
      simsComp[law].sim.uBasal = Math.max((sp.G0 - sp.r0) / sp.Kp, 0);
    }
  } else {
    simularDebounce();
  }
}

// Presets de la ley de control, para mostrar el aporte de cada acción.
function modoPID(modo) {
  const D = window.DEFAULTS;
  if (modo === "pid")      { setVal("Kc", D.Kc); setVal("Ti", D.Ti); setVal("Td", D.Td); }
  else if (modo === "pi")  { setVal("Kc", D.Kc); setVal("Ti", D.Ti); setVal("Td", 0); }
  else if (modo === "p")   { setVal("Kc", D.Kc); setVal("Ti", 0);    setVal("Td", 0); }
  onParamInput();
}

// Resalta el botón que corresponde a la combinación actual de Ti / Td.
function actualizarModoPID() {
  const ti = parseFloat($("Ti").value) || 0;
  const td = parseFloat($("Td").value) || 0;
  const modo = (ti > 0 && td > 0) ? "pid" : (ti > 0 ? "pi" : (td > 0 ? null : "p"));
  document.querySelectorAll(".pid-modo").forEach((b) =>
    b.classList.toggle("activo", b.dataset.modo === modo));
}

// -------------------------------------------------------------- presets (estático)
function preset(nombre) {
  stopLive();
  // El escenario no pisa la ley de control elegida: así se puede comparar el
  // mismo escenario con PID, PI o sólo P.
  const pid = { Kc: $("Kc").value, Ti: $("Ti").value, Td: $("Td").value };
  aplicarDefaults();
  setVal("Kc", pid.Kc); setVal("Ti", pid.Ti); setVal("Td", pid.Td);
  actualizarModoPID();
  eventos = [];
  extraParams = {};
  if (nombre === "comida") {
    setVal("T_horas", 10);
    eventos = [{ tipo: "comida", t_ini_h: 2, dur_min: 120, mag: 90 }];
  } else if (nombre === "dia") {
    // 24 h con 4 comidas de tamaño, duración y horario distintos.
    setVal("T_horas", 24);
    eventos = [
      { tipo: "comida", t_ini_h: 7.5,  dur_min: 110, mag: 75 },   // desayuno
      { tipo: "comida", t_ini_h: 13,   dur_min: 160, mag: 120 },  // almuerzo (grande)
      { tipo: "comida", t_ini_h: 17.5, dur_min: 90,  mag: 55 },   // merienda (chica)
      { tipo: "comida", t_ini_h: 21.5, dur_min: 150, mag: 95 },   // cena
    ];
  }
  renderEventos();
  simular();
}

// -------------------------------------------------------------- panel colapsable
function togglePanel() {
  document.body.classList.toggle("panel-oculto");
  setTimeout(() => Plotly.Plots.resize($("plots")), 60);
}

// -------------------------------------------------------------- arranque
function init() {
  aplicarDefaults();

  PARAM_IDS.forEach((id) => $(id).addEventListener("input", onParamInput));
  document.querySelectorAll(".pid-modo").forEach((b) =>
    b.addEventListener("click", () => modoPID(b.dataset.modo)));
  ["PI", "PD", "P"].forEach((law) =>
    $("cmp-" + law).addEventListener("change", (e) => {
      comparar[law] = e.target.checked;
      if (liveOn && sim) {                            // en vivo: crear/quitar la sombra
        if (comparar[law]) {
          const ov = DEFS_COMP[law];
          const vTi = "Ti" in ov ? ov.Ti : sim.p.Ti;
          const vTd = "Td" in ov ? ov.Td : sim.p.Td;
          if (!(vTi === sim.p.Ti && vTd === sim.p.Td)) simsComp[law] = crearSombra(law);
        } else {
          delete simsComp[law];
        }
        legendaVivo();
        renderVivo();
      } else {                                        // estático: recalcular con las variantes
        simular();
      }
    }));
  $("ev-add").addEventListener("click", agregarEvento);
  $("btn-reset").addEventListener("click", () => { aplicarDefaults(); actualizarModoPID(); simular(); });
  $("btn-png").addEventListener("click", descargarPNG);
  $("btn-play").addEventListener("click", togglePlay);
  $("toggle-panel").addEventListener("click", togglePanel);
  $("vel").addEventListener("input", (e) => setVelocidad(parseInt(e.target.value, 10)));
  $("btn-comida-liviana").addEventListener("click", () => inyectar("liviana"));
  $("btn-comida-alta").addEventListener("click", () => inyectar("alta"));
  $("btn-ejercicio").addEventListener("click", () => inyectar("ejercicio"));
  $("btn-estres").addEventListener("click", () => inyectar("estres"));
  $("btn-reiniciar").addEventListener("click", reiniciarLive);
  $("tt-zoom-out").addEventListener("click", () => zoomTiempo(-1));
  $("tt-zoom-in").addEventListener("click", () => zoomTiempo(+1));
  $("tt-pan-l").addEventListener("click", () => panTiempo(-1));
  $("tt-pan-r").addEventListener("click", () => panTiempo(+1));
  $("tt-vivo").addEventListener("click", irEnVivo);
  document.querySelectorAll(".preset").forEach((b) =>
    b.addEventListener("click", () => preset(b.dataset.preset)));

  setVelocidad(parseInt($("vel").value, 10));   // sincroniza la etiqueta de velocidad
  actualizarModoPID();
  preset("comida");   // vista estática inicial
}

document.addEventListener("DOMContentLoaded", init);
