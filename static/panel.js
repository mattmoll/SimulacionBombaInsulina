"use strict";

// Ids de inputs editables que se mapean 1:1 a los parámetros de la simulación.
// (La planta, el sensor y el PID quedan fijos en sus valores por defecto: ya
//  están definidos y tuneados en el TP, no se ajustan en vivo.)
const PARAM_IDS = ["r0", "u_min", "u_max", "u_res", "iob_max", "T_horas", "Ts", "dt"];

let eventos = [];           // perturbaciones cargadas por el usuario (modo estático)
let extraParams = {};       // parámetros del escenario que no son inputs (p. ej. y0)
let ultimoResultado = null;

// --- Estado del simulador en tiempo real ---
let velocidad = 1;          // multiplicador de velocidad (slider)
const BASE_MINPS = 12;      // minutos simulados por segundo real, a 1×
const VENTANA = 240;        // ancho de la ventana de tiempo visible en vivo [min]
let sim = null;             // instancia de SimVivo en curso
let liveOn = false;         // hay una sesión de tiempo real activa
let liveRunning = false;    // el reloj está avanzando (no pausado)
let liveRaf = null;
let liveLast = 0;           // último timestamp real
let liveAcc = 0;            // minutos simulados pendientes (parte fraccionaria)
let liveQoSlast = 0;        // throttle del cálculo de QoS en vivo

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

// Metadatos de las seis señales (color y etiqueta), en el orden de graficado.
const SIGNALS = [
  { color: "#9aa3b5", label: "Referencia θᵢ  ·  r [mg/dL]" },
  { color: "#4da3ff", label: "Glucemia θ₀  ·  y [mg/dL]" },
  { color: "#2ecc71", label: "Salida del controlador  ·  u [U/h]" },
  { color: "#b07bff", label: "Señal de medición  ·  yₘ [mg/dL]" },
  { color: "#f5a623", label: "Error  ·  e = r − yₘ [mg/dL]" },
  { color: "#ff6b6b", label: "Perturbación  ·  d [mg/dL]" },
];

// Densidad de marcas del eje de tiempo (en minutos) según el tramo visible.
function densidadTicks(span) {
  if (span <= 120) return { major: 30, minor: 10 };
  if (span <= 360) return { major: 60, minor: 20 };
  if (span <= 720) return { major: 120, minor: 30 };
  return { major: 240, minor: 60 };
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

async function simular() {
  stopLive();   // cualquier recálculo/edición sale del modo tiempo real
  const cuerpo = JSON.stringify({ params: leerParams(), eventos });
  try {
    const resp = await fetch("/simular", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: cuerpo,
    });
    const res = await resp.json();
    ultimoResultado = res;
    dibujar(res);
    dibujarQoS(res.qos);
  } catch (err) {
    console.error("Error al simular:", err);
  }
}

