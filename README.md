<p align="center">
  <img src="static/assets/strix_halo_dual_cluster.jpg" alt="StrixHaloCluGateway — Dual AMD Strix Halo Inference Gateway" width="100%" style="border-radius: 8px;">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Platform-Hybrid%20Cluster%20(AMD%20%2B%20NVIDIA)-ED1C24?style=flat-square&logo=amd&logoColor=white" alt="AMD Strix Halo + NVIDIA">
  <img src="https://img.shields.io/badge/GPUs-Dual%20Radeon%208060S%20%2B%20RTX%203090-black?style=flat-square&logo=nvidia&logoColor=76B900" alt="gfx1151 + GA102">
  <img src="https://img.shields.io/badge/API-OpenAI%20Compatible-00A67E?style=flat-square&logo=openai&logoColor=white" alt="OpenAI API">
  <img src="https://img.shields.io/badge/Interconnect-40Gbps%20USB4%20%2B%201Gbps%20LAN-0078D7?style=flat-square&logo=thunderbolt&logoColor=white" alt="USB4 + LAN">
  <img src="https://img.shields.io/badge/Serving-DeepSeek%20V4.1%20%7C%20Qwen%203.8%20(Gufo%20%26%20Strata%20100tps)-8A2BE2?style=flat-square" alt="Served Models">
  <img src="https://img.shields.io/badge/UI-Cyber--Industrial%20HUD-00ff66?style=flat-square&logo=gnometerminal&logoColor=black" alt="Cyber-Industrial UI">
  <img src="https://img.shields.io/badge/License-0xfunboy%20Non--Commercial-purple?style=flat-square" alt="0xfunboy License">
</p>

<h1 align="center">⚡ StrixHaloCluGateway</h1>

<p align="center">
  <b>High-Throughput Arbitrated Inference Gateway & Cyber-Industrial Telemetry Station</b><br>
  <i>Mission-critical gateway, multi-user lock-free arbitration, and live hardware HUD for paired AMD Strix Halo clusters + Aireward-LLM CUDA Accelerator.</i>
</p>

<p align="center">
  <a href="#executive-overview"><strong>Executive Overview</strong></a> ·
  <a href="#cluster-architecture">Cluster Architecture</a> ·
  <a href="#arbitration--concurrency">Arbitration Engine</a> ·
  <a href="#models-served">Models Served</a> ·
  <a href="#api-reference">API Reference</a> ·
  <a href="#cyber-industrial-hud">HUD & Telemetry</a> ·
  <a href="#deployment">Deployment</a> ·
  <a href="#license">License</a>
</p>

---

## 🎯 Executive Overview

**StrixHaloCluGateway** is the unified front-door proxy, hardware telemetry station, and model orchestrator powering the **Hybrid 3-Node Cluster**:
1. **Node 01 (`01-EVO-X3`)**: AMD Ryzen AI Max+ 395 / Radeon 8060S `gfx1151` (Coordinator · Rank 0 · 128 GB LPDDR5X).
2. **Node 02 (`02-evo-x3-tb`)**: AMD Ryzen AI Max+ 395 / Radeon 8060S `gfx1151` (Worker · Rank 1 · 128 GB LPDDR5X).
3. **Node 03 (`aireward-llm`)**: Intel Core i5-13500, 64 GB DDR5, NVIDIA GeForce RTX 3090 24 GB, 2 TB Samsung 990 Pro NVMe (Dedicated Strata MoE CUDA Accelerator).

It exposes an **OpenAI-compatible REST and streaming API** (`/v1/chat/completions`, `/v1/models`, `/health`, `/api/telemetry`, `/api/switch`), dynamically multiplexing inference traffic across native backends:
- **DeepSeek V4.1 Flash Kirei HIP** — Dual-node Tensor-Parallel 2 cluster over point-to-point 40 Gbps USB4 DMA (~50–70 tok/s).
- **Qwen 3.8 Flash Next Uncensored Gufo** — Ultra-low latency single-node resident with speculative MTP decoding (~30–45 tok/s).
- **Qwen 3.8 Flash Next Strata IQ3_S** — Blazing 100 tok/s MTP CUDA engine on Aireward-LLM RTX 3090.
- **DeepSeek V4.1 Flash IST-DAS Strata CUDA** — 2.00bpw speculative CUDA engine on Aireward-LLM.

Equipped with an **anti-collision arbitration core**, the gateway guarantees zero compute collisions, atomic model switching, and real-time session tracking without dropping in-flight user tokens.

---

## 🧩 Cluster Architecture

```
                                   [ Incoming Client Requests ]
                              (OpenAI SDK / Web / Copilot / CLI)
                                              │
                                      Port 8081 / 18561
                                              ▼
                      ┌───────────────────────────────────────────────┐
                      │             StrixHaloCluGateway               │
                      │  - Bearer Token Authentication                │
                      │  - In-Flight Request Scope & Lock-Drain       │
                      │  - Hardware Telemetry & Analog Dial Feeds     │
                      │  - Chunked SSE Streaming & <think> Folding    │
                      └───────────────────────┬───────────────────────┘
                                              │
                         ┌────────────────────┼────────────────────┐
                         │                    │                    │
                         ▼                    ▼                    ▼
             [ Strix: DeepSeek V4.1 ] [ Strix: Qwen 3.8 Gufo ] [ Aireward: Strata ]
             Port 18231 (HTTP JSON)   Port 18562 (HTTP JSON)   192.168.178.47:8080/8085
                         │                    │                    │
                         ▼                    ▼                    ▼
          ┌──────────────────────────┐  ┌─────────────────┐  ┌───────────────────────┐
          │01-EVO-X3 (Rank 0 / Coord)│  │01-EVO-X3 Resid. │  │aireward-llm (RTX 3090)│
          │Kirei HIP C++ MoE Runtime │  │Gufo Podman      │  │Strata C++/CUDA Engine │
          └─────────────┬────────────┘  └─────────────────┘  └───────────────────────┘
                        │ 40 Gbps USB4 DMA                         ▲ 1 Gbps LAN Link
                        ▼ (10.55.0.0/30)                           │ (0.45 ms RTT)
          ┌──────────────────────────┐                             │
          │02-EVO-X3 (Rank 1 / Worker│─────────────────────────────┘
          │Kirei HIP Worker Engine   │
          └──────────────────────────┘
```

