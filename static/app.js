/**
 * YED1Z QUANTUM-HALO CYBER-INSTRUMENTATION TERMINAL // MARK IV
 * 90s Aerospacial Workstation HUD & Telemetry Control Engine
 */

// Global State
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let currentTheme = 'dark';
let crtActive = false;
let themePreference = 'system';
let motionPreference = 'on';
let appearanceRevision = 0;
let appearanceQueue = Promise.resolve();
let currentLang = localStorage.getItem('yed1z_lang') || 'it';
let currentInspectorView = 'cluster'; // 'cluster' | 'die'
let lastTelemetry = null;
let animationFrameId = null;

// ============================================================================
// I18N BILINGUAL SYSTEM (IT / EN)
// ============================================================================
const I18N = {
  it: {
    sys_utc: 'SYS_UTC:',
    crt_fx: 'CRT FX:',
    control_room_btn: 'CONTROL ROOM',
    master_arbitration: 'ARBITRAGGIO PRINCIPALE:',
    sec1_name: 'TOPOLOGIA CLUSTER 4D & PIPELINE ARBITRAGGIO TEMPO REALE',
    sec1_status: 'PIPELINE ATTIVA // MUTEX FIFO MULTI-UTENTE INGAGGIATO',
    tess_title: 'IPER-PROIEZIONE TESSERATTO 4D',
    tess_sub: 'ROTAZIONE SPAZIALE INTERATTIVA · TRASCINA PER ORIENTARE',
    wf_title: 'FLUSSO PIPELINE MULTI-UTENTE AUTONOMO',
    wf_sync: 'TEMPO REALE ZERO-COLLISIONI',
    wf_step1: '01. APP CLIENT',
    wf_step2: '02. GATEWAY YED1Z',
    wf_step3: '03. CLUSTER TRI-NODO',
    wf_step4: '04. MOTORE SPECULATIVO',
    osc_title: 'OSCILLOSCOPIO AI FOSFORI CRT',
    osc_mode: 'CH1: TOK/S · CH2: JITTER BUS',
    osc_decode: 'VELOCITÀ DECODE',
    osc_prefill: 'BURST PREFILL',
    osc_acc: 'ACCURATEZZA SPEC.',
    sec2_name: 'SENSORI HARDWARE CLUSTER TRI-NODO & ISPETTORE CHASSIS',
    sec2_status: '3 NODI SINCRONIZZATI // DUAL STRIX HALO APU + ACCELERATORE AIREWARD CUDA',
    pod_node01_role: '[ COORDINATORE · RANK 0 ]',
    pod_node02_role: '[ WORKER · RANK 1 ]',
    pod_air_role: '[ ACCEL CUDA · RTX 3090 24GB ]',
    insp_title: 'PORTA ISPEZIONE CHASSIS & SILICIO',
    btn_view_cluster: 'VISTA DUAL CHASSIS',
    btn_view_die: 'BLUEPRINT DIE SILICIO',
    hs_node01: 'NODO 01 (PRIMARIO)',
    hs_usb4: 'INTERCONNESSIONE USB4 40Gbps',
    hs_node02: 'NODO 02 (WORKER)',
    matrix_badge: 'PIANO DI CONTROLLO',
    matrix_title: 'MATRICE DI ARBITRAGGIO MOTORI',
    guest_text: 'OSPITE (SOLA LETTURA)',
    admin_text: 'OPERATORE ADMIN',
    btn_unlock: '🔓 SBLOCCA',
    btn_lock: '🔒 BLOCCA',
    strix_group: 'CLUSTER DUAL STRIX HALO (256GB LPDDR5X)',
    air_group: 'ACCELERATORE AIREWARD-LLM (RTX 3090 + 64GB DDR5)',
    active_engines: 'MOTORI ATTIVI:',
    sec3_name: 'ANALISI STORICA PRODUZIONE & LOG FLUSSO INFERENZA',
    aggregated_tokens: 'TOKEN AGGREGATI:',
    chart_title: 'PRODUZIONE GIORNALIERA TOKEN PER MODELLO',
    stream_title: 'FLUSSO LOG INFERENZA IN TEMPO REALE',
    stream_meta: '[ NESSUNA ESPOSIZIONE IP CLIENT · ARBITRAGGIO AUTOMATICO ]',
    th_req_id: 'REQ ID',
    th_time: 'ORA',
    th_client: 'CLIENT / UTENTE',
    th_app: 'APPLICAZIONE',
    th_model: 'MODELLO SERVITO',
    th_prompt: 'PROMPT',
    th_gen: 'GEN',
    th_duration: 'DURATA',
    th_velocity: 'VELOCITÀ',
    th_status: 'STATO',
    modal_title: 'OVERRIDE DI SISTEMA // AUTENTICAZIONE ADMIN',
    modal_notice_strong: 'PIANO DI CONTROLLO ARBITRAGGIO RISERVATO',
    modal_notice_body: 'Il cambio di modello live e il controllo del cluster richiedono autorizzazione crittografica operatore. Inserisci la tua chiave Bearer (<code class="mono-code">sk-yed...</code>) per sbloccare i privilegi.',
    modal_key_label: 'CHIAVE OPERATORE CRITTOGRAFICA:',
    modal_dismiss: 'ANNULLA',
    modal_authorize: '🔓 AUTORIZZA OPERATORE'
  },
  en: {
    sys_utc: 'SYS_UTC:',
    crt_fx: 'CRT FX:',
    control_room_btn: 'CONTROL ROOM',
    master_arbitration: 'MASTER ARBITRATION:',
    sec1_name: '4D CLUSTER TOPOLOGY & REAL-TIME ARBITRATION PIPELINE',
    sec1_status: 'PIPELINE ACTIVE // FIFO MULTI-USER MUTEX ENGAGED',
    tess_title: '4D TESSERACT HYPER-PROJECTION',
    tess_sub: 'INTERACTIVE SPATIAL ROTATION · DRAG TO ORIENT',
    wf_title: 'AUTONOMOUS MULTI-USER PIPELINE WORKFLOW',
    wf_sync: 'REALTIME ZERO-COLLISION',
    wf_step1: '01. CLIENT APPS',
    wf_step2: '02. YED1Z GATEWAY',
    wf_step3: '03. TRI-NODE CLUSTER',
    wf_step4: '04. SPECULATIVE ENGINE',
    osc_title: 'CRT PHOSPHOR OSCILLOSCOPE',
    osc_mode: 'CH1: TOK/S · CH2: BUS JITTER',
    osc_decode: 'DECODE VELOCITY',
    osc_prefill: 'PREFILL BURST',
    osc_acc: 'SPECULATIVE ACC',
    sec2_name: 'TRI-NODE CLUSTER HARDWARE TELEMETRY & CHASSIS INSPECTOR',
    sec2_status: '3 NODES SYNCHRONIZED // DUAL STRIX HALO APU + AIREWARD CUDA ACCELERATOR',
    pod_node01_role: '[ COORDINATOR · RANK 0 ]',
    pod_node02_role: '[ WORKER · RANK 1 ]',
    pod_air_role: '[ CUDA ACCEL · RTX 3090 24GB ]',
    insp_title: 'CHASSIS & SILICON INSPECTION PORT',
    btn_view_cluster: 'DUAL CHASSIS VIEW',
    btn_view_die: 'SILICON DIE BLUEPRINT',
    hs_node01: 'NODE 01 (PRIMARY)',
    hs_usb4: '40Gbps USB4 INTERCONNECT',
    hs_node02: 'NODE 02 (WORKER)',
    matrix_badge: 'CONTROL PLANE',
    matrix_title: 'ENGINE ARBITRATION MATRIX',
    guest_text: 'READ-ONLY GUEST',
    admin_text: 'ADMIN OPERATOR',
    btn_unlock: '🔓 UNLOCK',
    btn_lock: '🔒 LOCK',
    strix_group: 'DUAL STRIX HALO CLUSTER (256GB LPDDR5X)',
    air_group: 'AIREWARD-LLM ACCELERATOR (RTX 3090 + 64GB DDR5)',
    active_engines: 'ACTIVE ENGINES:',
    sec3_name: 'HISTORICAL PRODUCTION ANALYTICS & INFERENCE STREAM LOGS',
    aggregated_tokens: 'AGGREGATED TOKENS:',
    chart_title: 'DAILY TOKEN PRODUCTION BY MODEL',
    stream_title: 'REAL-TIME INFERENCE LOG STREAM',
    stream_meta: '[ ZERO CLIENT IP EXPOSURE · AUTOMATIC ARBITRATION ]',
    th_req_id: 'REQ ID',
    th_time: 'TIMESTAMP',
    th_client: 'CLIENT / USER',
    th_app: 'APPLICATION',
    th_model: 'MODEL SERVED',
    th_prompt: 'PROMPT',
    th_gen: 'GEN',
    th_duration: 'DURATION',
    th_velocity: 'VELOCITY',
    th_status: 'STATUS',
    modal_title: 'SYSTEM OVERRIDE // ADMIN AUTHENTICATION',
    modal_notice_strong: 'RESTRICTED ARBITRATION CONTROL PLANE',
    modal_notice_body: 'Live model switching and cluster control require cryptographic operator authorization. Enter your Bearer key (<code class="mono-code">sk-yed...</code>) to unlock execution privileges.',
    modal_key_label: 'CRYPTOGRAPHIC OPERATOR KEY:',
    modal_dismiss: 'DISMISS',
    modal_authorize: '🔓 AUTHORIZE OPERATOR'
  }
};

