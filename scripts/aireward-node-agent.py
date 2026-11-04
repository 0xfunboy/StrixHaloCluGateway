#!/usr/bin/env python3
"""
aireward-node-agent - Hardware Telemetry & Strata Engine Manager
Target: aireward-llm (i5-13500 / 64GB DDR5 / RTX 3090 24GB / 2TB Samsung NVMe)
Exposes HTTP API on 0.0.0.0:8090 for Strix Halo Cluster Gateway integration.
"""

import glob
import http.client
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlsplit

PORT = 8090
STRATA_PORT = 8080
STRATA_REPO = Path("/home/funboy/strata-repo")
STRATA_VENV = STRATA_REPO / ".venv" / "bin" / "python"
STRATA_SERVER = STRATA_REPO / "serve" / "server.py"
STRATA_ACTIVE_CONFIG = STRATA_REPO / "strata-active.json"

STATE_LOCK = threading.Lock()
ENGINE_PROCESS: subprocess.Popen | None = None
ACTIVE_MODEL_NAME = "none"

def get_hwmon(name: str) -> str | None:
    for h in glob.glob("/sys/class/hwmon/hwmon*"):
        try:
            with open(os.path.join(h, "name")) as f:
                if name in f.read():
                    return h
        except Exception:
            pass
    return None

def read_float(path: str, div: float = 1.0, default: float = 0.0) -> float:
    try:
        with open(path) as f:
            return round(float(f.read().strip()) / div, 1)
    except Exception:
        return default

def get_hardware_telemetry() -> dict:
    coretemp = get_hwmon("coretemp")
    nvme = get_hwmon("nvme")

    # CPU Temp
    cpu_c = 42.0
    if coretemp:
        inputs = glob.glob(f"{coretemp}/temp*_input")
        temps = [read_float(p, 1000.0) for p in inputs if read_float(p, 1000.0) > 0]
        if temps:
            cpu_c = round(max(temps), 1)

    # NVMe Temp
    nvme_c = read_float(f"{nvme}/temp1_input", 1000.0, 35.0) if nvme else 35.0

    # GPU Telemetry via nvidia-smi
    gpu = {
        "name": "NVIDIA GeForce RTX 3090",
        "temp_c": 45.0,
        "load_pct": 0,
        "mem_used_mib": 0,
        "mem_total_mib": 24576,
        "power_w": 15.0,
        "fan_pct": 40,
        "sclk_mhz": 210,
        "arch": "GA102 / Ampere 24GB"
    }
    try:
        cmd = [
            "nvidia-smi",
            "--query-gpu=temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw,fan.speed,clocks.current.sm,name",
            "--format=csv,noheader,nounits"
        ]
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=2)
        if res.returncode == 0:
            parts = [p.strip() for p in res.stdout.strip().split(",")]
            if len(parts) >= 8:
                gpu["temp_c"] = float(parts[0])
                gpu["load_pct"] = int(parts[1])
                gpu["mem_used_mib"] = int(parts[2])
                gpu["mem_total_mib"] = int(parts[3])
                gpu["power_w"] = float(parts[4])
                gpu["fan_pct"] = int(parts[5])
                gpu["sclk_mhz"] = int(parts[6])
                gpu["name"] = parts[7]
    except Exception:
        pass

    # RAM Telemetry
    mem_tot = 61.6
    mem_avail = 50.0
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    mem_tot = round(int(line.split()[1]) / (1024 * 1024), 1)
                elif line.startswith("MemAvailable:"):
                    mem_avail = round(int(line.split()[1]) / (1024 * 1024), 1)
    except Exception:
        pass
    ram_used = round(mem_tot - mem_avail, 1)
    ram_pct = int(round((ram_used / mem_tot) * 100))

    # Disk Telemetry
    du = shutil.disk_usage("/")
    disk_tot = round(du.total / (1024**3), 1)
    disk_used = round(du.used / (1024**3), 1)
    disk_free = round(du.free / (1024**3), 1)
    disk_pct = int(round((du.used / du.total) * 100))

    alert = "healthy"
    if cpu_c >= 95 or gpu["temp_c"] >= 88 or disk_pct >= 95:
        alert = "crit"
    elif cpu_c >= 85 or gpu["temp_c"] >= 78 or disk_pct >= 85:
        alert = "warn"

    return {
        "hostname": "aireward-llm",
        "role": "CUDA MoE Accelerator (RTX 3090)",
        "ip": "192.168.178.47",
        "status": "online",
        "alert_level": alert,
        "temps": {
            "cpu_c": cpu_c,
            "gpu_c": gpu["temp_c"],
            "nvme_c": nvme_c
        },
        "gpu": {
            "name": gpu["name"],
            "load_pct": gpu["load_pct"],
            "sclk_mhz": gpu["sclk_mhz"],
            "power_w": gpu["power_w"],
            "vram_used_gb": round(gpu["mem_used_mib"] / 1024.0, 1),
            "vram_total_gb": round(gpu["mem_total_mib"] / 1024.0, 1),
            "fan_pct": gpu["fan_pct"],
            "arch": "GA102 / Ampere 24GB"
        },
        "cooling": {
            "gpu_fan_pct": gpu["fan_pct"],
            "profile": "Dual Axial Dynamic"
        },
        "cpu": {
            "model": "Intel Core i5-13500 (14C/20T)",
            "temp_c": cpu_c
        },
        "ram": {
            "used_gb": ram_used,
            "total_gb": mem_tot,
            "free_gb": mem_avail,
            "pct": ram_pct
        },
        "disk": {
            "used_gb": disk_used,
            "total_gb": disk_tot,
            "free_gb": disk_free,
            "pct": disk_pct
        }
    }


