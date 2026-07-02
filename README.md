# Simulación del lazo de control — Bomba de insulina

Simulador del lazo cerrado de regulación de glucemia de una bomba de insulina,
para el **TP Integrador de Teoría de Control** (UTN-FRBA, K4011, 2026 - Moll / Maffini).

El objetivo es **mostrar gráficamente el comportamiento del sistema respecto del
control**, relacionando todas las señales del diagrama de bloques una debajo de la
otra para ver las correlaciones a simple vista. No emula un equipo real: simula el
modelo (funciones de transferencia del TP) e ilustra el *resultado* de cada bloque.

## Qué muestra

Seis señales apiladas con el eje de tiempo (en minutos) compartido:

| # | Señal | Símbolo | Descripción |
|---|---|---|---|
| 1 | Referencia θᵢ | `r(t)`  | Set point de glucemia |
| 2 | Glucemia θ₀   | `y(t)`  | Variable controlada (con banda 70–180 y umbrales hipo/hiper) |
| 3 | Salida del controlador | `u(t)` | Tasa de insulina (con líneas de saturación y basal) |
| 4 | Señal de medición | `yₘ(t)` | Glucemia leída por el CGM |
| 5 | Error         | `e(t)`  | `r − yₘ` |
| 6 | Perturbación  | `d(t)`  | Comida / ejercicio / estrés (efecto sobre la glucemia) |

Además calcula las métricas de **Calidad de Servicio (QoS)** — TIR (70–180),
TBR (<70) y TAR (>180) — con su semáforo de cumplimiento respecto de los objetivos
del Consenso Internacional sobre Tiempo en Rango, más un resumen de glucemia
media/mín/máx.

## Cómo se ejecuta

```bash
pip install -r requirements.txt
python app.py
```

Abrir <http://127.0.0.1:5000>.

## Dos modos de uso

El panel de control está dividido en dos zonas:

### 1. Configuración (análisis estático)

Corre una simulación completa de duración fija y muestra las seis señales de una
vez, con sus métricas QoS. Ideal para analizar un escenario y exportar la figura.

- **Escenarios:** *1 comida* y *24 h · 4 comidas* (con varianza entre comidas).
- **Controles editables** (al modificar cualquiera, la corrida se recalcula al instante):
  - **Referencia:** set point `r`.
  - **Bomba:** saturación de insulina (`u_min`, `u_max`), resolución y tope de IOB.
  - **Tiempos:** duración, período de control `Ts` y paso interno `dt`.
  - **Perturbaciones:** se agregan eventos (comida, ejercicio, estrés) indicando hora,
    duración y magnitud.
- **Descargar PNG:** figura lista para incrustar en el informe.

> La planta, el sensor y el PID quedan fijos en sus valores del TP (no se ajustan
> en vivo), para una demostración clara y defendible.

### 2. Tiempo real (simulador dinámico)

Integra el lazo **en el navegador, paso a paso, con un reloj que avanza**. Las
señales se van dibujando en vivo (ventana deslizante de los últimos 240 min) y se
pueden **inyectar perturbaciones en el instante actual** para ver el impacto
propagarse por todas las señales con sus retardos reales.

- **▶ Iniciar tiempo real:** arranca en régimen, plano en el set point.
- **Velocidad:** slider (0.5×–4×); cambia el ritmo al instante (a 1× ≈ 12 min
  simulados por segundo real).
- **Eventos en vivo** (se inyectan en el momento en que se tocan):
  - *Comida liviana* y *Comida alta en glucosa*.
  - *Ejercicio* (baja la glucemia → el control reduce/suspende la insulina).
  - *Situación estresante* (sube la glucemia → el control entrega más insulina).
- **⏸ Pausar / ▶ Reanudar** y **↺ Reiniciar** (vuelve a régimen y limpia la pantalla).
- Para volver al análisis estático, elegí un escenario o editá un parámetro.

El motor de tiempo real (`static/livesim.js`) **espeja exactamente** el modelo de
Python (mismas ecuaciones y parámetros), por lo que ambos modos coinciden.

#### Modelado de las perturbaciones en vivo (con fuentes)

| Evento | Efecto sobre la glucemia | Forma / duración | Base |
|---|---|---|---|
| Comida liviana | +50 mg/dL | pulso ~90 min | subida posprandial moderada |
| Comida alta | +130 mg/dL | pulso ~150 min | subida posprandial alta |
| Ejercicio | **−60 mg/dL** | meseta ~45 min | ejercicio aeróbico moderado: mayor caída glucémica; 30–60 min requieren HC/menos insulina para evitar hipo (ADA 2016; T1DEXI 2023) |
| Estrés | **+40 mg/dL** | meseta ~150 min | estrés agudo: ~+35 mg/dL promedio (rango 20–>100), pico a los 30–45 min, resolución 2–4 h |

Fuentes:

- ADA Position Statement — *Physical Activity/Exercise and Diabetes* (Colberg et al.,
  Diabetes Care 2016). <https://diabetesjournals.org/care/article/39/11/2065/37249>
- *T1DEXI — Acute Glycemic Effects of Structured Exercise in Type 1 Diabetes*
  (Diabetes Care 2023). <https://diabetesjournals.org/care/article/46/4/704/148382>
- *Neural Regulation of Blood Glucose in Acute Stress* (Diabetes, ADA 2026).
  <https://diabetesjournals.org/diabetes/article/75/1/5/163851>
- *Effect of Acute Psychological Stress on Glucose in Type 2 Diabetes*
  (ClinicalTrials NCT00442884). <https://clinicaltrials.gov/study/NCT00442884>

## Modelo (resumen)

- Planta FOPDT: `Gp(s) = −Kp·e^(−θs)/(τs+1)` — `Kp=36`, `τ=70 min`, `θ=20 min`.
- Sensor CGM: `H(s) = Ks/(τs·s+1)` — `Ks=1`, `τs=5 min`.
- Actuador: `Ga = Ka = 1`.
- Controlador: `Gc(s) = Kc·(1 + 1/(Ti·s) + Td·s)` con anti-windup e IOB.
- Integración por Euler con `dt = 1 min`; el control se actualiza cada `Ts = 5 min`.
- El retardo `θ` se implementa con un buffer de retardo real (sin aproximar).
- La perturbación entra en la entrada de la planta (mismo sumador que la insulina).

> Nota de signo (acción inversa): como la planta tiene ganancia negativa (la
> insulina baja la glucemia), la acción de control se calcula sobre `yₘ − r` para
> que la realimentación sea negativa; el error `e = r − yₘ` se reporta igual para
> graficarlo. Equivale a un controlador de ganancia negativa en el diagrama del TP.

## Estructura

```
app.py                  Servidor Flask (panel + endpoint /simular)
simulacion/
  modelo.py             Planta FOPDT + buffer de retardo, sensor CGM, actuador
  controlador.py        PID discreto con saturación, anti-windup e IOB
  lazo.py               Integración del lazo cerrado y armado de escenarios
  metricas.py           Métricas QoS (TIR / TBR / TAR)
templates/index.html    Panel (zona Configuración + zona Tiempo real)
static/
  panel.js              Interfaz, gráficos Plotly (estático), export PNG y modo en vivo
  livesim.js            Motor de simulación en tiempo real (espeja el modelo de Python)
  panel.css             Estilos
```
