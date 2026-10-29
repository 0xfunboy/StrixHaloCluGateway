/**
 * YED1Z QUANTUM-HALO CYBER-INSTRUMENTATION TERMINAL // MARK IV
 * 90s Aerospacial Workstation HUD & Telemetry Control Engine
 */

// Global State
let currentTheme = localStorage.getItem('theme') || 'dark';
let crtActive = localStorage.getItem('crt') !== 'false';
let currentInspectorView = 'cluster'; // 'cluster' | 'die'
let lastTelemetry = null;
let animationFrameId = null;

// ============================================================================
// 1. THEME & CRT CONTROLS
// ============================================================================
function initThemeAndCrt() {
  document.documentElement.setAttribute('data-theme', currentTheme);
  const themeIcon = document.getElementById('theme-icon');
  if (themeIcon) {
    themeIcon.textContent = currentTheme === 'dark' ? 'DARK' : 'LIGHT';
  }

  const crtLabel = document.getElementById('crt-mode-label');
  if (crtActive) {
    document.body.classList.add('crt-active');
    if (crtLabel) crtLabel.textContent = 'ON';
  } else {
    document.body.classList.remove('crt-active');
    if (crtLabel) crtLabel.textContent = 'OFF';
  }

  const themeBtn = document.getElementById('theme-toggle');
  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', currentTheme);
      localStorage.setItem('theme', currentTheme);
      if (themeIcon) themeIcon.textContent = currentTheme === 'dark' ? 'DARK' : 'LIGHT';
      if (lastTelemetry && lastTelemetry.stats) {
        renderTokensChart(lastTelemetry.stats.daily_tokens || {});
      }
    });
  }

  const crtBtn = document.getElementById('crt-toggle-btn');
  if (crtBtn) {
    crtBtn.addEventListener('click', () => {
      crtActive = !crtActive;
      localStorage.setItem('crt', crtActive);
      if (crtActive) {
        document.body.classList.add('crt-active');
        if (crtLabel) crtLabel.textContent = 'ON';
      } else {
        document.body.classList.remove('crt-active');
        if (crtLabel) crtLabel.textContent = 'OFF';
      }
    });
  }
}

// UTC Clock
function updateClock() {
  const clockEl = document.getElementById('hud-clock-val');
  if (clockEl) {
    const now = new Date();
    clockEl.textContent = now.toUTCString().split(' ')[4] || now.toISOString().slice(11, 19);
  }
}
setInterval(updateClock, 1000);
updateClock();

// ============================================================================
// 2. CHASSIS & SILICON INSPECTOR VIEWPORT SWITCHER
// ============================================================================
function initInspectorSwitcher() {
  const btnCluster = document.getElementById('btn-view-cluster');
  const btnDie = document.getElementById('btn-view-die');
  const imgEl = document.getElementById('inspector-img');
  const hs01 = document.getElementById('hs-node01');
  const hsUsb = document.getElementById('hs-usb4');
  const hs02 = document.getElementById('hs-node02');

  if (!btnCluster || !btnDie || !imgEl) return;

  btnCluster.addEventListener('click', () => {
    currentInspectorView = 'cluster';
    btnCluster.classList.add('active');
    btnDie.classList.remove('active');
    imgEl.style.opacity = '0';
    setTimeout(() => {
      imgEl.src = '/static/assets/strix_halo_dual_cluster.jpg';
      imgEl.style.opacity = '1';
      if (hs01) { hs01.querySelector('.hs-label').textContent = 'NODE 01 (PRIMARY)'; hs01.style.top = '32%'; hs01.style.left = '14%'; }
      if (hsUsb) { hsUsb.querySelector('.hs-label').textContent = '40Gbps USB4 INTERCONNECT'; hsUsb.style.top = '58%'; hsUsb.style.left = '32%'; }
      if (hs02) { hs02.querySelector('.hs-label').textContent = 'NODE 02 (WORKER)'; hs02.style.top = '32%'; hs02.style.left = '62%'; }
    }, 150);
  });

  btnDie.addEventListener('click', () => {
    currentInspectorView = 'die';
    btnDie.classList.add('active');
    btnCluster.classList.remove('active');
    imgEl.style.opacity = '0';
    setTimeout(() => {
      imgEl.src = '/static/assets/strix_halo_die_schematic.jpg';
      imgEl.style.opacity = '1';
      if (hs01) { hs01.querySelector('.hs-label').textContent = 'DUAL ZEN 5 CCDs (16 CORES)'; hs01.style.top = '22%'; hs01.style.left = '18%'; }
      if (hsUsb) { hsUsb.querySelector('.hs-label').textContent = '40 CU RDNA 3.5 iGPU'; hsUsb.style.top = '48%'; hsUsb.style.left = '36%'; }
      if (hs02) { hs02.querySelector('.hs-label').textContent = '256-BIT LPDDR5X PHY'; hs02.style.top = '72%'; hs02.style.left = '58%'; }
    }, 150);
  });
}