function applyLanguage(lang) {
  currentLang = lang;
  localStorage.setItem('yed1z_lang', lang);
  document.documentElement.setAttribute('lang', lang);

  const langLabel = document.getElementById('lang-label');
  if (langLabel) {
    langLabel.textContent = lang === 'it' ? 'IT / EN' : 'EN / IT';
  }

  const dict = I18N[lang] || I18N.it;
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (dict[key]) {
      el.innerHTML = dict[key];
    }
  });

  // Dynamic status updates
  const badgeText = document.getElementById('badge-auth-text');
  const btnAuthLabel = document.getElementById('btn-auth-label');
  if (badgeText) {
    badgeText.textContent = isAdminUnlocked() ? dict.admin_text : dict.guest_text;
  }
  if (btnAuthLabel) {
    btnAuthLabel.textContent = isAdminUnlocked() ? dict.btn_lock : dict.btn_unlock;
  }
}

function initLanguage() {
  const langBtn = document.getElementById('lang-toggle-btn');
  if (langBtn) {
    langBtn.addEventListener('click', () => {
      const nextLang = currentLang === 'it' ? 'en' : 'it';
      applyLanguage(nextLang);
    });
  }
  applyLanguage(currentLang);
}

// ============================================================================
// 1. THEME & CRT CONTROLS
// ============================================================================
function readLocalAppearance() {
  const theme = localStorage.getItem('theme');
  themePreference = ['dark', 'light', 'system'].includes(theme) ? theme : 'system';
  const crt = localStorage.getItem('crt');
  motionPreference = crt === 'false' || (crt !== 'true' && localStorage.getItem('yed1z.motion') === 'off') ? 'off' : 'on';
}

