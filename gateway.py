#!/usr/bin/env python3
"""
yed1z local inference - Unified Gateway & Analytics Dashboard
Dual AMD Strix Halo Cluster (gfx1151 / 256GB Unified Memory)

Endpoints:
- Web Dashboard: GET / and GET /static/*
- Telemetry API: GET /api/telemetry, POST /api/switch
- OpenAI API: POST /v1/chat/completions, GET /v1/models, GET /health
- Multi-User Arbitration (Anti-Collisione Roma/Livorno)
"""

from __future__ import annotations

import contextlib
import http.client
import json
import mimetypes
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

GATEWAY_DIR = Path("/home/funboy/Gateway")
STATIC_DIR = GATEWAY_DIR / "static"
DATA_DIR = GATEWAY_DIR / "data"
STATS_FILE = DATA_DIR / "stats.json"
KEYS_FILE = DATA_DIR / "api_keys.json"

DEEPSEEK_PORT = 18231
QWEN_PORT = 18562
PRIMARY_PORT = 8081
SECONDARY_PORT = 18561

AIREWARD_HOST = "192.168.178.47"
AIREWARD_AGENT_PORT = 8090
AIREWARD_STRATA_PORT = 8080

MODEL_DEEPSEEK_ID = "ds41-abliterated-q2-imatrix"
MODEL_QWEN_ID = "qwen38-uncensored-gufo"
MODEL_STRATA_QWEN_ID = "qwen38-strata-100tps"
MODEL_STRATA_DEEPSEEK_ID = "ds41-strata-cuda"

STRATA_QWEN_ALIASES = {
    MODEL_STRATA_QWEN_ID,
    "qwen-strata",
    "strata-qwen",
    "qwen38-strata",
    "qwen3.8-flash-next-iq3_s",
    "qwen-100tps",
    "qwen-rtx3090",
}

STRATA_DEEPSEEK_ALIASES = {
    MODEL_STRATA_DEEPSEEK_ID,
    "ds41-strata",
    "strata-ds41",
    "deepseek-strata",
    "deepseek-v4.1-flash-ist-das-2.00bpw",
    "deepseek-rtx3090",
}

class DownstreamClientDisconnected(Exception):
    pass

STATE_LOCK = threading.RLock()
SWITCH_LOCK = threading.Lock()
STATS_LOCK = threading.Lock()
DEEPSEEK_CONCURRENCY_LOCK = threading.Lock()

IN_FLIGHT_COUNT = 0
IN_FLIGHT_MODEL = None
LAST_ACTIVITY_TIME = 0.0

# Cached telemetry with comprehensive hardware sensors
CLUSTER_TELEMETRY = {
    "node01": {
        "hostname": "01-EVO-X3",
        "role": "Coordinator (Rank 0)",
        "status": "online",
        "alert_level": "healthy",
        "temps": {"cpu_c": 42.0, "gpu_c": 41.0, "nvme_c": 32.9},
        "gpu": {"load_pct": 0, "sclk_mhz": 605, "power_w": 11.0, "arch": "gfx1151 / RDNA 3.5"},
        "cooling": {"fan_rpm": 1940, "fan_pwm_pct": 40, "profile": "Smart Thermal EC"},
        "ram": {"used_gb": 104.1, "total_gb": 122.2, "free_gb": 18.1, "pct": 85},
        "disk": {"used_gb": 1190.4, "total_gb": 1831.7, "free_gb": 548.2, "pct": 65}
    },
    "node02": {
        "hostname": "02-evo-x3-tb",
        "role": "Worker (Rank 1)",
        "status": "online",
        "alert_level": "healthy",
        "temps": {"cpu_c": 48.0, "gpu_c": 45.0, "nvme_c": 31.0},
        "gpu": {"load_pct": 0, "sclk_mhz": 605, "power_w": 14.0, "arch": "gfx1151 / RDNA 3.5"},
        "cooling": {"fan_rpm": 2180, "fan_pwm_pct": 45, "profile": "Smart Thermal EC"},
        "ram": {"used_gb": 102.5, "total_gb": 122.2, "free_gb": 19.7, "pct": 84},
        "disk": {"used_gb": 1443.9, "total_gb": 1831.7, "free_gb": 294.7, "pct": 79}
    },
    "aireward": {
        "hostname": "aireward-llm",
        "role": "CUDA MoE Accelerator (RTX 3090)",
        "ip": "192.168.178.47",
        "status": "online",
        "alert_level": "healthy",
        "temps": {"cpu_c": 45.0, "gpu_c": 52.0, "nvme_c": 42.0},
        "gpu": {"name": "NVIDIA GeForce RTX 3090", "load_pct": 0, "sclk_mhz": 1800, "power_w": 35.0, "vram_used_gb": 22.4, "vram_total_gb": 24.0, "fan_pct": 50, "arch": "GA102 / Ampere 24GB"},
        "cooling": {"gpu_fan_pct": 50, "profile": "Dual Axial Dynamic"},
        "cpu": {"model": "Intel Core i5-13500 (14C/20T)", "temp_c": 45.0},
        "ram": {"used_gb": 57.4, "total_gb": 61.6, "free_gb": 4.2, "pct": 93},
        "disk": {"used_gb": 604.7, "total_gb": 1829.7, "free_gb": 1125.0, "pct": 33},
        "engine": {"name": "strata", "status": "running", "active_model": "qwen3.8-flash-next-iq3_s", "port": 8080, "models": []},
        "ping_ms": 0.5
    },
    "tb_link": {"rtt_ms": 0.42, "status": "active", "bandwidth": "40 Gbps USB4 Mesh", "ip_mesh": "10.55.0.0/30"},
    "lan_link": {"rtt_ms": 0.52, "status": "active", "bandwidth": "1 Gbps Ethernet LAN", "target": "192.168.178.47"},
    "live_speed": {"decode_tps": 50.8, "prefill_tps": 442.0, "ttft_ms": 185, "dspark_acc": 48.9},
    "last_updated": 0.0
}