def is_strata_running() -> tuple[str, str, dict, int]:
    """Check if Strata server is alive on port 8080 or 8085."""
    for port in (8080, 8085):
        try:
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=1.5)
            conn.request("GET", "/v1/models")
            resp = conn.getresponse()
            data = resp.read().decode("utf-8", errors="ignore")
            conn.close()
            if resp.status == 200:
                parsed = json.loads(data)
                active = "qwen3.8-flash-next-iq3_s" if "qwen" in data.lower() else ("deepseek-v4.1-flash" if "deepseek" in data.lower() else "custom")
                return "running", active, parsed, port
        except Exception:
            pass

    p1 = subprocess.run(["pgrep", "-f", "engine/strata"], capture_output=True)
    p2 = subprocess.run(["pgrep", "-f", "strata-dsv41"], capture_output=True)
    p3 = subprocess.run(["pgrep", "-f", "serve/server.py"], capture_output=True)
    if p1.returncode == 0 or p2.returncode == 0 or p3.returncode == 0:
        return "starting", f"{ACTIVE_MODEL_NAME} (loading)", {}, 8080

    return "idle", "none", {}, 8080


def stop_strata_engine():
    global ENGINE_PROCESS, ACTIVE_MODEL_NAME
    subprocess.run(["pkill", "-f", "serve/server.py"], capture_output=True)
    subprocess.run(["pkill", "-f", "engine/strata"], capture_output=True)
    subprocess.run(["pkill", "-f", "strata-dsv41"], capture_output=True)
    if ENGINE_PROCESS:
        try:
            ENGINE_PROCESS.terminate()
            ENGINE_PROCESS.wait(timeout=3)
        except Exception:
            pass
        ENGINE_PROCESS = None
    ACTIVE_MODEL_NAME = "none"
    time.sleep(1)


def start_strata_engine(target_model: str) -> tuple[bool, str]:
    global ENGINE_PROCESS, ACTIVE_MODEL_NAME
    with STATE_LOCK:
        status, active_mod, _, active_port = is_strata_running()
        if status == "running" and target_model in active_mod:
            return True, f"Modello {target_model} già attivo su porta {active_port}"

        stop_strata_engine()

        config_path = None
        if target_model in ("qwen", "qwen38", "iq3_s"):
            config_path = STRATA_REPO / "strata-iq3_s-64gb.json"
            if not config_path.exists():
                config_path = STRATA_REPO / "strata-iq3_s-optimized.json"
            if not config_path.exists():
                config_path = STRATA_REPO / "strata-iq3_s.json"
            ACTIVE_MODEL_NAME = "qwen3.8-flash-next-iq3_s"
        elif target_model in ("deepseek", "deepseek41", "ds41", "iq2_xxs"):
            for candidate in STRATA_REPO.glob("strata-*dsv41*.json"):
                config_path = candidate
                break
            if not config_path:
                for candidate in STRATA_REPO.glob("strata-*deepseek*.json"):
                    config_path = candidate
                    break
            ACTIVE_MODEL_NAME = "deepseek-v4.1-flash"

        if not config_path or not config_path.exists():
            return False, f"Configurazione per '{target_model}' non trovata in {STRATA_REPO}"

        # Copy to active config
        shutil.copy2(config_path, STRATA_ACTIVE_CONFIG)

        # Detect port from config
        engine_port = STRATA_PORT
        try:
            cfg_data = json.loads(config_path.read_text())
            engine_port = cfg_data.get("port", STRATA_PORT)
        except Exception:
            pass

        # Launch server.py binding on 0.0.0.0 in background
        cmd = [
            str(STRATA_VENV),
            str(STRATA_SERVER),
            "--engine", "strata",
            "--config", str(STRATA_ACTIVE_CONFIG),
            "--host", "0.0.0.0",
            "--port", str(engine_port),
        ]
        log_file = open("/home/funboy/strata-repo/strata-server.log", "a")
        ENGINE_PROCESS = subprocess.Popen(
            cmd,
            cwd=str(STRATA_REPO),
            stdout=log_file,
            stderr=log_file,
            start_new_session=True
        )

        return True, f"Avvio di {ACTIVE_MODEL_NAME} su Strata in corso (caricamento asincrono su porta {engine_port})"


class NodeAgentHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def send_json(self, status: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        path = urlsplit(self.path).path
        if path in ("/telemetry", "/api/telemetry"):
            data = get_hardware_telemetry()
            state, active_mod, models_resp, active_port = is_strata_running()
            data["engine"] = {
                "name": "strata",
                "status": state,
                "active_model": active_mod if state != "idle" else None,
                "port": active_port,
                "models": models_resp.get("data", []) if models_resp else []
            }
            self.send_json(200, data)
            return

        if path in ("/health", "/api/health"):
            state, active_mod, _, active_port = is_strata_running()
            self.send_json(200, {
                "status": "healthy",
                "engine": "strata",
                "strata_state": state,
                "active_model": active_mod,
                "port": active_port
            })
            return

        if path in ("/models", "/v1/models"):
            state, _, models_resp, _ = is_strata_running()
            if state == "running" and models_resp:
                self.send_json(200, models_resp)
                return
            # Static list if idle
            self.send_json(200, {
                "object": "list",
                "data": [
                    {
                        "id": "qwen3.8-flash-next-iq3_s",
                        "object": "model",
                        "name": "Qwen 3.8 Flash Next IQ3_S (Strata RTX 3090 @ 100 tok/s)",
                        "status": "available",
                        "context_tokens": 131072
                    },
                    {
                        "id": "deepseek-v4.1-flash",
                        "object": "model",
                        "name": "DeepSeek V4.1 Flash Strata CUDA (RTX 3090 + MoE Resident)",
                        "status": "testing",
                        "context_tokens": 131072
                    }
                ]
            })
            return

        self.send_json(404, {"error": "Not Found"})

    def do_POST(self):
        path = urlsplit(self.path).path
        content_len = int(self.headers.get("Content-Length", 0))
        raw_body = self.rfile.read(content_len).decode("utf-8", errors="ignore") if content_len > 0 else "{}"
        try:
            body = json.loads(raw_body)
        except Exception:
            body = {}

        if path in ("/switch", "/api/switch"):
            target = body.get("model", "qwen").lower()
            ok, msg = start_strata_engine(target)
            self.send_json(200 if ok else 500, {"ok": ok, "message": msg, "target": target})
            return

        if path in ("/stop", "/api/stop"):
            stop_strata_engine()
            self.send_json(200, {"ok": True, "message": "Strata engine fermato"})
            return

        self.send_json(404, {"error": "Not Found"})

    def log_message(self, format, *args):
        # Keep logs clean
        pass


if __name__ == "__main__":
    is_probe = (len(sys.argv) > 1 and sys.argv[1] == "probe") or sys.argv[0].endswith("probe")
    if is_probe:
        data = get_hardware_telemetry()
        running, active_mod, _ = is_strata_running()
        data["engine"] = {
            "name": "strata",
            "status": "running" if running else "idle",
            "active_model": active_mod if running else None,
            "port": STRATA_PORT
        }
        print(json.dumps(data, indent=2))
        sys.exit(0)

    print(f"[AIREWARD-AGENT] In ascolto su 0.0.0.0:{PORT}...")
    server = HTTPServer(("0.0.0.0", PORT), NodeAgentHandler)
    server.serve_forever()