function applyAppearance() {
  currentTheme = themePreference === 'system' ? systemDark.matches ? 'dark' : 'light' : themePreference;
  crtActive = motionPreference === 'on' && !reducedMotion.matches;
  document.documentElement.dataset.theme = currentTheme;
  document.documentElement.dataset.motion = crtActive ? 'on' : 'off';
  document.body.classList.toggle('crt-active', crtActive);
  document.getElementById('theme-toggle').value = themePreference;
  const crtBtn = document.getElementById('crt-toggle-btn');
  crtBtn.setAttribute('aria-pressed', String(crtActive));
  crtBtn.disabled = reducedMotion.matches;
  document.getElementById('crt-mode-label').textContent = crtActive ? 'ON' : 'OFF';
  if (lastTelemetry?.stats) renderTokensChart(lastTelemetry.stats.daily_tokens || {});
}

function updateAppearance(change) {
  if (change.theme) {
    themePreference = change.theme;
    localStorage.setItem('theme', change.theme);
  }
  if (change.motion) {
    motionPreference = change.motion;
    localStorage.setItem('crt', String(change.motion === 'on'));
    localStorage.setItem('yed1z.motion', change.motion);
  }
  applyAppearance();
}

function syncAppearance(change) {
  if (change) { appearanceRevision++; updateAppearance(change); }
  const revision = appearanceRevision;
  appearanceQueue = appearanceQueue.then(async () => {
    try {
      const options = change ? { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(change) } : { cache: 'no-store' };
      const response = await fetch('/api/me/appearance', options);
      const saved = response.ok ? await response.json() : undefined;
      if (saved && revision === appearanceRevision) updateAppearance(saved);
    } catch { /* Signed-out and disconnected monitors retain the local appearance. */ }
  });
}

