import os, json
from typing import Iterable, Dict, Any
from flask import Flask, request, jsonify, Response, stream_with_context
from flask_cors import CORS
from openai import OpenAI

"""
Flask backend para proxy de chat con OpenAI (gpt-5-nano), listo para Railway.

Endpoints:
- GET  /health  -> {"ok": true, "model": <model>}
- POST /chat    -> body: {"messages":[...], "stream": true|false}
                   stream=true  -> Server-Sent Events (SSE)
                   stream=false -> {"text": "<respuesta completa>"}

ENV:
- OPENAI_API_KEY (requerido) -> clave de OpenAI
- OPENAI_MODEL (opcional)    -> por defecto "gpt-5-nano"
- PORT (opcional)            -> Railway lo inyecta automáticamente
"""

app = Flask(__name__)
# Habilita CORS para que el frontend (en tu dominio) pueda llamar al backend
CORS(app, supports_credentials=True)

OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-5-nano")


def _clean_messages(messages: Any) -> list[Dict[str, str]]:
    """
    Normaliza el array de mensajes a [{role, content:str}] solo-texto.
    Si algún content viene como array multimodal, se concatena el 'text'.
    """
    cleaned = []
    for m in messages or []:
        role = m.get("role", "")
        content = m.get("content", "")
        if isinstance(content, list):
            parts = [c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text"]
            content = "\n".join(p for p in parts if p)
        elif not isinstance(content, str):
            content = str(content or "")
        cleaned.append({"role": role, "content": content})
    return cleaned


def _sse_headers(resp: Response) -> Response:
    """Aplica cabeceras recomendadas para SSE."""
    resp.headers["Content-Type"] = "text/event-stream"
    resp.headers["Cache-Control"] = "no-cache"
    resp.headers["Connection"] = "keep-alive"
    # Evita buffering en algunos reverse proxies (Nginx):
    resp.headers["X-Accel-Buffering"] = "no"
    return resp


@app.get("/health")
def health():
    return jsonify({"ok": True, "model": OPENAI_MODEL})


@app.post("/chat")
def chat():
    # Verificación de API key
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        return jsonify({"error": "missing OPENAI_API_KEY"}), 401

    data = request.get_json(silent=True) or {}
    messages = data.get("messages")
    stream = bool(data.get("stream"))

    if not messages:
        return jsonify({"error": "messages required"}), 400

    client = OpenAI(api_key=api_key)
    cleaned = _clean_messages(messages)

    try:
        if stream:
            # Streaming por SSE
            def generate() -> Iterable[str]:
                try:
                    # Nota SDK: en openai>=1.x, create(..., stream=True) devuelve un generador de chunks
                    resp = client.chat.completions.create(
                        model=OPENAI_MODEL,
                        messages=cleaned,
                        stream=True,
                    )
                    for chunk in resp:
                        # chunk.choices[0].delta.content puede ser None o str
                        try:
                            delta = chunk.choices[0].delta.get("content")  # type: ignore[attr-defined]
                        except Exception:
                            # Compatibilidad si el SDK expone el delta de forma distinta
                            delta = None
                        if delta:
                            payload = json.dumps({"text": delta})
                            yield f"data: {payload}\n\n"
                    # Fin del stream
                    yield "data: [DONE]\n\n"
                except Exception as e:
                    # Enviar el error como evento para que el front pueda mostrarlo
                    err = json.dumps({"error": f"OpenAI stream error: {str(e)}"})
                    yield f"data: {err}\n\n"

            resp = Response(stream_with_context(generate()))
            return _sse_headers(resp)

        else:
            # Respuesta completa (primer turno: el front parsea JSON {answer, chat_name})
            resp = client.chat.completions.create(
                model=OPENAI_MODEL,
                messages=cleaned,
            )
            text = ""
            try:
                text = resp.choices[0].message.content or ""
            except Exception:
                # Fallback por si la forma del objeto cambia
                text = str(resp)
            return jsonify({"text": text})

    except Exception as e:
        # Errores generales (red, timeouts, credenciales, etc.)
        return jsonify({"error": f"OpenAI error: {str(e)}"}), 500


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8080"))
    app.run(host="0.0.0.0", port=port)