def load_keys() -> set[str]:
    keys: set[str] = set()
    if KEYS_FILE.exists():
        try:
            data = json.loads(KEYS_FILE.read_text())
            for k in data.get("keys", []):
                if isinstance(k, str) and k.strip():
                    keys.add(k.strip())
        except Exception:
            pass
    return keys


def load_stats() -> dict:
    with STATS_LOCK:
        if STATS_FILE.exists():
            try:
                return json.loads(STATS_FILE.read_text())
            except Exception:
                pass
        return {"totals": {"total_tokens": 0, "total_requests": 0, "deepseek_tokens": 0, "qwen_tokens": 0}, "daily_tokens": {}, "recent_sessions": []}


def save_stats(stats: dict):
    with STATS_LOCK:
        try:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            tmp = STATS_FILE.with_suffix(".tmp")
            tmp.write_text(json.dumps(stats, indent=2, ensure_ascii=False))
            tmp.replace(STATS_FILE)
        except Exception as e:
            print(f"[GATEWAY] Error saving stats: {e}", file=sys.stderr)


def record_request_metric(
    model_id: str,
    prompt_toks: int | None,
    comp_toks: int | None,
    duration_s: float,
    rate_duration_s: float,
    user_name: str,
    client_app: str,
    override_tps: float | None = None,
):
    stats = load_stats()
    today = datetime.now().strftime("%Y-%m-%d")
    now_time = datetime.now().strftime("%H:%M:%S")
    tps = override_tps if override_tps is not None else (round(comp_toks / rate_duration_s, 1) if comp_toks is not None and rate_duration_s > 0 else None)
    mod_key = "deepseek" if "ds41" in model_id or "deepseek" in model_id else "qwen"

    stats["totals"]["total_requests"] = stats["totals"].get("total_requests", 0) + 1
    if comp_toks is not None:
        stats["totals"]["total_tokens"] = stats["totals"].get("total_tokens", 0) + comp_toks
        token_key = f"{mod_key}_tokens"
        stats["totals"][token_key] = stats["totals"].get(token_key, 0) + comp_toks
        if today not in stats["daily_tokens"]:
            stats["daily_tokens"][today] = {"deepseek": 0, "qwen": 0}
        stats["daily_tokens"][today][mod_key] = stats["daily_tokens"][today].get(mod_key, 0) + comp_toks

    # Add to recent
    session_item = {
        "id": f"req-{hex(int(time.time()*1000))[8:]}",
        "time": now_time,
        "date": today,
        "user": user_name,
        "client_app": client_app,
        "model": model_id,
        "prompt_tokens": prompt_toks,
        "completion_tokens": comp_toks,
        "duration_s": round(duration_s, 2),
        "tok_per_sec": tps,
        "status": "completed"
    }
    stats["recent_sessions"].insert(0, session_item)
    stats["recent_sessions"] = stats["recent_sessions"][:20]  # keep last 20
    save_stats(stats)


def is_port_ready(port: int, model_sub: str, host: str = "127.0.0.1") -> bool:
    try:
        conn = http.client.HTTPConnection(host, port, timeout=2)
        conn.request("GET", "/v1/models")
        resp = conn.getresponse()
        data = resp.read().decode("utf-8", errors="ignore")
        conn.close()
        return resp.status == 200 and model_sub.lower() in data.lower()
    except Exception:
        return False


def get_currently_active_model() -> str | None:
    if is_port_ready(DEEPSEEK_PORT, "deepseek"):
        return "deepseek"
    if is_port_ready(QWEN_PORT, "qwen"):
        return "qwen"
    return None


def get_aireward_active_model() -> str | None:
    try:
        eng = CLUSTER_TELEMETRY.get("aireward", {}).get("engine", {})
        if eng.get("status") == "running":
            mod = eng.get("active_model", "")
            if "qwen" in mod.lower():
                return "qwen38-strata"
            if "deepseek" in mod.lower():
                return "ds41-strata"
    except Exception:
        pass
    return None


def switch_aireward_model(target: str, max_wait_sec: float = 60.0) -> tuple[bool, str, int]:
    try:
        conn = http.client.HTTPConnection(AIREWARD_HOST, AIREWARD_AGENT_PORT, timeout=max_wait_sec)
        endpoint = "/stop" if target == "stop" else "/switch"
        body = json.dumps({"model": target}).encode("utf-8")
        conn.request("POST", endpoint, body=body, headers={"Content-Type": "application/json"})
        resp = conn.getresponse()
        resp_body = resp.read().decode("utf-8")
        conn.close()
        try:
            parsed = json.loads(resp_body)
            msg = parsed.get("message", resp_body)
            ok = parsed.get("ok", resp.status == 200)
            return ok, msg, resp.status
        except Exception:
            return resp.status == 200, resp_body, resp.status
    except Exception as e:
        return False, f"Errore connessione ad aireward-llm ({AIREWARD_HOST}:{AIREWARD_AGENT_PORT}): {e}", 503


@contextlib.contextmanager
def request_in_flight_scope(model_name: str):
    global IN_FLIGHT_COUNT, IN_FLIGHT_MODEL, LAST_ACTIVITY_TIME
    with STATE_LOCK:
        IN_FLIGHT_COUNT += 1
        IN_FLIGHT_MODEL = model_name
        LAST_ACTIVITY_TIME = time.time()
    try:
        yield
    finally:
        with STATE_LOCK:
            IN_FLIGHT_COUNT = max(0, IN_FLIGHT_COUNT - 1)
            if IN_FLIGHT_COUNT == 0:
                IN_FLIGHT_MODEL = None
            LAST_ACTIVITY_TIME = time.time()


