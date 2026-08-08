# A stand-in Anthropic API endpoint: records every request a Claude Code
# session makes and answers from a canned script, so patch behavior can be
# asserted on the outgoing payloads without spending tokens or depending on a
# live model.
#
# Point a candidate binary at it with the environment from `env_for()`.
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def sse(event, data):
    return f"event: {event}\ndata: {json.dumps(data)}\n\n".encode()


def stream_for(blocks):
    """SSE byte stream for one assistant turn made of `blocks`.

    A block is {"text": "..."}, {"thinking": "..."}, or
    {"tool": name, "id": id, "input": {...}}.
    """
    out = [
        sse("message_start", {
            "type": "message_start",
            "message": {
                "id": "msg_canned", "type": "message", "role": "assistant",
                "model": "claude-canned", "content": [], "stop_reason": None,
                "stop_sequence": None,
                "usage": {"input_tokens": 100, "output_tokens": 1},
            },
        })
    ]
    stop = "end_turn"
    for i, block in enumerate(blocks):
        if "text" in block:
            out.append(sse("content_block_start", {
                "type": "content_block_start", "index": i,
                "content_block": {"type": "text", "text": ""}}))
            out.append(sse("content_block_delta", {
                "type": "content_block_delta", "index": i,
                "delta": {"type": "text_delta", "text": block["text"]}}))
        elif "thinking" in block:
            # The signature is opaque to the client, which only carries it back
            # on the next request, so any string does.
            out.append(sse("content_block_start", {
                "type": "content_block_start", "index": i,
                "content_block": {"type": "thinking", "thinking": "",
                                  "signature": ""}}))
            out.append(sse("content_block_delta", {
                "type": "content_block_delta", "index": i,
                "delta": {"type": "thinking_delta",
                          "thinking": block["thinking"]}}))
            out.append(sse("content_block_delta", {
                "type": "content_block_delta", "index": i,
                "delta": {"type": "signature_delta",
                          "signature": "canned-signature"}}))
        else:
            stop = "tool_use"
            out.append(sse("content_block_start", {
                "type": "content_block_start", "index": i,
                "content_block": {"type": "tool_use", "id": block["id"],
                                  "name": block["tool"], "input": {}}}))
            out.append(sse("content_block_delta", {
                "type": "content_block_delta", "index": i,
                "delta": {"type": "input_json_delta",
                          "partial_json": json.dumps(block["input"])}}))
        out.append(sse("content_block_stop", {"type": "content_block_stop", "index": i}))
    out.append(sse("message_delta", {
        "type": "message_delta",
        "delta": {"stop_reason": stop, "stop_sequence": None},
        "usage": {"output_tokens": 10}}))
    out.append(sse("message_stop", {"type": "message_stop"}))
    return b"".join(out)


class CaptureProxy:
    """Records requests; answers each /v1/messages call from `script`.

    `script` is a list of turns; once exhausted every further call answers with
    a plain "done" so the session always terminates. A turn is either a list of
    blocks or a callable taking the request body and returning one, for turns
    that have to read what the session just sent — a tool result's id, say — or
    to hold the answer back while the session does something in the background.
    """

    def __init__(self, script=None):
        self.requests = []
        self.script = list(script or [])
        self.lock = threading.Lock()
        proxy = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_):
                pass

            def _body(self):
                n = int(self.headers.get("content-length", 0))
                raw = self.rfile.read(n) if n else b""
                try:
                    return json.loads(raw)
                except ValueError:
                    return {"_raw": raw.decode("utf8", "replace")}

            def do_POST(self):
                body = self._body()
                # Only the session's own turns carry the tool list; the CLI's
                # side calls (titles, summaries) must not eat scripted turns.
                session_turn = bool(body.get("tools"))
                with proxy.lock:
                    proxy.requests.append({"path": self.path, "body": body})
                    blocks = (proxy.script.pop(0)
                              if session_turn and proxy.script else [{"text": "done"}])
                if "count_tokens" in self.path:
                    return self._json({"input_tokens": 100})
                # Outside the lock: a callable turn may block on purpose.
                payload = stream_for(blocks(body) if callable(blocks) else blocks)
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.send_header("content-length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def do_GET(self):
                self._json({"data": []})

            def _json(self, obj):
                payload = json.dumps(obj).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]

    def __enter__(self):
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return self

    def __exit__(self, *_):
        self.server.shutdown()

    def env_for(self, extra=None):
        env = {
            "ANTHROPIC_BASE_URL": f"http://127.0.0.1:{self.port}",
            # A bearer token, not ANTHROPIC_API_KEY: the interactive TUI stops on
            # a "custom API key detected" confirmation for the latter.
            "ANTHROPIC_AUTH_TOKEN": "capture-proxy",
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            "DISABLE_AUTOUPDATER": "1",
            "DISABLE_TELEMETRY": "1",
            "DISABLE_ERROR_REPORTING": "1",
        }
        env.update(extra or {})
        return env

    def main_request(self):
        """The session's own turn: the largest captured /v1/messages payload.

        Claude Code also makes small side calls (titles, summaries) whose system
        prompt is a one-liner; the session request is always the biggest.
        """
        calls = [r for r in self.requests if "count_tokens" not in r["path"]]
        if not calls:
            raise AssertionError("the candidate made no API request")
        return max(calls, key=lambda r: len(json.dumps(r["body"])))["body"]


def system_text(body):
    system = body.get("system", "")
    if isinstance(system, list):
        return "\n".join(b.get("text", "") for b in system)
    return system


def user_text(body):
    out = []
    for message in body.get("messages", []):
        content = message.get("content")
        if isinstance(content, str):
            out.append(content)
        elif isinstance(content, list):
            for block in content:
                if block.get("type") == "text":
                    out.append(block.get("text", ""))
    return "\n".join(out)