// -------------------------------------------------------------- gráficos (estático)
function dibujar(res) {
  const t = res.t_h.map((v) => v * 60);       // eje de tiempo en MINUTOS
  const tmax = t[t.length - 1];
  const ax = (i) => (i === 0 ? "" : i + 1);   // sufijo de eje: '', 2, 3, ...
  const { major: majorDt, minor: minorDt } = densidadTicks(tmax);

  // Orden de las señales (error debajo de la medición).
  const datos = [res.r, res.y, res.u, res.ym, res.e, res.d_efecto];
  const filas = SIGNALS.map((s, i) => ({ y: datos[i], color: s.color, label: s.label }));
  const FILA_GLUCEMIA = 1;   // banda objetivo + umbrales
  const FILA_INSULINA = 2;   // líneas de saturación

  const trazas = filas.map((f, i) => ({
    x: t, y: f.y, mode: "lines",
    line: { color: f.color, width: 1.8 },
    xaxis: "x" + ax(i), yaxis: "y" + ax(i),
  }));

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
      minor: { dtick: minorDt, showgrid: true, gridcolor: "#1a2233" },
      gridcolor: "#222a3a", zeroline: false,
      showspikes: true, spikemode: "across", spikethickness: 1,
      spikecolor: "#6b7790", spikedash: "dot", spikesnap: "cursor",
    };
    layout["yaxis" + s] = { gridcolor: "#222a3a", zeroline: false };
    layout.annotations.push({
      xref: "x" + s + " domain", yref: "y" + s + " domain",
      x: 0, y: 1, xanchor: "left", yanchor: "bottom", yshift: 2,
      text: "<b>" + f.label + "</b>", showarrow: false, textangle: 0,
      font: { size: 13, color: "#e6ebf5" },
    });
  });

  // Banda objetivo y umbrales sobre la glucemia.
  const sg = ax(FILA_GLUCEMIA);
  const lineaG = (y, color, dash, ancho) => ({
    type: "line", xref: "x" + sg, yref: "y" + sg, x0: 0, x1: tmax, y0: y, y1: y,
    line: { color, width: ancho || 1, dash: dash || "dash" }, layer: "below",
  });
  layout.shapes.push(
    { type: "rect", xref: "x" + sg, yref: "y" + sg, x0: 0, x1: tmax, y0: 70, y1: 180,
      fillcolor: "rgba(46,204,113,0.07)", line: { width: 0 }, layer: "below" },
    lineaG(res.r[0], "#9aa3b5", "solid", 1),     // set point
    lineaG(70, "#f5a623", "dash"), lineaG(180, "#f5a623", "dash"),
  );

  // Eje de la insulina: la escala se ajusta a la señal, no al tope de 10 U/h.
  const si = ax(FILA_INSULINA);
  const p = res.params;
  const maxU = res.u.reduce((a, b) => Math.max(a, b), 0);
  const insTop = Math.max(maxU * 1.3, res.u_basal * 1.5, 1.0);
  layout["yaxis" + si].range = [0, insTop];
  layout.shapes.push({
    type: "line", xref: "x" + si, yref: "y" + si, x0: 0, x1: tmax, y0: res.u_basal, y1: res.u_basal,
    line: { color: "#6b7790", width: 1, dash: "dot" }, layer: "below",
  });
  if (p.u_max <= insTop) {
    layout.shapes.push({
      type: "line", xref: "x" + si, yref: "y" + si, x0: 0, x1: tmax, y0: p.u_max, y1: p.u_max,
      line: { color: "#ff6b6b", width: 1, dash: "dash" }, layer: "below",
    });
  }

  Plotly.react("plots", trazas, layout, {
    responsive: true, displaylogo: false,
    modeBarButtonsToRemove: ["lasso2d", "select2d"],
  });
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

// QoS calculado en el navegador sobre la glucemia visible (modo en vivo).
function jsQoS(y) {
  const n = y.length;
  if (!n) return null;
  const pct = (f) => 100 * y.filter(f).length / n;
  const media = y.reduce((a, b) => a + b, 0) / n;
  const valores = {
    TIR_70_180: pct((v) => v >= 70 && v <= 180),
    TBR_70: pct((v) => v < 70),
    TAR_180: pct((v) => v > 180),
    media, min: Math.min.apply(null, y), max: Math.max.apply(null, y),
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

// Rangos verticales fijos en vivo, para que la vista no salte al desplazarse.
function rangosVivo(p) {
  return [
    [p.r0 - 25, p.r0 + 25],   // referencia
    [40, 260],                // glucemia
    [0, 8],                   // insulina
    [40, 260],                // medición
    [-130, 70],               // error
    [-80, 160],               // perturbación (incluye el ejercicio, que baja)
  ];
}

function initLivePlot(p) {
  const ax = (i) => (i === 0 ? "" : i + 1);
  const { major, minor } = densidadTicks(VENTANA);
  const yr = rangosVivo(p);
  const y0 = p.r0;
  const init = [p.r0, y0, Math.max((p.G0 - p.r0) / p.Kp, 0), p.Ks * y0, 0, 0];

  const trazas = SIGNALS.map((s, i) => ({
    x: [0], y: [init[i]], mode: "lines",
    line: { color: s.color, width: 1.8 },
    xaxis: "x" + ax(i), yaxis: "y" + ax(i),
  }));

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
      minor: { dtick: minor, showgrid: true, gridcolor: "#1a2233" },
      gridcolor: "#222a3a", zeroline: false,
      range: [0, VENTANA],
    };
    layout["yaxis" + k] = { gridcolor: "#222a3a", zeroline: false, range: yr[i].slice() };
    layout.annotations.push({
      xref: "x" + k + " domain", yref: "y" + k + " domain",
      x: 0, y: 1, xanchor: "left", yanchor: "bottom", yshift: 2,
      text: "<b>" + s.label + "</b>", showarrow: false, font: { size: 13, color: "#e6ebf5" },
    });
  });

  // Banda objetivo y umbrales de glucemia (fila 2), con x muy ancho para que
  // siempre cubran la ventana mientras se desplaza.
  const BIG = 1e6;
  const lg = (y, c, d, w) => ({
    type: "line", xref: "x2", yref: "y2", x0: -BIG, x1: BIG, y0: y, y1: y,
    line: { color: c, width: w || 1, dash: d || "dash" }, layer: "below",
  });
  layout.shapes.push(
    { type: "rect", xref: "x2", yref: "y2", x0: -BIG, x1: BIG, y0: 70, y1: 180,
      fillcolor: "rgba(46,204,113,0.07)", line: { width: 0 }, layer: "below" },
    lg(p.r0, "#9aa3b5", "solid", 1), lg(70, "#f5a623", "dash"), lg(180, "#f5a623", "dash"),
  );
  // Insulina basal y saturación (fila 3).
  const basal = Math.max((p.G0 - p.r0) / p.Kp, 0);
  layout.shapes.push({
    type: "line", xref: "x3", yref: "y3", x0: -BIG, x1: BIG, y0: basal, y1: basal,
    line: { color: "#6b7790", width: 1, dash: "dot" }, layer: "below",
  });
  if (p.u_max <= 8) layout.shapes.push({
    type: "line", xref: "x3", yref: "y3", x0: -BIG, x1: BIG, y0: p.u_max, y1: p.u_max,
    line: { color: "#ff6b6b", width: 1, dash: "dash" }, layer: "below",
  });

  Plotly.newPlot("plots", trazas, layout, {
    responsive: true, displaylogo: false,
    modeBarButtonsToRemove: ["lasso2d", "select2d"],
  });
}