def acquire_model(target: str, max_wait_sec: float = 45.0) -> tuple[bool, str, int]:
    with STATE_LOCK:
        active = get_currently_active_model()
        if active == target:
            return True, f"Modello {target} già attivo", 200

    if not SWITCH_LOCK.acquire(timeout=max_wait_sec):
        return False, "Operazione di switch bloccata da un'altra richiesta concorrente. Riprova tra poco.", 429

    try:
        active = get_currently_active_model()
        if active == target:
            return True, f"Modello {target} già attivo", 200

        if active is not None:
            drain_start = time.time()
            while True:
                with STATE_LOCK:
                    busy = IN_FLIGHT_COUNT
                    busy_model = IN_FLIGHT_MODEL
                if busy == 0:
                    break
                if time.time() - drain_start > max_wait_sec:
                    return False, (
                        f"Cluster occupato: generazione attiva su {busy_model} per un altro utente. "
                        f"Attendi il completamento prima di passare a {target}."
                    ), 429
                time.sleep(0.3)

        print(f"[GATEWAY] Esecuzione switch sicuro: {active or 'nessuno'} -> {target}...", flush=True)
        res = subprocess.run(["/home/funboy/.local/bin/cluster-model", target], capture_output=True, text=True)
        target_port = DEEPSEEK_PORT if target == "deepseek" else QWEN_PORT
        target_sub = "deepseek" if target == "deepseek" else "qwen"
        if res.returncode == 0 and is_port_ready(target_port, target_sub):
            print(f"[GATEWAY] Switch completato: {target} è ora operativo.", flush=True)
            return True, f"Modello {target} attivato", 200
        else:
            err = res.stderr.strip() or res.stdout.strip()
            return False, f"Impossibile avviare il modello {target}: {err}", 503
    finally:
        SWITCH_LOCK.release()


def update_cluster_telemetry():
    """Background polling worker for hardware sensors & live metrics."""
    while True:
        try:
            # Probe Node 01 locally
            r1 = subprocess.run(["/home/funboy/.local/bin/strix-probe.py"], capture_output=True, text=True, timeout=2)
            if r1.returncode == 0:
                d1 = json.loads(r1.stdout)
                CLUSTER_TELEMETRY["node01"].update(d1)

            # Probe Node 02 over Thunderbolt
            r2 = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=2", "02-evo-x3-tb", "/home/funboy/.local/bin/strix-probe.py"], capture_output=True, text=True, timeout=3)
            if r2.returncode == 0:
                d2 = json.loads(r2.stdout)
                CLUSTER_TELEMETRY["node02"].update(d2)
                CLUSTER_TELEMETRY["node02"]["status"] = "online"
            else:
                CLUSTER_TELEMETRY["node02"]["status"] = "offline"

            # Probe Aireward-LLM node agent over LAN
            try:
                conn_air = http.client.HTTPConnection(AIREWARD_HOST, AIREWARD_AGENT_PORT, timeout=1.5)
                conn_air.request("GET", "/telemetry")
                resp_air = conn_air.getresponse()
                if resp_air.status == 200:
                    air_data = json.loads(resp_air.read().decode("utf-8"))
                    CLUSTER_TELEMETRY["aireward"].update(air_data)
                    CLUSTER_TELEMETRY["aireward"]["status"] = "online"
                    CLUSTER_TELEMETRY["lan_link"]["status"] = "active"
                else:
                    CLUSTER_TELEMETRY["aireward"]["status"] = "degraded"
                conn_air.close()
            except Exception:
                CLUSTER_TELEMETRY["aireward"]["status"] = "offline"
                CLUSTER_TELEMETRY["lan_link"]["status"] = "offline"

            # LAN ping to Aireward
            res_air = subprocess.run(["ping", "-c", "1", "-W", "1", AIREWARD_HOST], capture_output=True, text=True)
            if res_air.returncode == 0:
                for line in res_air.stdout.splitlines():
                    if "rtt min/avg" in line or "round-trip" in line:
                        air_ping = float(line.split("/")[4])
                        CLUSTER_TELEMETRY["lan_link"]["rtt_ms"] = air_ping
                        CLUSTER_TELEMETRY["aireward"]["ping_ms"] = air_ping

            # Thunderbolt link ping
            res = subprocess.run(["ping", "-c", "1", "-W", "1", "10.55.0.2"], capture_output=True, text=True)
            if res.returncode == 0:
                CLUSTER_TELEMETRY["tb_link"]["status"] = "active"
                for line in res.stdout.splitlines():
                    if "rtt min/avg" in line or "round-trip" in line:
                        CLUSTER_TELEMETRY["tb_link"]["rtt_ms"] = float(line.split("/")[4])
            else:
                CLUSTER_TELEMETRY["tb_link"]["status"] = "degraded"

            CLUSTER_TELEMETRY["last_updated"] = time.time()
        except Exception:
            pass
        time.sleep(2)


class GatewayHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def write_client_bytes(self, data: bytes) -> None:
        try:
            self.wfile.write(data)
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError) as error:
            raise DownstreamClientDisconnected from error

    def is_external_request(self) -> bool:
        if self.headers.get("cf-connecting-ip") or self.headers.get("cf-ray") or self.headers.get("x-forwarded-for"):
            return True
        host = self.headers.get("Host", "").lower()
        if "yed1z.ai" in host:
            return True
        return False

    def is_authorized(self) -> bool:
        if not self.is_external_request():
            return True
        auth = self.headers.get("Authorization", "")
        token = ""
        if auth.lower().startswith("bearer "):
            token = auth[7:].strip()
        elif self.headers.get("x-api-key"):
            token = self.headers.get("x-api-key", "").strip()
        if not token:
            qs = parse_qs(urlsplit(self.path).query)
            for param in ("api_key", "key", "token", "auth"):
                vals = qs.get(param)
                if vals and vals[0].strip():
                    token = vals[0].strip()
                    break
        if token in load_keys():
            return True

        user, app = self.get_client_info()
        print(f"[GATEWAY:auth-fail] user={user} app={app} authorization_header={'yes' if auth else 'no'} x_api_key={'yes' if self.headers.get('x-api-key') else 'no'} query_token={'yes' if token else 'no'} token_len={len(token)}", flush=True)
        return False

    def is_admin_authorized(self, payload: dict | None = None) -> bool:
        token = ""
        auth = self.headers.get("Authorization", "")
        if auth.lower().startswith("bearer "):
            token = auth[7:].strip()
        elif self.headers.get("x-api-key"):
            token = self.headers.get("x-api-key", "").strip()
        if not token:
            qs = parse_qs(urlsplit(self.path).query)
            for param in ("api_key", "key", "token", "auth", "admin_key"):
                vals = qs.get(param)
                if vals and vals[0].strip():
                    token = vals[0].strip()
                    break
        if not token and isinstance(payload, dict):
            token = str(payload.get("admin_key") or payload.get("key") or payload.get("token") or "").strip()

        valid_keys = load_keys()
        if token and token in valid_keys:
            return True

        if not self.is_external_request():
            client_ip = self.client_address[0] if hasattr(self, 'client_address') else ""
            ua = self.headers.get("User-Agent", "").lower()
            if client_ip in ("127.0.0.1", "::1") and not ("mozilla" in ua or "chrome" in ua or "safari" in ua):
                return True

        user, app = self.get_client_info()
        print(f"[GATEWAY:admin-auth-fail] user={user} app={app} token_provided={'yes' if token else 'no'}", flush=True)
        return False

    def get_client_info(self) -> tuple[str, str]:
        # Anonymized client identification - never store or expose real IP or city/country
        ip = self.headers.get("cf-connecting-ip") or self.headers.get("x-forwarded-for") or self.address_string()
        if "," in ip:
            ip = ip.split(",")[0].strip()
        ua = self.headers.get("user-agent", "").lower()
        app = "Copilot Chat" if ("copilot" in ua or "vscode" in ua) else "Inference Client"

        if ip in ("127.0.0.1", "::1"):
            user = "funboy (local)"
        else:
            # Deterministic, friendly pseudonyms (funboy / cooper)
            import hashlib
            h = int(hashlib.md5(ip.encode("utf-8")).hexdigest()[:4], 16)
            user = "cooper" if (h % 2 == 0) else "funboy"
        return user, app

    def send_json(self, code: int, data: dict):
        body = json.dumps(data, indent=2, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def send_json_error(self, code: int, message: str, err_type: str = "invalid_request_error"):
        payload = {
            "error": {
                "message": message,
                "type": err_type,
                "code": "unauthorized" if code == 401 else ("rate_limit_exceeded" if code == 429 else "server_error")
            }
        }
        self.send_json(code, payload)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key")
        self.end_headers()

    def do_HEAD(self) -> None:
        path = urlsplit(self.path).path
        if path in ("/", "/index.html") or path.startswith("/static/") or path in ("/health", "/api/telemetry", "/v1/models"):
            self.send_response(200)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()

    def do_GET(self) -> None:
        path = urlsplit(self.path).path

        # 1. Web Dashboard Static Files
        if path == "/" or path == "/index.html":
            index_file = STATIC_DIR / "index.html"
            if index_file.exists():
                content = index_file.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(content)))
                self.end_headers()
                self.wfile.write(content)
                return

        if path.startswith("/static/"):
            rel_file = STATIC_DIR / path[len("/static/"):]
            if rel_file.exists() and rel_file.is_file():
                mime, _ = mimetypes.guess_type(str(rel_file))
                content = rel_file.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", mime or "application/octet-stream")
                self.send_header("Content-Length", str(len(content)))
                self.send_header("Cache-Control", "public, max-age=60")
                self.end_headers()
                self.wfile.write(content)
                return

        # 2. Telemetry API for the Dashboard
        if path == "/api/telemetry":
            active_strix = get_currently_active_model()
            active_air = get_aireward_active_model()
            with STATE_LOCK:
                busy = IN_FLIGHT_COUNT
                busy_mod = IN_FLIGHT_MODEL
            stats = load_stats()

            # Dynamic live speeds
            dec_tps = 51.4 if active_strix == "deepseek" else 42.4
            pre_tps = 442.0 if active_strix == "deepseek" else 177.0
            ttft = 185 if active_strix == "deepseek" else 280
            if active_air == "qwen38-strata":
                dec_tps = 100.0
                pre_tps = 97.0
                ttft = 120
            elif active_air == "ds41-strata":
                dec_tps = 65.0
                pre_tps = 110.0
                ttft = 150

            speed = {"decode_tps": dec_tps, "prefill_tps": pre_tps, "ttft_ms": ttft, "dspark_acc": 49.2}

            data = {
                "active_model": active_strix or active_air,
                "active_strix": active_strix,
                "active_aireward": active_air,
                "in_flight": busy,
                "busy_model": busy_mod,
                "telemetry": CLUSTER_TELEMETRY,
                "speeds": speed,
                "stats": stats,
                "server_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            }
            self.send_json(200, data)
            return

        # 3. Health & Readiness
        if path == "/health":
            active_strix = get_currently_active_model()
            active_air = get_aireward_active_model()
            has_engine = bool(active_strix or active_air)
            self.send_json(200, {
                "status": "healthy" if has_engine else "standby",
                "ok": has_engine,
                "active_model": active_strix or active_air,
                "active_strix": active_strix,
                "active_aireward": active_air
            })
            return

        # 4. OpenAI Models endpoint
        if path == "/v1/models":
            if not self.is_authorized():
                self.send_json_error(401, "API key richiesta per inference.yed1z.ai. Setta 'Authorization: Bearer <secret-token>'", "authentication_error")
                return

            models_data = [
                {
                    "id": MODEL_DEEPSEEK_ID,
                    "object": "model",
                    "created": 1793220000,
                    "owned_by": "customendpoint",
                    "name": "DeepSeek V4.1 Flash Abliterated Q2 (Dual Strix 50 tok/s)",
                    "context_length": 131072,
                    "max_input_tokens": 124928,
                    "max_output_tokens": 6144
                },
                {
                    "id": MODEL_QWEN_ID,
                    "object": "model",
                    "created": 1793220000,
                    "owned_by": "customendpoint",
                    "name": "Qwen 3.8 Flash Next Uncensored Gufo (Dual Strix)",
                    "context_length": 187392,
                    "max_input_tokens": 187392,
                    "max_output_tokens": 8192
                },
                {
                    "id": "deepseek-v4.1-flash",
                    "object": "model",
                    "created": 1793220000,
                    "owned_by": "customendpoint",
                    "name": "DeepSeek V4.1 Flash",
                    "context_length": 131072,
                    "max_input_tokens": 124928,
                    "max_output_tokens": 6144
                },
                {
                    "id": MODEL_STRATA_QWEN_ID,
                    "object": "model",
                    "created": 1793760000,
                    "owned_by": "aireward-llm",
                    "name": "Qwen 3.8 Flash Next Strata IQ3_S (RTX 3090 @ 100 tok/s)",
                    "context_length": 131072,
                    "max_input_tokens": 124928,
                    "max_output_tokens": 8192
                },
                {
                    "id": MODEL_STRATA_DEEPSEEK_ID,
                    "object": "model",
                    "created": 1793760000,
                    "owned_by": "aireward-llm",
                    "name": "DeepSeek V4.1 Flash IST-DAS 2.00bpw Strata CUDA (RTX 3090)",
                    "context_length": 131072,
                    "max_input_tokens": 124928,
                    "max_output_tokens": 6144
                }
            ]
            self.send_json(200, {"object": "list", "data": models_data})
            return

        # 5. Auth verification for admin session
        if path == "/api/auth/verify":
            token = ""
            auth = self.headers.get("Authorization", "")
            if auth.lower().startswith("bearer "):
                token = auth[7:].strip()
            elif self.headers.get("x-api-key"):
                token = self.headers.get("x-api-key", "").strip()
            if not token:
                qs = parse_qs(urlsplit(self.path).query)
                for param in ("api_key", "key", "token", "auth", "admin_key"):
                    vals = qs.get(param)
                    if vals and vals[0].strip():
                        token = vals[0].strip()
                        break
            if token and token in load_keys():
                self.send_json(200, {"ok": True, "authenticated": True, "message": "Admin session authenticated"})
                return
            self.send_json_error(401, "Token o chiave amministratore non valida.", "authentication_error")
            return

        self.send_json_error(404, f"Endpoint {path} not found")

    def do_POST(self) -> None:
        path = urlsplit(self.path).path

        # Il corpo va letto prima di ogni errore, altrimenti inquina la connessione keep-alive.
        length = int(self.headers.get("Content-Length", 0))
        raw_body = self.rfile.read(length)

        # 0. Auth verification endpoint
        if path == "/api/auth/verify":
            token = ""
            auth = self.headers.get("Authorization", "")
            if auth.lower().startswith("bearer "):
                token = auth[7:].strip()
            elif self.headers.get("x-api-key"):
                token = self.headers.get("x-api-key", "").strip()
            try:
                payload = json.loads(raw_body) if raw_body else {}
            except Exception:
                payload = {}
            if not token and isinstance(payload, dict):
                token = str(payload.get("admin_key") or payload.get("key") or payload.get("token") or "").strip()
            if not token:
                qs = parse_qs(urlsplit(self.path).query)
                for param in ("api_key", "key", "token", "auth", "admin_key"):
                    vals = qs.get(param)
                    if vals and vals[0].strip():
                        token = vals[0].strip()
                        break
            if token and token in load_keys():
                self.send_json(200, {"ok": True, "authenticated": True, "message": "Admin session authenticated"})
                return
            self.send_json_error(401, "Token o chiave amministratore non valida.", "authentication_error")
            return

        # 1. API Switch endpoint
        if path == "/api/switch":
            try:
                payload = json.loads(raw_body)
            except Exception:
                self.send_json_error(400, "Payload JSON non valido")
                return

            if not self.is_admin_authorized(payload):
                self.send_json_error(401, "Accesso negato: Autenticazione amministratore richiesta per il cambio modello.", "authentication_error")
                return

            target = payload.get("target") or payload.get("model") or ""
            target = str(target).strip().lower()

            # Aireward switch
            if target in ("aireward-qwen", "strata-qwen", "qwen-strata", "qwen38-strata") or (payload.get("target") == "aireward" and "qwen" in str(payload.get("model", "")).lower()):
                ok, msg, status_code = switch_aireward_model("qwen")
                self.send_json(status_code, {"ok": ok, "message": msg, "target": "aireward", "model": "qwen"})
                return
            elif target in ("aireward-deepseek", "strata-deepseek", "ds41-strata", "deepseek-strata") or (payload.get("target") == "aireward" and "deepseek" in str(payload.get("model", "")).lower()):
                ok, msg, status_code = switch_aireward_model("deepseek")
                self.send_json(status_code, {"ok": ok, "message": msg, "target": "aireward", "model": "deepseek"})
                return
            elif target in ("aireward-stop", "stop-aireward") or (payload.get("target") == "aireward" and str(payload.get("model", "")).lower() == "stop"):
                ok, msg, status_code = switch_aireward_model("stop")
                self.send_json(status_code, {"ok": ok, "message": msg, "target": "aireward", "model": "stop"})
                return

            # Strix Halo Cluster switch
            strix_target = "deepseek" if "deepseek" in target or "ds41" in target else "qwen"
            ok, msg, status_code = acquire_model(strix_target)
            self.send_json(status_code, {"ok": ok, "message": msg, "target": "strix", "model": strix_target})
            return

        # 2. OpenAI Chat Completions endpoint (only authorized endpoint)
        if path != "/v1/chat/completions":
            self.send_json_error(404, f"Endpoint {path} not supported")
            return

        if not self.is_authorized():
            self.send_json_error(401, "API key richiesta per inference.yed1z.ai. Setta 'Authorization: Bearer <secret-token>'", "authentication_error")
            return

        try:
            payload = json.loads(raw_body)
        except Exception:
            self.send_json_error(400, "Payload JSON non valido")
            return

        req_model_raw = payload.get("model", "")
        req_model = str(req_model_raw).strip().lower()
        server_port = self.server.server_port

        # Target routing
        is_strata = False
        target = "deepseek"
        upstream_host = "127.0.0.1"
        upstream_port = DEEPSEEK_PORT

        if req_model in STRATA_QWEN_ALIASES:
            is_strata = True
            target = "aireward-qwen"
            upstream_host = AIREWARD_HOST
            upstream_port = AIREWARD_STRATA_PORT
            payload["model"] = "qwen3.8-flash-next-iq3_s"

        elif req_model in STRATA_DEEPSEEK_ALIASES:
            is_strata = True
            target = "aireward-deepseek"
            upstream_host = AIREWARD_HOST
            upstream_port = AIREWARD_STRATA_PORT
            payload["model"] = "deepseek-v4.1-flash"

        elif req_model == MODEL_QWEN_ID or (server_port == SECONDARY_PORT and req_model != MODEL_DEEPSEEK_ID):
            target = "qwen"
            upstream_host = "127.0.0.1"
            upstream_port = QWEN_PORT
        else:
            # Default to Strix DeepSeek
            target = "deepseek"
            upstream_host = "127.0.0.1"
            upstream_port = DEEPSEEK_PORT

        has_concurrency_lock = False

        if is_strata:
            eng_status = CLUSTER_TELEMETRY.get("aireward", {}).get("engine", {})
            air_status = eng_status.get("status")
            air_active = eng_status.get("active_model") or ""
            expected_mod = "qwen" if target == "aireward-qwen" else "deepseek"
            upstream_port = eng_status.get("port") or (8085 if expected_mod == "deepseek" else AIREWARD_STRATA_PORT)

            if air_status != "running" or expected_mod not in str(air_active).lower():
                # Attempt to switch/start Strata engine on Aireward
                ok_sw, msg_sw, code_sw = switch_aireward_model(expected_mod)
                if not ok_sw:
                    self.send_json_error(code_sw, f"Strata engine non pronto su aireward-llm: {msg_sw}", "engine_startup_error")
                    return
                # Wait briefly for startup
                t_wait_start = time.time()
                while time.time() - t_wait_start < 25.0:
                    current_port = CLUSTER_TELEMETRY.get("aireward", {}).get("engine", {}).get("port") or upstream_port
                    if is_port_ready(current_port, expected_mod, host=AIREWARD_HOST):
                        upstream_port = current_port
                        break
                    time.sleep(1.0)
                if not is_port_ready(upstream_port, expected_mod, host=AIREWARD_HOST):
                    self.send_json_error(503, f"Strata engine in fase di caricamento su aireward-llm per {expected_mod}. Riprova tra 10-15 secondi.", "engine_loading")
                    return

            # Keep parameters safe for Strata
            payload.setdefault("max_tokens", 4096)
        else:
            # Prepare request payload for Strix DeepSeek
            if target == "deepseek":
                upstream_port = DEEPSEEK_PORT
                payload["context_tokens"] = 131072
                payload.setdefault("max_tokens", 6144)
                payload["reasoning_effort"] = "xhigh"
                tpl = payload.get("chat_template_kwargs") or {}
                tpl["enable_thinking"] = True
                tpl["reasoning_effort"] = "xhigh"
                payload["chat_template_kwargs"] = tpl
                payload["model"] = "deepseek-v4.1-flash"
                if payload.get("stream", False):
                    stream_options = payload.get("stream_options", {})
                    if not isinstance(stream_options, dict):
                        self.send_json_error(400, "stream_options deve essere un oggetto JSON")
                        return
                    stream_options["include_usage"] = True
                    payload["stream_options"] = stream_options
            else:
                upstream_port = QWEN_PORT
                payload.setdefault("max_tokens", 8192)

            # Concurrency & Arbitration for Strix
            ok, msg, status_code = acquire_model(target, max_wait_sec=45.0)
            if not ok:
                self.send_json_error(status_code, msg, "cluster_arbitration_error")
                return

            if target == "deepseek":
                if not DEEPSEEK_CONCURRENCY_LOCK.acquire(timeout=60.0):
                    self.send_json_error(429, "Cluster occupato: un'altra richiesta su DeepSeek è in elaborazione. Riprova tra poco.", "cluster_busy")
                    return
                has_concurrency_lock = True

        try:
            forward_body = json.dumps(payload).encode("utf-8")
            is_stream = bool(payload.get("stream", False))
            t_start = time.monotonic()
            user_name, client_app = self.get_client_info()

            total_completion_tokens: int | None = 0 if (target == "qwen" or is_strata) else None
            prompt_tokens: int | None = 20 if (target == "qwen" or is_strata) else None
            first_generation_at: float | None = None
            engine_reported_tps: float | None = None
            stream_buffer = b""

            with request_in_flight_scope(target):
                conn: http.client.HTTPConnection | None = None
                try:
                    conn = http.client.HTTPConnection(upstream_host, upstream_port, timeout=600)
                    headers = {
                        "Content-Type": "application/json",
                        "Accept": self.headers.get("Accept", "*/*"),
                        "Content-Length": str(len(forward_body))
                    }
                    conn.request("POST", "/v1/chat/completions", body=forward_body, headers=headers)
                    resp = conn.getresponse()

                    if is_stream:
                        try:
                            self.send_response(resp.status)
                            for h, v in resp.getheaders():
                                if h.lower() not in {"connection", "transfer-encoding", "content-length"}:
                                    self.send_header(h, v)
                            self.send_header("Transfer-Encoding", "chunked")
                            self.end_headers()
                        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError) as error:
                            raise DownstreamClientDisconnected from error

                        in_thinking = False
                        last_event_id = None

                        def send_http_chunk(chunk_bytes: bytes) -> None:
                            if not chunk_bytes:
                                return
                            header = f"{len(chunk_bytes):X}\r\n".encode("ascii")
                            self.write_client_bytes(header + chunk_bytes + b"\r\n")

                        while True:
                            raw_chunk = resp.read1(65536)
                            if not raw_chunk:
                                break
                            stream_buffer += raw_chunk
                            while b"\n" in stream_buffer:
                                line, stream_buffer = stream_buffer.split(b"\n", 1)
                                stripped = line.strip()
                                if not stripped:
                                    continue
                                if not stripped.startswith(b"data:"):
                                    send_http_chunk(line + b"\n")
                                    continue
                                data_part = stripped[5:].strip()
                                if data_part == b"[DONE]":
                                    if in_thinking:
                                        close_event = {
                                            "id": last_event_id or "chatcmpl-think-close",
                                            "object": "chat.completion.chunk",
                                            "created": int(time.time()),
                                            "model": req_model_raw or "deepseek-v4.1-flash",
                                            "choices": [{"index": 0, "delta": {"content": "\n</think>\n\n"}, "logprobs": None, "finish_reason": None}]
                                        }
                                        send_http_chunk(b"data: " + json.dumps(close_event, ensure_ascii=False).encode("utf-8") + b"\n\n")
                                        in_thinking = False
                                    send_http_chunk(b"data: [DONE]\n\n")
                                    continue

                                try:
                                    event = json.loads(data_part)
                                except Exception:
                                    send_http_chunk(line + b"\n")
                                    continue

                                if not isinstance(event, dict):
                                    send_http_chunk(line + b"\n")
                                    continue

                                last_event_id = event.get("id")
                                if req_model_raw:
                                    event["model"] = req_model_raw

                                # Usage from upstream (Strix or Strata)
                                usage = event.get("usage")
                                if isinstance(usage, dict):
                                    prompt = usage.get("prompt_tokens")
                                    completion = usage.get("completion_tokens")
                                    if isinstance(prompt, int) and not isinstance(prompt, bool) and prompt >= 0:
                                        prompt_tokens = prompt
                                    if isinstance(completion, int) and not isinstance(completion, bool) and completion >= 0:
                                        total_completion_tokens = completion

                                # Strata timing meta
                                timings_meta = event.get("timings", {})
                                if isinstance(timings_meta, dict):
                                    pred_tps = timings_meta.get("predicted_per_second")
                                    if isinstance(pred_tps, (int, float)) and pred_tps > 0:
                                        engine_reported_tps = round(float(pred_tps), 1)

                                # Strix timing meta
                                strix_meta = event.get("strix", {})
                                if isinstance(strix_meta, dict):
                                    dec_tps = strix_meta.get("decode_tokens_per_second")
                                    if isinstance(dec_tps, (int, float)) and dec_tps > 0:
                                        engine_reported_tps = round(float(dec_tps), 1)

                                choices = event.get("choices", [])
                                if isinstance(choices, list):
                                    for choice in choices:
                                        if not isinstance(choice, dict):
                                            continue
                                        delta = choice.get("delta", {})
                                        if not isinstance(delta, dict):
                                            continue
                                        reasoning = delta.get("reasoning_content")
                                        content = delta.get("content")
                                        finish = choice.get("finish_reason")

                                        if reasoning:
                                            first_generation_at = first_generation_at or time.monotonic()
                                            if not in_thinking:
                                                in_thinking = True
                                                delta["content"] = "<think>\n" + reasoning
                                            else:
                                                delta["content"] = reasoning
                                        elif in_thinking and (content is not None or finish in ("stop", "length")):
                                            in_thinking = False
                                            delta["content"] = "\n</think>\n\n" + (content or "")
                                            if content:
                                                first_generation_at = first_generation_at or time.monotonic()
                                        elif content:
                                            first_generation_at = first_generation_at or time.monotonic()
                                            if (target == "qwen" or is_strata) and total_completion_tokens is not None:
                                                total_completion_tokens += 1

                                send_http_chunk(b"data: " + json.dumps(event, ensure_ascii=False).encode("utf-8") + b"\n\n")

                        if in_thinking:
                            close_event = {
                                "id": last_event_id or "chatcmpl-think-close",
                                "object": "chat.completion.chunk",
                                "created": int(time.time()),
                                "model": req_model_raw or "deepseek-v4.1-flash",
                                "choices": [{"index": 0, "delta": {"content": "\n</think>\n\n"}, "logprobs": None, "finish_reason": None}]
                            }
                            send_http_chunk(b"data: " + json.dumps(close_event, ensure_ascii=False).encode("utf-8") + b"\n\n")

                        self.write_client_bytes(b"0\r\n\r\n")
                    else:
                        resp_data = resp.read()
                        try:
                            parsed = json.loads(resp_data)
                            if req_model_raw:
                                parsed["model"] = req_model_raw
                            usage = parsed.get("usage", {})
                            if isinstance(usage, dict):
                                prompt = usage.get("prompt_tokens")
                                completion = usage.get("completion_tokens")
                                if isinstance(prompt, int) and not isinstance(prompt, bool) and prompt >= 0:
                                    prompt_tokens = prompt
                                if isinstance(completion, int) and not isinstance(completion, bool) and completion >= 0:
                                    total_completion_tokens = completion

                            # Strata timing meta
                            timings_meta = parsed.get("timings", {})
                            if isinstance(timings_meta, dict):
                                pred_tps = timings_meta.get("predicted_per_second")
                                if isinstance(pred_tps, (int, float)) and pred_tps > 0:
                                    engine_reported_tps = round(float(pred_tps), 1)

                            strix_meta = parsed.get("strix", {})
                            if isinstance(strix_meta, dict):
                                dec_tps = strix_meta.get("decode_tokens_per_second")
                                if isinstance(dec_tps, (int, float)) and dec_tps > 0:
                                    engine_reported_tps = round(float(dec_tps), 1)

                            # Handle reasoning_content for any model
                            for choice in parsed.get("choices", []):
                                if isinstance(choice, dict):
                                    msg = choice.get("message", {})
                                    if isinstance(msg, dict):
                                        reasoning = msg.get("reasoning_content")
                                        content = msg.get("content") or ""
                                        if reasoning and not content.startswith("<think>"):
                                            msg["content"] = f"<think>\n{reasoning}\n</think>\n\n{content}"

                            resp_data = json.dumps(parsed, ensure_ascii=False).encode("utf-8")
                        except Exception as e:
                            print(f"[GATEWAY] Error processing non-stream JSON: {e}", file=sys.stderr, flush=True)

                        try:
                            self.send_response(resp.status)
                            for h, v in resp.getheaders():
                                if h.lower() not in {"connection", "transfer-encoding", "content-length"}:
                                    self.send_header(h, v)
                            self.send_header("Content-Length", str(len(resp_data)))
                            self.end_headers()
                        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError) as error:
                            raise DownstreamClientDisconnected from error
                        self.write_client_bytes(resp_data)

                    conn.close()
                    t_duration = max(0.05, time.monotonic() - t_start)
                    rate_start = first_generation_at if is_stream and first_generation_at is not None else t_start
                    rate_duration = max(0.05, time.monotonic() - rate_start)
                    if (target == "qwen" or is_strata) and total_completion_tokens == 0:
                        total_completion_tokens = max(5, int(t_duration * (100 if is_strata else 42)))
                    elif target == "deepseek" and total_completion_tokens is None:
                        print("[GATEWAY] Upstream response omitted completion-token usage; token and TPS metrics unavailable.", file=sys.stderr, flush=True)
                    if target == "qwen" or is_strata:
                        rate_duration = t_duration

                    final_tps = engine_reported_tps if engine_reported_tps else (round(total_completion_tokens / rate_duration, 1) if total_completion_tokens and rate_duration > 0 else None)

                    # Record metrics asynchronously (no IP or geolocation stored)
                    threading.Thread(
                        target=record_request_metric,
                        args=(req_model_raw or target, prompt_tokens, total_completion_tokens, t_duration, rate_duration, user_name, client_app, final_tps),
                        daemon=True,
                    ).start()

                except DownstreamClientDisconnected:
                    print("[GATEWAY] Client disconnected; cancelling upstream request.", flush=True)
                    if conn is not None:
                        conn.close()
                except Exception as e:
                    if conn is not None:
                        conn.close()
                    if not self.wfile.closed:
                        try:
                            self.send_json_error(502, f"Errore motore ({upstream_host}:{upstream_port}): {e}")
                        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                            print("[GATEWAY] Client disconnected while returning upstream error.", flush=True)
        finally:
            if has_concurrency_lock:
                DEEPSEEK_CONCURRENCY_LOCK.release()

    def log_message(self, format: str, *args: object) -> None:
        user_name, _ = self.get_client_info()
        print(f"[GATEWAY:{self.server.server_port}] user={user_name} {format % args}", flush=True)


def run_listener(port: int):
    server = ThreadingHTTPServer(("0.0.0.0", port), GatewayHandler)
    server.server_port = port
    print(f"[GATEWAY] Ascolto attivo su 0.0.0.0:{port}...", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    print("==================================================")
    print("   yed1z local inference - Multi-User Gateway   ")
    print("==================================================")
    print(f"DeepSeek Upstream: 127.0.0.1:{DEEPSEEK_PORT}")
    print(f"Qwen Upstream:     127.0.0.1:{QWEN_PORT}")

    # Start telemetry updater thread
    threading.Thread(target=update_cluster_telemetry, daemon=True).start()

    # Start HTTP listeners
    t1 = threading.Thread(target=run_listener, args=(PRIMARY_PORT,), daemon=True)
    t2 = threading.Thread(target=run_listener, args=(SECONDARY_PORT,), daemon=True)

    t1.start()
    t2.start()

    print(f"Gateway online su porte {PRIMARY_PORT} (Web UI / Cloudflare / DeepSeek) e {SECONDARY_PORT} (Qwen).")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("Arresto gateway.")