// ============================================================================
// 3. INTERACTIVE 4D TESSERACT HYPER-PROJECTION CANVAS
// ============================================================================
function init4DTesseract() {
  const canvas = document.getElementById('tesseract-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  // 16 4D Vertices (+-1, +-1, +-1, +-1)
  const vertices = [];
  for (let i = 0; i < 16; i++) {
    vertices.push([
      (i & 1) ? 1 : -1,
      (i & 2) ? 1 : -1,
      (i & 4) ? 1 : -1,
      (i & 8) ? 1 : -1,
    ]);
  }

  // 32 4D Edges (connect vertices differing by exactly 1 bit)
  const edges = [];
  for (let i = 0; i < 16; i++) {
    for (let j = i + 1; j < 16; j++) {
      let diff = 0;
      for (let k = 0; k < 4; k++) {
        if (vertices[i][k] !== vertices[j][k]) diff++;
      }
      if (diff === 1) edges.push([i, j]);
    }
  }

  // Angles of rotation in 4D planes
  let angleXW = 0;
  let angleYW = 0;
  let angleZW = 0;
  let angleXY = 0;

  let mouseX = 0;
  let mouseY = 0;
  let isDragging = false;
  let lastMouseX = 0;
  let lastMouseY = 0;

  canvas.addEventListener('mousedown', (e) => {
    isDragging = true;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
  });

  window.addEventListener('mouseup', () => { isDragging = false; });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - lastMouseX;
    const dy = e.clientY - lastMouseY;
    angleXY += dx * 0.01;
    angleYW += dy * 0.01;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
  });

  let lastFrameTime = performance.now();
  let frameCount = 0;
  let fps = 60;
  const fpsEl = document.getElementById('tess-fps');
  const coordsEl = document.getElementById('tesseract-coords');

  function renderTesseract(now) {
    const dt = (now - lastFrameTime) / 1000;
    lastFrameTime = now;
    frameCount++;

    if (frameCount % 30 === 0 && fpsEl) {
      fps = Math.round(1 / (dt || 0.016));
      fpsEl.textContent = `${fps} FPS`;
    }

    // Auto-rotation speed ramps up if in-flight inference is happening
    const speedMultiplier = (lastTelemetry && lastTelemetry.in_flight > 0) ? 2.5 : 1.0;
    angleXW += 0.012 * speedMultiplier;
    angleZW += 0.008 * speedMultiplier;

    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    // Coordinate readout
    if (coordsEl && frameCount % 10 === 0) {
      coordsEl.textContent = `W: ${(Math.cos(angleXW)).toFixed(3)} | X: ${(Math.sin(angleXY)).toFixed(3)} | Y: ${(Math.cos(angleYW)).toFixed(3)} | Z: ${(Math.sin(angleZW)).toFixed(3)}`;
    }

    // Transform 4D vertices through 4D rotation matrices
    const cosXW = Math.cos(angleXW), sinXW = Math.sin(angleXW);
    const cosZW = Math.cos(angleZW), sinZW = Math.sin(angleZW);
    const cosXY = Math.cos(angleXY), sinXY = Math.sin(angleXY);
    const cosYW = Math.cos(angleYW), sinYW = Math.sin(angleYW);

    const projected2D = [];

    for (let i = 0; i < 16; i++) {
      let [x, y, z, w] = vertices[i];

      // Rotate in XW plane
      let x1 = x * cosXW - w * sinXW;
      let w1 = x * sinXW + w * cosXW;

      // Rotate in ZW plane
      let z2 = z * cosZW - w1 * sinZW;
      let w2 = z * sinZW + w1 * cosZW;

      // Rotate in XY plane
      let x3 = x1 * cosXY - y * sinXY;
      let y3 = x1 * sinXY + y * cosXY;

      // Rotate in YW plane
      let y4 = y3 * cosYW - w2 * sinYW;
      let w4 = y3 * sinYW + w2 * cosYW;

      // Perspective projection 4D -> 3D (distance d = 2.4)
      const dist4D = 2.4;
      const factor4D = 1 / (dist4D - w4);
      let p3X = x3 * factor4D;
      let p3Y = y4 * factor4D;
      let p3Z = z2 * factor4D;

      // Perspective projection 3D -> 2D
      const dist3D = 3.2;
      const factor3D = 1 / (dist3D - p3Z);
      const scale = 220;

      const screenX = width / 2 + p3X * factor3D * scale;
      const screenY = height / 2 + p3Y * factor3D * scale;

      projected2D.push({ x: screenX, y: screenY, w: w4, depth: p3Z });
    }

    // Draw Edges
    const isDark = currentTheme === 'dark';
    ctx.lineWidth = 1.2;

    for (let i = 0; i < edges.length; i++) {
      const [u, v] = edges[i];
      const p1 = projected2D[u];
      const p2 = projected2D[v];

      const avgW = (p1.w + p2.w) / 2;
      const alpha = Math.max(0.2, Math.min(1.0, 0.6 + avgW * 0.35));

      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);

      if (avgW > 0) {
        ctx.strokeStyle = isDark ? `rgba(0, 242, 254, ${alpha})` : `rgba(2, 132, 199, ${alpha})`;
      } else {
        ctx.strokeStyle = isDark ? `rgba(192, 132, 252, ${alpha})` : `rgba(147, 51, 234, ${alpha})`;
      }
      ctx.stroke();
    }

    // Draw Glowing Vertex Nodes
    for (let i = 0; i < projected2D.length; i++) {
      const p = projected2D[i];
      const r = Math.max(1.8, 3.2 + p.w * 1.5);

      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = p.w > 0 ? (isDark ? '#00ff88' : '#059669') : (isDark ? '#ffb000' : '#d97706');
      ctx.fill();
    }

    requestAnimationFrame(renderTesseract);
  }

  requestAnimationFrame(renderTesseract);
}

