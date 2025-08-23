import os
import json
from flask import Flask, request, jsonify, Response, stream_with_context
from flask_cors import CORS
from openai import OpenAI

"""Flask backend that forwards chat requests to OpenAI.

Streaming is enabled when clients send {"stream": true};
partial responses are sent using Server-Sent Events (SSE) with
`data: {"delta": "..."}` lines. Railway captures standard output and
error streams, so logs produced with `print` or `app.logger` are visible in
Railway's dashboard for debugging.
"""

app = Flask(__name__)
CORS(app)

client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))


def _clean_messages(messages):
    """Strip unsupported fields such as images from messages.

    Each message may contain a `content` that is either a string or a list
    with objects like `{type:"text", text:"..."}` or `{type:"file", ...}`.
    Only text items are concatenated and sent to OpenAI.
    """
    cleaned = []
    for m in messages or []:
        role = m.get("role")
        content = m.get("content", "")
        if isinstance(content, list):
            parts = [c.get("text", "") for c in content if c.get("type") == "text"]
            content = "\n".join(p for p in parts if p)
        cleaned.append({"role": role, "content": content})
    return cleaned


def _chat_name(messages):
    """Derive a simple chat name from the first user message."""
    for m in messages:
        if m.get("role") == "user":
            content = m.get("content", "")
            if isinstance(content, list):
                parts = [c.get("text", "") for c in content if c.get("type") == "text"]
                content = " ".join(parts)
            return content[:40] or "Chat"
    return "Chat"


@app.route("/chat", methods=["POST"])
def chat():
    data = request.get_json(silent=True) or {}
    messages = data.get("messages")
    user_id = data.get("user_id")
    stream = bool(data.get("stream"))

    if not messages or not user_id:
        return jsonify({"error": "messages and user_id required"}), 400

    cleaned = _clean_messages(messages)

    try:
        if stream:
            def generate():
                try:
                    response = client.chat.completions.create(
                        model="gpt-5-nano",
                        messages=cleaned,
                        stream=True,
                    )
                    for chunk in response:
                        delta = chunk.choices[0].delta.get("content")
                        if delta:
                            yield f"data: {json.dumps({'delta': delta})}\n\n"
                    yield "data: [DONE]\n\n"
                except Exception:
                    app.logger.exception("OpenAI streaming error")
                    yield f"data: {json.dumps({'error': 'OpenAI request failed'})}\n\n"
            return Response(stream_with_context(generate()), mimetype="text/event-stream")
        else:
            response = client.chat.completions.create(
                model="gpt-5-nano",
                messages=cleaned,
            )
            answer = response.choices[0].message.content
            chat_name = _chat_name(messages)
            return jsonify({"answer": answer, "chat_name": chat_name})
    except Exception:
        app.logger.exception("OpenAI request failed")
        return jsonify({"error": "OpenAI request failed"}), 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    # Railway sets PORT env var automatically.
    app.run(host="0.0.0.0", port=port)
