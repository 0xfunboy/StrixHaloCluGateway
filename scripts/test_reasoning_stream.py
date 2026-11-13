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
import queue
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

GATEWAY_PY = Path(__file__).resolve().parent.parent / "gateway.py"


class Upstream(BaseHTTPRequestHandler):
    payloads = queue.Queue()
    context_length = 262144

    def do_GET(self):  # noqa: N802
        model = {"id": "deepseek-v4.1-flash"}
        if self.context_length is not None:
            model["context_length"] = self.context_length
        body = json.dumps({"object": "list", "data": [model]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):  # noqa: N802
        self.payloads.put(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
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
    gw.DEEPSEEK_PORT = upstream_port
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

    def request(headers, model=None, options=None):
        payload = {
            "model": model or gw.MODEL_QWEN_ID,
            "stream": True,
            "messages": [{"role": "user", "content": "test"}],
        }
        if options:
            payload.update(options)
        body = json.dumps(payload).encode()
        req = urllib.request.Request(
            f"http://127.0.0.1:{server.server_port}/v1/chat/completions",
            data=body,
            headers={"Content-Type": "application/json", **headers},
        )
        text = urllib.request.urlopen(req, timeout=10).read().decode()
        events = [
            json.loads(line[6:])
            for line in text.splitlines()
            if line.startswith("data: ") and line != "data: [DONE]"
        ]
        return events, Upstream.payloads.get(timeout=1)

    try:
        # 1. native: cot_id stabile su tutti i delta di reasoning
        events, _ = request({})
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
        events, _ = request({"X-Think-Format": "inline"})
        deltas = [e["choices"][0]["delta"] for e in events]
        assert all("cot_id" not in d for d in deltas), "cot_id presente in modalita' inline"
        joined = "".join(d.get("content", "") for d in deltas)
        assert joined == "<think>\nuno due tre\n</think>\n\nrisposta", f"inline alterato: {joined!r}"

        def forwarded_option(payload, key):
            return payload.get("chat_template_kwargs", {}).get(key, payload.get(key))

        for model_id, default_tokens in ((gw.MODEL_DEEPSEEK_ID, 6144), (gw.MODEL_QWEN_ID, 8192)):
            _, default_limit = request({}, model_id)
            assert default_limit["max_tokens"] == default_tokens
            _, completion_limit = request({}, model_id, {"max_completion_tokens": 8})
            assert completion_limit["max_completion_tokens"] == 8
            assert "max_tokens" not in completion_limit
            _, legacy_limit = request({}, model_id, {"max_tokens": 16})
            assert legacy_limit["max_tokens"] == 16
            _, both_limits = request({}, model_id, {"max_tokens": 16, "max_completion_tokens": 8})
            assert both_limits["max_completion_tokens"] == 8
            assert "max_tokens" not in both_limits

        _, defaults = request({}, gw.MODEL_DEEPSEEK_ID)
        assert forwarded_option(defaults, "enable_thinking") is True
        assert forwarded_option(defaults, "reasoning_effort") == "xhigh"
        assert defaults["context_tokens"] == 262144

        with urllib.request.urlopen(f"http://127.0.0.1:{server.server_port}/v1/models", timeout=10) as response:
            models = {model["id"]: model for model in json.load(response)["data"]}
        for model_id in (gw.MODEL_DEEPSEEK_ID, "deepseek-v4.1-flash"):
            assert models[model_id]["context_length"] == 262144
            assert models[model_id]["max_input_tokens"] == 256000
            assert models[model_id]["max_output_tokens"] == 6144

        Upstream.context_length = 131072
        with urllib.request.urlopen(f"http://127.0.0.1:{server.server_port}/v1/models", timeout=10) as response:
            models = {model["id"]: model for model in json.load(response)["data"]}
        for model_id in (gw.MODEL_DEEPSEEK_ID, "deepseek-v4.1-flash"):
            assert models[model_id]["context_length"] == 131072
            assert models[model_id]["max_input_tokens"] == 124928
        _, short_context = request({}, gw.MODEL_DEEPSEEK_ID)
        assert short_context["context_tokens"] == 131072

        Upstream.context_length = None
        with urllib.request.urlopen(f"http://127.0.0.1:{server.server_port}/v1/models", timeout=10) as response:
            models = {model["id"]: model for model in json.load(response)["data"]}
        assert models[gw.MODEL_DEEPSEEK_ID]["context_length"] == 131072
        _, unknown_context = request({}, gw.MODEL_DEEPSEEK_ID)
        assert unknown_context["context_tokens"] == 131072
        Upstream.context_length = 262144

        _, low = request({}, gw.MODEL_DEEPSEEK_ID, {"reasoning_effort": "low"})
        assert forwarded_option(low, "reasoning_effort") == "low"

        _, disabled = request({}, gw.MODEL_DEEPSEEK_ID, {"enable_thinking": False, "reasoning_effort": "none"})
        assert forwarded_option(disabled, "enable_thinking") is False
        assert forwarded_option(disabled, "reasoning_effort") == "none"

        _, explicit = request({}, gw.MODEL_DEEPSEEK_ID, {
            "enable_thinking": True,
            "reasoning_effort": "low",
            "chat_template_kwargs": {"enable_thinking": False, "reasoning_effort": "medium"},
        })
        assert forwarded_option(explicit, "enable_thinking") is False
        assert forwarded_option(explicit, "reasoning_effort") == "medium"

        try:
            request({}, gw.MODEL_DEEPSEEK_ID, {"chat_template_kwargs": ["invalid"]})
        except urllib.error.HTTPError as error:
            assert error.code == 400
        else:
            raise AssertionError("chat_template_kwargs non valido deve produrre un errore 400")

        print("OK: streaming reasoning e opzioni DeepSeek")
        return 0
    finally:
        server.shutdown()
        up.shutdown()


if __name__ == "__main__":
    raise SystemExit(main())