function initThemeAndCrt() {
  document.getElementById('theme-toggle').addEventListener('change', event => syncAppearance({ theme: event.target.value }));
  document.getElementById('crt-toggle-btn').addEventListener('click', () => syncAppearance({ motion: motionPreference === 'on' ? 'off' : 'on' }));
  systemDark.addEventListener('change', applyAppearance);
  reducedMotion.addEventListener('change', applyAppearance);
  window.addEventListener('storage', event => {
    if (event.key === null || ['theme', 'crt', 'yed1z.motion'].includes(event.key)) { readLocalAppearance(); applyAppearance(); }
  });
  readLocalAppearance();
  applyAppearance();
  syncAppearance();
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
    if (crtActive) {
      angleXW += 0.012 * speedMultiplier;
      angleZW += 0.008 * speedMultiplier;
    }

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
const samples = [];
function drawSamples(latest) {
  const canvas = document.getElementById('osc-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (latest && samples.at(-1)?.created !== latest.created) samples.push(latest);
  if (samples.length > 80) samples.shift();
  for (const [field, color] of [['decode_tps','#00ff88'], ['prefill_tps','#00f2fe']]) {
    const max = Math.max(1, ...samples.map(s => s[field] || 0));
    ctx.strokeStyle = ctx.fillStyle = color; ctx.beginPath();
    samples.forEach((sample, i) => {
      if (!Number.isFinite(sample[field])) return;
      const x = 4 + i * (canvas.width-8) / Math.max(1,samples.length-1);
      const y = canvas.height - 3 - sample[field] / max * (canvas.height-8);
      ctx.lineTo(x,y); ctx.fillRect(x-1,y-1,2,2);
    });
    ctx.stroke();
  }
}
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
    if (!res.ok) throw Error('Telemetry unavailable');
    const data = await res.json();
    setText('control-status-pill', 'ONLINE');
    lastTelemetry = data;
    updateHUD(data);
  } catch (err) {
    updateHUD({}); setText('control-status-pill', 'OFFLINE');
  }
}

function updateHUD(data) {
  const fmt = (v, unit = '', factor = 1) => Number.isFinite(v) ? Number((v / factor).toFixed(1)) + unit : '—';
  const latest = data.stats?.latest;
  const engines = data.engines || [];
  setText('active-model-title', engines.filter(e => e.status === 'ready').map(e => e.label).join(' + ') || '—');
  for (const [key, value, unit] of [
    ['wf-inflight-val',data.in_flight,' REQ'],['wf-tps-val',latest?.decode_tps,' tok/s'],['osc-decode-val',latest?.decode_tps,' TPS'],
    ['osc-prefill-val',latest?.prefill_tps,' TPS'],['wf-ttft-val',latest?.ttft_ms,' ms'],['wf-acc-val',null,'%'],['osc-acc-val',null,'%'],
    ['link-rtt-val',null,' ms'],['lan-rtt-val',null,' ms'],['total-tokens-badge',data.stats?.totals?.total_tokens,'']
  ]) setText(key,fmt(value,unit));
  drawSamples(latest);
  for (const [prefix,id] of [['node01','strix01'],['node02','strix02'],['aireward','aireward']]) {
    const n = (data.upstreamTelemetry || []).find(n => n.nodeId === id) || {};
    for (const [suffix,v,unit] of [['temp-val',n.cpuTempC,'°C'],['gpu-temp',n.gpuTempC,'°C'],['gpu-temp-val',n.gpuTempC,'°C'],['cpu-temp-val',n.cpuTempC,'°C'],['power-val',n.gpuPowerW,' W'],['gpu-load',n.gpuPercent,'%'],['fan-val',null,''],['nvme-temp',null,''],['sclk',null,'']])
      setText(prefix+'-'+suffix,fmt(v,unit));
    for (const [key,used,total] of [['ram',n.ramUsedBytes,n.ramTotalBytes],['disk',n.diskUsedBytes,n.diskTotalBytes],['vram',n.gpuMemoryUsedBytes,n.gpuMemoryTotalBytes]]) {
      setText(prefix+'-'+key+'-text',fmt(used,'',2**30)+' / '+fmt(total,' GiB',2**30)); renderLedBar(prefix+'-'+key+'-leds',total ? used*100/total : 0);
    }
    for (const [key,v,max,unit] of [['temp',n.cpuTempC,105,'°C'],['cpu-temp',n.cpuTempC,105,'°C'],['gpu-temp',n.gpuTempC,100,'°C'],['power',n.gpuPowerW,350,'W']]) {
      const dial='dial-'+prefix+'-'+key;
      if(Number.isFinite(v)) drawAnalogDial(dial,v,0,max,unit,max*.82,max*.93);
      else {const canvas=document.getElementById(dial);canvas?.getContext('2d').clearRect(0,0,canvas.width,canvas.height);}
    }
    const alert=document.getElementById(prefix+'-alert-pill');if(alert){alert.textContent=(n.status || 'unknown').toUpperCase();alert.className='alert-pill-retro alert-'+(n.status==='online'?'healthy':'warn');}
  }
  updateMatrixButtons(data);
  setText('cfs-active-summary', engines.map(e=>e.label+' · '+e.status).join(' | ') || '—');
  renderTokensChart(data.stats?.daily_tokens || {});
  renderSessionsTable(data.stats?.recent_sessions || []);
}