// ============================================================================
// 4. CRT PHOSPHOR OSCILLOSCOPE CANVAS (CH1: TOKEN WAVE, CH2: BUS JITTER)
// ============================================================================
function initOscilloscope() {
  const canvas = document.getElementById('osc-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  let phase = 0;

  function renderOsc() {
    const width = canvas.width;
    const height = canvas.height;

    // Phosphor decay persistence
    ctx.fillStyle = 'rgba(2, 6, 3, 0.22)';
    ctx.fillRect(0, 0, width, height);

    const isBusy = lastTelemetry && lastTelemetry.in_flight > 0;
    const decodeTps = (lastTelemetry && lastTelemetry.speeds) ? lastTelemetry.speeds.decode_tps : 51.4;

    phase += isBusy ? 0.12 : 0.04;

    // --- Trace 1: Channel 1 Token Emission Wave (Phosphor Green #00ff88) ---
    ctx.beginPath();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = '#00ff88';
    ctx.shadowBlur = 6;
    ctx.shadowColor = '#00ff88';

    const centerY1 = height * 0.42;
    for (let x = 0; x < width; x += 2) {
      const freq = (decodeTps / 30) * 0.04;
      const noise = isBusy ? (Math.random() - 0.5) * 6 : (Math.random() - 0.5) * 1.5;
      const amp = isBusy ? 28 : 14;
      const y = centerY1 + Math.sin(x * freq + phase) * amp + noise;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // --- Trace 2: Channel 2 USB4 Interconnect Bus Jitter (Neon Cyan #00f2fe) ---
    ctx.beginPath();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = '#00f2fe';
    ctx.shadowBlur = 4;
    ctx.shadowColor = '#00f2fe';

    const centerY2 = height * 0.72;
    for (let x = 0; x < width; x += 3) {
      const busNoise = (Math.sin(x * 0.08 - phase * 1.5) * 6) + (Math.random() - 0.5) * 3;
      const y = centerY2 + busNoise;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Reset shadow
    ctx.shadowBlur = 0;

    requestAnimationFrame(renderOsc);
  }

  requestAnimationFrame(renderOsc);
}

// ============================================================================
// 5. HIGH-PRECISION ANALOG DIAL GAUGES (SVG/CANVAS NEEDLES & TICKS)
// ============================================================================
function drawAnalogDial(canvasId, value, minVal, maxVal, unit, warnVal, critVal) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const size = canvas.width;
  const center = size / 2;
  const radius = center - 10;

  ctx.clearRect(0, 0, size, size);

  const startAngle = (135 * Math.PI) / 180;
  const endAngle = (405 * Math.PI) / 180;
  const totalSweep = endAngle - startAngle;

  const isDark = currentTheme === 'dark';

  // Outer Bezel Ring
  ctx.beginPath();
  ctx.arc(center, center, radius, 0, Math.PI * 2);
  ctx.strokeStyle = isDark ? '#1e293b' : '#cbd5e1';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Background Inactive Arc
  ctx.beginPath();
  ctx.arc(center, center, radius - 6, startAngle, endAngle);
  ctx.strokeStyle = isDark ? '#0f172a' : '#e2e8f0';
  ctx.lineWidth = 6;
  ctx.stroke();

  // Active Value Normalized
  const clampedVal = Math.max(minVal, Math.min(maxVal, value));
  const pct = (clampedVal - minVal) / (maxVal - minVal);
  const currentAngle = startAngle + pct * totalSweep;

  // Color selection
  let arcColor = isDark ? '#00ff88' : '#059669';
  if (value >= critVal) arcColor = isDark ? '#ff3366' : '#e11d48';
  else if (value >= warnVal) arcColor = isDark ? '#ffb000' : '#d97706';

  // Active Colored Arc
  ctx.beginPath();
  ctx.arc(center, center, radius - 6, startAngle, currentAngle);
  ctx.strokeStyle = arcColor;
  ctx.lineWidth = 6;
  ctx.stroke();

  // Tick Marks (8 major ticks)
  for (let i = 0; i <= 8; i++) {
    const tickPct = i / 8;
    const tickAngle = startAngle + tickPct * totalSweep;
    const cosA = Math.cos(tickAngle);
    const sinA = Math.sin(tickAngle);

    const r1 = radius - 11;
    const r2 = radius - 16;

    ctx.beginPath();
    ctx.moveTo(center + cosA * r1, center + sinA * r1);
    ctx.lineTo(center + cosA * r2, center + sinA * r2);
    ctx.strokeStyle = isDark ? '#475569' : '#94a3b8';
    ctx.lineWidth = i % 2 === 0 ? 1.5 : 1;
    ctx.stroke();
  }

  // Rotating Needle Pointer
  ctx.save();
  ctx.translate(center, center);
  ctx.rotate(currentAngle);

  // Needle Body
  ctx.beginPath();
  ctx.moveTo(-3, 0);
  ctx.lineTo(0, -(radius - 12));
  ctx.lineTo(3, 0);
  ctx.closePath();
  ctx.fillStyle = arcColor;
  ctx.fill();

  // Needle Hub
  ctx.beginPath();
  ctx.arc(0, 0, 5, 0, Math.PI * 2);
  ctx.fillStyle = isDark ? '#ffffff' : '#0f172a';
  ctx.fill();
  ctx.restore();
}

// ============================================================================
// 6. SEGMENTED LED VU-METERS (20 RECTANGULAR PIPS)
// ============================================================================
function renderLedBar(containerId, pct) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const totalPips = 20;
  const activePips = Math.round((pct / 100) * totalPips);

  let html = '';
  for (let i = 0; i < totalPips; i++) {
    if (i < activePips) {
      if (i < 14) html += '<span class="vu-pip lit-green"></span>';
      else if (i < 17) html += '<span class="vu-pip lit-amber"></span>';
      else html += '<span class="vu-pip lit-red"></span>';
    } else {
      html += '<span class="vu-pip"></span>';
    }
  }
  container.innerHTML = html;
}

// ============================================================================
// 7. RETRO CANVAS BAR CHART (DAILY TOKENS)
// ============================================================================
function renderTokensChart(daily) {
  const canvas = document.getElementById('tokens-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = rect.width;
  const height = rect.height;

  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.scale(dpr, dpr);

  ctx.clearRect(0, 0, width, height);

  const dates = Object.keys(daily).sort();
  if (dates.length === 0) {
    ctx.fillStyle = currentTheme === 'dark' ? '#64748b' : '#94a3b8';
    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('No historical token data recorded', width / 2, height / 2);
    return;
  }

  let maxTokens = 1000;
  dates.forEach(d => {
    const sum = (daily[d].deepseek || 0) + (daily[d].qwen || 0);
    if (sum > maxTokens) maxTokens = sum;
  });
  maxTokens = Math.ceil(maxTokens * 1.15);

  const paddingLeft = 45;
  const paddingRight = 15;
  const paddingTop = 20;
  const paddingBottom = 30;
  const chartW = width - paddingLeft - paddingRight;
  const chartH = height - paddingTop - paddingBottom;

  const isDark = currentTheme === 'dark';
  const gridColor = isDark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.06)';
  const textColor = isDark ? '#64748b' : '#94a3b8';

  // Grid Lines
  ctx.lineWidth = 1;
  ctx.font = '9px "JetBrains Mono", monospace';
  ctx.textAlign = 'right';
  ctx.fillStyle = textColor;

  const gridSteps = 4;
  for (let i = 0; i <= gridSteps; i++) {
    const y = paddingTop + chartH - (i / gridSteps) * chartH;
    const val = Math.round((i / gridSteps) * maxTokens);
    ctx.beginPath();
    ctx.strokeStyle = gridColor;
    ctx.moveTo(paddingLeft, y);
    ctx.lineTo(width - paddingRight, y);
    ctx.stroke();
    ctx.fillText(formatNumber(val), paddingLeft - 6, y + 3);
  }

  // Draw Bars
  const slotW = chartW / dates.length;
  const barW = Math.max(12, Math.min(34, slotW * 0.55));

  dates.forEach((dateStr, i) => {
    const dsTok = daily[dateStr].deepseek || 0;
    const qwenTok = daily[dateStr].qwen || 0;

    const x = Math.round(paddingLeft + i * slotW + (slotW - barW) / 2);
    const dsH = Math.round((dsTok / maxTokens) * chartH);
    const qwenH = Math.round((qwenTok / maxTokens) * chartH);
    const yBase = paddingTop + chartH;

    // DeepSeek portion (Cyan)
    if (dsH > 0) {
      ctx.fillStyle = isDark ? '#00f2fe' : '#0284c7';
      ctx.fillRect(x, yBase - dsH, barW, dsH);
    }

    // Qwen portion (Purple stacked)
    if (qwenH > 0) {
      ctx.fillStyle = isDark ? '#c084fc' : '#9333ea';
      ctx.fillRect(x, yBase - dsH - qwenH, barW, qwenH);
    }

    // Date Label
    ctx.fillStyle = textColor;
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    const shortDate = dateStr.slice(5);
    ctx.fillText(shortDate, x + barW / 2, height - paddingBottom + 14);
  });
}

// ============================================================================
// 8. TELEMETRY DATA POLLER & HUD UPDATE ENGINE
// ============================================================================
async function fetchTelemetry() {
  try {
    const res = await fetch('/api/telemetry', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    lastTelemetry = data;
    updateHUD(data);
  } catch (err) {
    console.error('Telemetry fetch failed:', err);
  }
}

function updateHUD(data) {
  // Master Active Model Banner
  const modelTitle = document.getElementById('active-model-title');
  if (modelTitle) {
    if (data.active_model === 'deepseek') {
      modelTitle.textContent = 'DEEPSEEK V4.1 DUAL TP2';
      modelTitle.className = 'pill-value text-cyan';
    } else if (data.active_model === 'qwen') {
      modelTitle.textContent = 'QWEN 3.8 FLASH NEXT';
      modelTitle.className = 'pill-value text-purple';
    } else {
      modelTitle.textContent = 'STANDBY // READY';
      modelTitle.className = 'pill-value text-amber';
    }
  }

  // Pipeline in-flight counter
  setText('wf-inflight-val', `${data.in_flight || 0} REQ`);

  // Speeds
  if (data.speeds) {
    setText('wf-tps-val', `${data.speeds.decode_tps} tok/s`);
    setText('wf-acc-val', `${data.speeds.dspark_acc}%`);
    setText('wf-ttft-val', `${data.speeds.ttft_ms} ms`);

    setText('osc-decode-val', `${data.speeds.decode_tps} TPS`);
    setText('osc-prefill-val', `${data.speeds.prefill_tps} TPS`);
    setText('osc-acc-val', `${data.speeds.dspark_acc}%`);
  }

  // Telemetry per node
  if (data.telemetry) {
    const n1 = data.telemetry.node01;
    const n2 = data.telemetry.node02;
    const tb = data.telemetry.tb_link;

    if (n1) updateNodePod('node01', n1);
    if (n2) updateNodePod('node02', n2);
    if (tb) {
      setText('link-rtt-val', `${(tb.rtt_ms || 0.16).toFixed(3)} ms`);
    }
  }

  // Stats & Sessions
  if (data.stats) {
    if (data.stats.totals) {
      setText('total-tokens-badge', formatNumber(data.stats.totals.total_tokens || 0));
    }
    renderTokensChart(data.stats.daily_tokens || {});
    renderSessionsTable(data.stats.recent_sessions || []);
  }
}

function updateNodePod(nodeKey, nodeData) {
  const temps = nodeData.temps || {};
  const cooling = nodeData.cooling || {};
  const gpu = nodeData.gpu || {};
  const ram = nodeData.ram || {};
  const disk = nodeData.disk || {};

  // 1. Digital Values
  setText(`${nodeKey}-temp-val`, `${temps.cpu_c ? temps.cpu_c.toFixed(1) : 42.0}°C`);
  setText(`${nodeKey}-fan-val`, `${cooling.fan_rpm || 1900} RPM`);
  setText(`${nodeKey}-power-val`, `${gpu.power_w ? gpu.power_w.toFixed(1) : 11.0} W`);

  setText(`${nodeKey}-gpu-temp`, `${temps.gpu_c ? temps.gpu_c.toFixed(1) : 41.0}°C`);
  setText(`${nodeKey}-nvme-temp`, `${temps.nvme_c ? temps.nvme_c.toFixed(1) : 32.0}°C`);
  setText(`${nodeKey}-sclk`, `${gpu.sclk_mhz || 605} MHz`);
  setText(`${nodeKey}-gpu-load`, `${gpu.load_pct || 0}%`);

  // 2. Analog Dials
  drawAnalogDial(`dial-${nodeKey}-temp`, temps.cpu_c || 42, 20, 100, '°C', 75, 88);
  drawAnalogDial(`dial-${nodeKey}-fan`, cooling.fan_rpm || 1900, 0, 5000, 'RPM', 3500, 4400);
  drawAnalogDial(`dial-${nodeKey}-power`, gpu.power_w || 11, 0, 75, 'W', 50, 65);

  // 3. Segmented LED VU-Meters
  const ramPct = ram.pct || Math.round((ram.used_gb / ram.total_gb) * 100);
  setText(`${nodeKey}-ram-text`, `${ram.used_gb.toFixed(1)} / ${ram.total_gb.toFixed(1)} GiB (${ramPct}%)`);
  renderLedBar(`${nodeKey}-ram-leds`, ramPct);

  const diskPct = disk.pct || Math.round((disk.used_gb / disk.total_gb) * 100);
  setText(`${nodeKey}-disk-text`, `${disk.used_gb.toFixed(1)} / ${disk.total_gb.toFixed(1)} GiB (${diskPct}%)`);
  renderLedBar(`${nodeKey}-disk-leds`, diskPct);

  // 4. Alert Badge
  const alertEl = document.getElementById(`${nodeKey}-alert-pill`);
  if (alertEl) {
    const lvl = nodeData.alert_level || 'healthy';
    alertEl.className = `alert-pill-retro alert-${lvl}`;
    alertEl.textContent = lvl.toUpperCase();
  }
}

function renderSessionsTable(sessions) {
  const tbody = document.getElementById('sessions-tbody');
  if (!tbody) return;

  if (!sessions || sessions.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" class="text-center py-4" style="color:var(--text-muted)">No active sessions logged. Ready for GitHub Copilot Chat queries!</td></tr>`;
    return;
  }

  tbody.innerHTML = sessions.slice(0, 15).map(s => {
    const isDs = (s.model || '').includes('ds41') || (s.model || '').includes('deepseek');
    const badge = isDs 
      ? `<span class="badge-ds">DeepSeek V4.1</span>` 
      : `<span class="badge-qwen">Qwen 3.8</span>`;

    const userLabel = s.user || (s.client === '127.0.0.1' ? 'funboy (local)' : 'cooper');
    const appLabel = s.client_app || 'Copilot Chat';
    const tpsVal = s.tok_per_sec ? `${s.tok_per_sec} tok/s` : '—';

    return `
      <tr>
        <td><code>${escapeHtml(s.id || 'req')}</code></td>
        <td>${escapeHtml(s.time || '')}</td>
        <td><span class="user-tag">${escapeHtml(userLabel)}</span></td>
        <td><span class="app-tag">${escapeHtml(appLabel)}</span></td>
        <td>${badge}</td>
        <td>${s.prompt_tokens ?? '—'}</td>
        <td><strong>${s.completion_tokens ?? '—'}</strong></td>
        <td>${s.duration_s ? `${s.duration_s}s` : '—'}</td>
        <td><span class="speed-pill">${tpsVal}</span></td>
        <td><span class="status-badge ${s.status === 'completed' ? 'success' : 'pending'}">${escapeHtml(s.status || 'done').toUpperCase()}</span></td>
      </tr>
    `;
  }).join('');
}

// Helpers
function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function formatNumber(num) {
  return new Intl.NumberFormat('en-US').format(num);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ============================================================================
// INITIALIZATION
// ============================================================================
document.addEventListener('DOMContentLoaded', () => {
  initThemeAndCrt();
  initInspectorSwitcher();
  init4DTesseract();
  initOscilloscope();

  // Initial fetch and 2-second telemetry loop
  fetchTelemetry();
  setInterval(fetchTelemetry, 2000);

  window.addEventListener('resize', () => {
    if (lastTelemetry && lastTelemetry.stats) {
      renderTokensChart(lastTelemetry.stats.daily_tokens || {});
    }
  });
});
