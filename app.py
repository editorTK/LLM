import os
import json
from flask import Flask, request, jsonify, Response, stream_with_context
from flask_cors import CORS
from openai import OpenAI

"""Minimal Flask backend proxying chat requests to OpenAI.

- `GET /health` returns a simple health check.
- `POST /chat` forwards messages to OpenAI and optionally streams
  the response using Server‑Sent Events (SSE).

Environment variables:
- OPENAI_API_KEY: required for authentication. If missing `/chat`
  responds with 401.
- OPENAI_MODEL: optional model name (default: gpt-5-nano).
- PORT: port used when running directly (Railway sets it).
"""

app = Flask(__name__)
CORS(app)

OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-5-nano")


def _clean_messages(messages):
    """Extract only textual content from messages."""
    cleaned = []
    for m in messages or []:
        role = m.get("role")
        content = m.get("content", "")
        if isinstance(content, list):
            parts = [c.get("text", "") for c in content if c.get("type") == "text"]
            content = "\n".join(p for p in parts if p)
        cleaned.append({"role": role, "content": content})
    return cleaned


@app.get("/health")
def health():
    return jsonify({"ok": True, "model": OPENAI_MODEL})


@app.post("/chat")
def chat():
    api_key = os.environ.get("OPENAI_API_KEY")
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
            def generate():
                try:
                    response = client.chat.completions.create(
                        model=OPENAI_MODEL,
                        messages=cleaned,
                        stream=True,
                    )
                    for chunk in response:
                        delta = chunk.choices[0].delta.get("content")
                        if delta:
                            payload = json.dumps({"text": delta})
                            yield f"data: {payload}\n\n"
                    yield "data: [DONE]\n\n"
                except Exception as e:
                    yield f"data: {json.dumps({'error': str(e)})}\n\n"
            return Response(stream_with_context(generate()), mimetype="text/event-stream")
        else:
            response = client.chat.completions.create(
                model=OPENAI_MODEL,
                messages=cleaned,
            )
            text = response.choices[0].message.content
            return jsonify({"text": text})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