function updateMatrixButtons(data) {
  const strixDs = document.getElementById('btn-switch-strix-ds41');
  const strixQw = document.getElementById('btn-switch-strix-qwen');
  const airQw = document.getElementById('btn-switch-air-qwen');
  const airDs = document.getElementById('btn-switch-air-ds41');

  if (strixDs) strixDs.classList.toggle('active', data.active_strix === 'deepseek');
  if (strixQw) strixQw.classList.toggle('active', data.active_strix === 'qwen');
  if (airQw) airQw.classList.toggle('active', data.active_aireward === 'qwen38-strata');
  if (airDs) airDs.classList.toggle('active', data.active_aireward === 'ds41-strata');

  const summary = document.getElementById('cfs-active-summary');
  if (summary) {
    const s1 = data.active_strix ? data.active_strix.toUpperCase() : 'STANDBY';
    const s2 = data.active_aireward ? data.active_aireward.toUpperCase() : 'STANDBY';
    summary.textContent = `STRIX: ${s1} | AIREWARD: ${s2}`;
  }
}

// ============================================================================
// ADMIN AUTHENTICATION & ACCESS CONTROL
// ============================================================================
const ADMIN_STORAGE_KEY = 'yed1z_admin_token';
let currentAdminToken = sessionStorage.getItem(ADMIN_STORAGE_KEY) || null;
let pendingSwitchAction = null;

function isAdminUnlocked() {
  return Boolean(currentAdminToken && currentAdminToken.trim().length > 0);
}

function setAdminUnlocked(unlocked, token = null) {
  currentAdminToken = unlocked && token ? token.trim() : null;
  if (unlocked && currentAdminToken) {
    sessionStorage.setItem(ADMIN_STORAGE_KEY, currentAdminToken);
    syncAppearance();
  } else {
    sessionStorage.removeItem(ADMIN_STORAGE_KEY);
  }

  // Update Auth Badge Pill
  const badgePill = document.getElementById('admin-badge-pill');
  const badgeIcon = document.getElementById('badge-lock-icon');
  const badgeText = document.getElementById('badge-auth-text');
  const btnAuthLabel = document.getElementById('btn-auth-label');

  if (badgePill) {
    badgePill.className = `admin-badge-pill ${unlocked ? 'admin' : 'guest'}`;
  }
  if (badgeIcon) {
    badgeIcon.textContent = unlocked ? '🔓' : '🔒';
  }
  const dict = I18N[currentLang] || I18N.it;
  if (badgeText) {
    badgeText.textContent = unlocked ? dict.admin_text : dict.guest_text;
  }
  if (btnAuthLabel) {
    btnAuthLabel.textContent = unlocked ? dict.btn_lock : dict.btn_unlock;
  }

  // Update Switch buttons lock state and tags
  const btnIds = [
    { id: 'btn-switch-strix-ds41', tag: 'lock-tag-strix-ds41' },
    { id: 'btn-switch-strix-qwen', tag: 'lock-tag-strix-qwen' },
    { id: 'btn-switch-air-qwen', tag: 'lock-tag-air-qwen' },
    { id: 'btn-switch-air-ds41', tag: 'lock-tag-air-ds41' }
  ];

  btnIds.forEach(({ id, tag }) => {
    const btn = document.getElementById(id);
    const tagEl = document.getElementById(tag);
    if (btn) {
      if (unlocked) {
        btn.classList.remove('is-locked');
      } else {
        btn.classList.add('is-locked');
      }
    }
    if (tagEl) {
      tagEl.textContent = unlocked ? '⚡' : '🔒';
    }
  });
}