function startLive() {
  const p = leerParamsCompletos();
  sim = new SimVivo(p);
  initLivePlot(p);
  liveOn = true;
  liveRunning = true;
  liveAcc = 0;
  liveLast = performance.now();
  liveQoSlast = 0;
  setPlay("⏸ Pausar", true);
  dibujarQoS(jsQoS([p.r0]));
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
    const xs = [[], [], [], [], [], []];
    const ys = [[], [], [], [], [], []];
    for (let s = 0; s < pasos; s++) {
      const o = sim.step();
      const vals = [o.r, o.y, o.u, o.ym, o.e, o.d];
      for (let i = 0; i < 6; i++) { xs[i].push(o.t); ys[i].push(vals[i]); }
    }
    Plotly.extendTraces("plots", { x: xs, y: ys }, [0, 1, 2, 3, 4, 5], VENTANA + 120);

    const t = sim.t;
    const x0 = Math.max(0, t - VENTANA);
    Plotly.relayout("plots", { "xaxis.range": [x0, x0 + VENTANA] });

    if (now - liveQoSlast > 600) {                   // QoS en vivo, sin recargar cada frame
      liveQoSlast = now;
      const gd = $("plots");
      if (gd && gd.data && gd.data[1]) dibujarQoS(jsQoS(gd.data[1].y));
    }
  }
  liveRaf = requestAnimationFrame(liveFrame);
}

function stopLive() {
  if (liveRaf) { cancelAnimationFrame(liveRaf); liveRaf = null; }
  liveOn = false;
  liveRunning = false;
  sim = null;
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
  if (sim) sim.inject(tipo);
}

function reiniciarLive() {
  if (!liveOn) { startLive(); return; }
  sim.reset();
  initLivePlot(sim.p);
  liveAcc = 0;
  liveLast = performance.now();
}

// Velocidad: el bucle en vivo la lee en cada frame, el cambio es inmediato.
function setVelocidad(v) {
  velocidad = v;
  $("velLabel").textContent = v.toFixed(1) + "×";
}

// -------------------------------------------------------------- presets (estático)
function preset(nombre) {
  stopLive();
  aplicarDefaults();
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

  PARAM_IDS.forEach((id) => $(id).addEventListener("input", simularDebounce));
  $("ev-add").addEventListener("click", agregarEvento);
  $("btn-reset").addEventListener("click", () => { aplicarDefaults(); simular(); });
  $("btn-png").addEventListener("click", descargarPNG);
  $("btn-play").addEventListener("click", togglePlay);
  $("toggle-panel").addEventListener("click", togglePanel);
  $("vel").addEventListener("input", (e) => setVelocidad(parseFloat(e.target.value)));
  $("btn-comida-liviana").addEventListener("click", () => inyectar("liviana"));
  $("btn-comida-alta").addEventListener("click", () => inyectar("alta"));
  $("btn-ejercicio").addEventListener("click", () => inyectar("ejercicio"));
  $("btn-estres").addEventListener("click", () => inyectar("estres"));
  $("btn-reiniciar").addEventListener("click", reiniciarLive);
  document.querySelectorAll(".preset").forEach((b) =>
    b.addEventListener("click", () => preset(b.dataset.preset)));

  setVelocidad(parseFloat($("vel").value));   // sincroniza la etiqueta de velocidad
  preset("comida");   // vista estática inicial
}

document.addEventListener("DOMContentLoaded", init);
