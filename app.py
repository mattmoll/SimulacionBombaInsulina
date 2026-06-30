"""
Panel web de la simulación del lazo de control de la bomba de insulina.

Ejecutar:
    python app.py
y abrir http://127.0.0.1:5000 en el navegador.

El backend (Flask) sólo sirve el panel y un endpoint /simular que recibe los
parámetros y los eventos de perturbación, corre la simulación (numpy) y devuelve
todas las señales en JSON. El graficado y la interacción ocurren en el navegador
con Plotly.js, de modo que mover cualquier control recalcula la corrida al instante.
"""

from flask import Flask, jsonify, render_template, request

from simulacion import lazo

app = Flask(__name__)


@app.route("/")
def index():
    return render_template("index.html", defaults=lazo._defaults())


@app.route("/simular", methods=["POST"])
def simular():
    datos = request.get_json(force=True) or {}
    params = datos.get("params", {})
    eventos = datos.get("eventos", [])
    resultado = lazo.simular(params, eventos)
    return jsonify(resultado)


if __name__ == "__main__":
    app.run(debug=True, port=5000)