async function verifySavedAdminToken() {
  const token = sessionStorage.getItem(ADMIN_STORAGE_KEY);
  if (!token) {
    setAdminUnlocked(false);
    return;
  }
  try {
    const res = await fetch('/api/auth/verify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ admin_key: token })
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      setAdminUnlocked(true, token);
    } else {
      setAdminUnlocked(false);
    }
  } catch (e) {
    setAdminUnlocked(false);
  }
}

function handleAuthToggleClick() {
  if (isAdminUnlocked()) {
    lockAdminSession();
  } else {
    openAdminModal();
  }
}

function lockAdminSession() {
  setAdminUnlocked(false);
  const pill = document.getElementById('control-status-pill');
  if (pill) {
    pill.className = 'alert-pill-retro alert-healthy';
    pill.textContent = 'GUEST (LOCKED)';
  }
  const summary = document.getElementById('cfs-active-summary');
  if (summary) {
    summary.textContent = 'OPERATOR LOCK ENGAGED · READ-ONLY MODE ACTIVE';
  }
}

function openAdminModal(pendingAction = null) {
  pendingSwitchAction = pendingAction;
  const overlay = document.getElementById('admin-modal-overlay');
  const input = document.getElementById('admin-key-input');
  const msg = document.getElementById('admin-modal-msg');

  if (msg) {
    msg.style.display = 'none';
    msg.textContent = '';
    msg.className = 'modal-status-msg';
  }
  if (input) {
    input.value = '';
  }
  if (overlay) {
    overlay.style.display = 'flex';
  }
  if (input) {
    setTimeout(() => input.focus(), 60);
  }
}

function closeAdminModal() {
  const overlay = document.getElementById('admin-modal-overlay');
  if (overlay) {
    overlay.style.display = 'none';
  }
  pendingSwitchAction = null;
}

function toggleKeyVisibility() {
  const input = document.getElementById('admin-key-input');
  const eyeBtn = document.getElementById('btn-toggle-key-eye');
  if (input) {
    if (input.type === 'password') {
      input.type = 'text';
      if (eyeBtn) eyeBtn.textContent = '🔒';
    } else {
      input.type = 'password';
      if (eyeBtn) eyeBtn.textContent = '👁️';
    }
  }
}

async function submitAdminAuth() {
  const input = document.getElementById('admin-key-input');
  const msg = document.getElementById('admin-modal-msg');
  const submitBtn = document.getElementById('btn-submit-auth');
  if (!input) return;

  const keyVal = input.value.trim();
  if (!keyVal) {
    if (msg) {
      msg.style.display = 'block';
      msg.className = 'modal-status-msg error';
      msg.textContent = '⚠️ Inserisci la chiave amministratore.';
    }
    input.focus();
    return;
  }

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="btn-bracket">[</span> VERIFYING... <span class="btn-bracket">]</span>';
  }

  try {
    const res = await fetch('/api/auth/verify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${keyVal}`
      },
      body: JSON.stringify({ admin_key: keyVal })
    });

    const data = await res.json();
    if (res.ok && data.ok) {
      if (msg) {
        msg.style.display = 'block';
        msg.className = 'modal-status-msg success';
        msg.textContent = '✅ ACCESSO AUTORIZZATO. PRIVILEGI AMMINISTRATORE ATTIVATI.';
      }
      setAdminUnlocked(true, keyVal);
      const actionToExecute = pendingSwitchAction;
      pendingSwitchAction = null;

      setTimeout(() => {
        closeAdminModal();
        if (actionToExecute) {
          switchModel(actionToExecute.target, actionToExecute.model);
        }
      }, 500);
    } else {
      if (msg) {
        msg.style.display = 'block';
        msg.className = 'modal-status-msg error';
        msg.textContent = '❌ CHIAVE AMMINISTRATORE NON VALIDA.';
      }
      input.focus();
      input.select();
    }
  } catch (err) {
    if (msg) {
      msg.style.display = 'block';
      msg.className = 'modal-status-msg error';
      msg.textContent = '❌ ERRORE DI COMUNICAZIONE COL GATEWAY.';
    }
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<span class="btn-bracket">[</span> 🔓 AUTHORIZE OPERATOR <span class="btn-bracket">]</span>';
    }
  }
}

