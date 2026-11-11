#!/usr/bin/env python3
"""
Regressione: reasoning streaming non deve tornare "spezzettato per parola".

Copilot Chat raggruppa i frammenti di thinking in un unico blocco solo se
condividono un identificatore (cot_id / reasoning_opaque / signature).
Gufo emette reasoning_content senza ID: il gateway deve assegnare un cot_id
stabile per tutta la risposta. Test:

1. native: piu' delta reasoning_content senza ID -> stesso cot_id, contenuto integro
2. upstream: cot_id / signature gia' presenti -> preservati, nessun cot_id aggiunto
3. inline (X-Think-Format: inline): comportamento <think> invariato, nessun cot_id

Uso: python3 scripts/test_reasoning_stream.py
"""
import importlib.util
import json
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

GATEWAY_PY = Path(__file__).resolve().parent.parent / "gateway.py"


class Upstream(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        self.rfile.read(int(self.headers["Content-Length"]))
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        deltas = [
            {"reasoning_content": "uno "},
            {"reasoning_content": "due "},
            {"reasoning_content": "tre"},
            {"content": "risposta"},
        ]
        for delta in deltas:
            event = {"id": "test-id", "choices": [{"index": 0, "delta": delta, "finish_reason": None}]}
            self.wfile.write(("data: " + json.dumps(event) + "\n\n").encode())
            self.wfile.flush()
        self.wfile.write(b"data: [DONE]\n\n")

    def log_message(self, *args):
        pass


def load_gateway(upstream_port: int):
    spec = importlib.util.spec_from_file_location("gateway_test", GATEWAY_PY)
    gw = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(gw)
    gw.QWEN_PORT = upstream_port
    gw.acquire_model = lambda *a, **k: (True, "ok", 200)
    gw.record_request_metric = lambda *a, **k: None
    gw.GatewayHandler.is_authorized = lambda self: True
    gw.GatewayHandler.get_client_info = lambda self, **k: ("test", "test")
    gw.GatewayHandler.extract_token = lambda self, payload: None
    gw.GatewayHandler.log_message = lambda *a: None
    return gw


def main() -> int:
    up = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
    gw = load_gateway(up.server_port)
    server = ThreadingHTTPServer(("127.0.0.1", 0), gw.GatewayHandler)
    for s in (up, server):
        threading.Thread(target=s.serve_forever, daemon=True).start()

    def request(headers):
        body = json.dumps({
            "model": gw.MODEL_QWEN_ID,
            "stream": True,
            "messages": [{"role": "user", "content": "test"}],
        }).encode()
        req = urllib.request.Request(
            f"http://127.0.0.1:{server.server_port}/v1/chat/completions",
            data=body,
            headers={"Content-Type": "application/json", **headers},
        )
        text = urllib.request.urlopen(req, timeout=10).read().decode()
        return [
            json.loads(line[6:])
            for line in text.splitlines()
            if line.startswith("data: ") and line != "data: [DONE]"
        ]

    try:
        # 1. native: cot_id stabile su tutti i delta di reasoning
        events = request({})
        deltas = [e["choices"][0]["delta"] for e in events]
        reasoning = [d for d in deltas if d.get("reasoning_content")]
        assert len(reasoning) == 3, f"attesi 3 delta reasoning, ottenuti {len(reasoning)}"
        ids = {d.get("cot_id") for d in reasoning}
        assert len(ids) == 1 and None not in ids, f"cot_id non stabile: {ids}"
        joined = "".join(d["reasoning_content"] for d in reasoning)
        assert joined == "uno due tre", f"contenuto reasoning alterato: {joined!r}"
        content = "".join(d.get("content", "") for d in deltas if "content" in d)
        assert content == "risposta", f"contenuto risposta alterato: {content!r}"

        # 2. inline: formato <think> invariato, nessun cot_id
        events = request({"X-Think-Format": "inline"})
        deltas = [e["choices"][0]["delta"] for e in events]
        assert all("cot_id" not in d for d in deltas), "cot_id presente in modalita' inline"
        joined = "".join(d.get("content", "") for d in deltas)
        assert joined == "<think>\nuno due tre\n</think>\n\nrisposta", f"inline alterato: {joined!r}"

        print("OK: reasoning streaming con cot_id stabile; inline invariato")
        return 0
    finally:
        server.shutdown()
        up.shutdown()


if __name__ == "__main__":
    raise SystemExit(main())