---

## ⚙️ Arbitration & Concurrency Engine

Switching between hundreds of gigabytes of LLM weights across a tri-node hybrid fabric requires strict synchronization:

- **Collision Avoidance (`SWITCH_LOCK` & `STATE_LOCK`)**: Prevents race conditions during model transition.
- **In-Flight Drain Monitoring**: If User A is streaming tokens on DeepSeek and User B calls Qwen, the gateway queues User B, waits for User A's stream to finalize cleanly, safely transitions the nodes via `/home/funboy/.local/bin/cluster-model` (or remote Strata agent), and initiates User B's stream without context corruption.
- **Independent Accelerator Concurrency**: Requests to `aireward-llm` run concurrently without stalling the Strix Halo cluster.
- **Atomic Port Probing**: Validates upstream readiness via `/v1/models` health handshakes before routing requests.

---

## 🤖 Models Served

| Model ID | Display Name | Architecture / Quant | Target Speed | Native Context | Node / Backend |
|---|---|---|---|---|---|
| `deepseek-v4.1-flash` / `ds41-abliterated-q2-imatrix` | **DeepSeek V4.1 Flash Kirei HIP** | 552B MoE (8B/16B active) · Q2_K imatrix + DSpark MXFP4 | **50.0 – 70.6 tok/s** | 131,072 tokens (128K) | Dual Strix Halo (USB4 TP2) |
| `qwen38-uncensored-gufo` | **Qwen 3.8 Flash Next Gufo** | Dense + Speculative MTP · Gufo GGUF + shared-Q8 draft | **30.0 – 45.0 tok/s** | 196,608 tokens (192K) | 01-EVO-X3 (Resident) |
| `qwen38-strata-100tps` / `qwen-strata` | **Qwen 3.8 Flash Next Strata** | GSQ-RCO-IQ3_S + MTP Draft 4 · 5 P-cores + 8 E-cores | **~100 tok/s** | 131,072 tokens (128K) | Aireward-LLM (RTX 3090) |
| `ds41-strata-cuda` / `ds41-strata` | **DeepSeek V4.1 Strata CUDA** | IST-DAS 2.00bpw · Ampere 24GB VRAM + NVMe streaming | Experimental | 131,072 tokens (128K) | Aireward-LLM (RTX 3090) |

---

## 🚀 API Reference

### 1. Health Probe
```bash
curl -s http://127.0.0.1:8081/health
```
```json
{
  "status": "healthy",
  "active_model": "qwen"
}
```

### 2. Available Models
```bash
curl -s http://127.0.0.1:8081/v1/models
```

### 3. Chat Completion (Streaming)
```bash
curl -N http://127.0.0.1:8081/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-strix-cluster-key" \
  -d '{
    "model": "deepseek-v4.1-flash",
    "messages": [{"role": "user", "content": "Explain USB4 DMA arbitration in Strix Halo."}],
    "stream": true,
    "max_tokens": 1024
  }'
```

### 4. Python OpenAI Client
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8081/v1",
    api_key="sk-strix-cluster-key"
)

response = client.chat.completions.create(
    model="deepseek-v4.1-flash",
    messages=[{"role": "user", "content": "Hello cluster!"}],
    stream=True
)

for chunk in response:
    content = chunk.choices[0].delta.content or ""
    print(content, end="", flush=True)
print()
```

---

## 📟 Cyber-Industrial HUD & Telemetry

The gateway serves a zero-framework, retro-futuristic HUD on `http://127.0.0.1:8081/`:
- **Real-Time Oscilloscope & CRT Grid**: Live tokens/sec output wave render.
- **Dual-Node Hardware Monitor**: Live temperatures, clock rates, unified RAM utilization and USB4 link bandwidth.
- **Analog Dials**: Real-time decode gauges with warning thresholds.
- **Session History Ledger**: Recent request telemetry, client aliases, token counts, and execution latencies.

---

## 🔧 Deployment & Systemd

The gateway is managed via user-level systemd:

```bash
# Start Gateway
systemctl --user start yed1z-gateway.service

# Check Live Logs
journalctl --user -fu yed1z-gateway.service

# Restart Gateway
systemctl --user restart yed1z-gateway.service
```

### Unit Configuration (`~/.config/systemd/user/yed1z-gateway.service`)
```ini
[Unit]
Description=StrixHaloCluGateway - Local Inference Gateway & Telemetry HUD
After=network-online.target strix-ds41-kirei.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/funboy/Gateway
ExecStart=/usr/bin/python3 /home/funboy/Gateway/gateway.py
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
```

---

## 📜 License

Distributed under the **0xfunboy Non-Commercial License**. See [LICENSE.md](LICENSE.md) for full terms.  
Commercial deployment and redistribution require written authorization from `@0xfunboy`.