async function switchModel(target, model) {
  if (!isAdminUnlocked()) {
    openAdminModal({ target, model });
    return;
  }

  const pill = document.getElementById('control-status-pill');
  const summary = document.getElementById('cfs-active-summary');
  if (pill) {
    pill.className = 'alert-pill-retro alert-warn';
    pill.textContent = 'SWITCHING...';
  }
  if (summary) {
    summary.textContent = `SWITCHING ${target.toUpperCase()} -> ${model.toUpperCase()}...`;
  }

  const btnId = target === 'strix' 
    ? (model === 'deepseek' ? 'btn-switch-strix-ds41' : 'btn-switch-strix-qwen')
    : (model === 'deepseek' ? 'btn-switch-air-ds41' : 'btn-switch-air-qwen');
  const btn = document.getElementById(btnId);
  if (btn) btn.classList.add('loading');

  try {
    const res = await fetch('/api/switch', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${currentAdminToken}`
      },
      body: JSON.stringify({ target, model, admin_key: currentAdminToken })
    });

    if (res.status === 401) {
      setAdminUnlocked(false);
      openAdminModal({ target, model });
      if (pill) {
        pill.className = 'alert-pill-retro alert-crit';
        pill.textContent = 'AUTH REQ';
      }
      return;
    }

    const data = await res.json();
    if (data.ok) {
      if (pill) {
        pill.className = 'alert-pill-retro alert-healthy';
        pill.textContent = 'SWITCH OK';
      }
    } else {
      if (pill) {
        pill.className = 'alert-pill-retro alert-crit';
        pill.textContent = 'SWITCH ERR';
      }
    }
  } catch (err) {
    console.error('Switch error:', err);
    if (pill) {
      pill.className = 'alert-pill-retro alert-crit';
      pill.textContent = 'COMM ERR';
    }
  } finally {
    if (btn) btn.classList.remove('loading');
    setTimeout(fetchTelemetry, 1500);
  }
}

function renderSessionsTable(sessions) {
  const tbody = document.getElementById('sessions-tbody');
  if (!tbody) return;

  if (!sessions || sessions.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" class="text-center py-4" style="color:var(--text-muted)">No active sessions logged. Ready for GitHub Copilot Chat queries!</td></tr>`;
    return;
  }

  tbody.replaceChildren(...sessions.slice(0,15).map(s => {
    const row=document.createElement('tr');
    for (const value of [s.time,s.user,s.app,s.model,s.prompt,s.gen,s.duration,s.velocity,s.status]) {
      const cell=document.createElement('td');cell.textContent=value ?? '—';row.append(cell);
    }
    return row;
  }));
}

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
// RC1 shared project links originally used the home page; keep those bookmarks working.
function openLinkedProject() {
  const { pathname, hash } = window.location;
  if ((pathname === '/' || pathname === '/index.html') && new URLSearchParams(hash.slice(1)).get('project')) {
    window.location.replace('/control' + hash);
    return true;
  }
  return false;
}

window.addEventListener('hashchange', openLinkedProject);
document.addEventListener('DOMContentLoaded', () => {
  if (openLinkedProject()) return;
  initThemeAndCrt();
  initLanguage();
  initInspectorSwitcher();
  init4DTesseract();
  drawSamples(null);
  verifySavedAdminToken();

  // Escape key closes admin modal
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeAdminModal();
    }
  });

  // Initial fetch and 2-second telemetry loop
  fetchTelemetry();
  setInterval(fetchTelemetry, 2000);

  window.addEventListener('resize', () => {
    if (lastTelemetry && lastTelemetry.stats) {
      renderTokensChart(lastTelemetry.stats.daily_tokens || {});
    }
  });
});
