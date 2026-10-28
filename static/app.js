/**
 * yed1z Local Inference Cluster - Retro Technical Dashboard
 * Telemetry Polling, Anonymized Sessions (No IPs), Retro Canvas Charts,
 * Read-Only Autonomous Multi-User Arbitration State.
 */

// Global State
let currentTheme = localStorage.getItem('yed1z-theme') || 'dark';
let chartDataCache = null;

// DOM Elements
const docHtml = document.documentElement;
const themeToggleBtn = document.getElementById('theme-toggle');
const themeIcon = themeToggleBtn ? themeToggleBtn.querySelector('.theme-icon') : null;

// Initialize Theme
function initTheme() {
  docHtml.setAttribute('data-theme', currentTheme);
  if (themeIcon) {
    themeIcon.textContent = currentTheme.toUpperCase();
  }
}

// Toggle Theme Handler
if (themeToggleBtn) {
  themeToggleBtn.addEventListener('click', () => {
    currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
    docHtml.setAttribute('data-theme', currentTheme);
    localStorage.setItem('yed1z-theme', currentTheme);
    if (themeIcon) {
      themeIcon.textContent = currentTheme.toUpperCase();
    }
    if (chartDataCache) {
      renderTokensChart(chartDataCache);
    }
  });
}

// Helper: Format Numbers with separators
function formatNumber(num) {
  if (num === null || num === undefined) return '0';
  return Number(num).toLocaleString('it-IT');
}

// Helper: Copy to Clipboard
window.copyToClipboard = function(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      showToast('[ COPIED TO CLIPBOARD ]');
    }).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
};

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
  showToast('[ COPIED TO CLIPBOARD ]');
}

function showToast(msg) {
  let toast = document.getElementById('yed1z-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'yed1z-toast';
    toast.style.position = 'fixed';
    toast.style.bottom = '20px';
    toast.style.right = '20px';
    toast.style.background = 'var(--bg-card)';
    toast.style.color = 'var(--accent-cyan)';
    toast.style.border = '1px solid var(--accent-cyan)';
    toast.style.padding = '8px 16px';
    toast.style.zIndex = '9999';
    toast.style.fontSize = '0.75rem';
    toast.style.fontFamily = 'var(--font-mono)';
    toast.style.boxShadow = 'var(--card-shadow)';
    toast.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = '1';
  toast.style.transform = 'translateY(0)';
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(8px)';
  }, 2200);
}

// Update Telemetry Elements
function updateUI(data) {
  const active = data.active_model; // "deepseek" | "qwen" | null
  const inFlight = data.in_flight || 0;
  const busyModel = data.busy_model;
  const telem = data.telemetry || {};
  const stats = data.stats || {};
  const speeds = data.speeds || {};

  // 1. Header Model Badge
  const headerLabel = document.getElementById('header-model-label');
  const headerBadge = document.getElementById('header-active-model');

  if (headerLabel && headerBadge) {
    if (active === 'deepseek') {
      headerLabel.textContent = 'DEEPSEEK V4.1 FLASH // KIREI HIP (50 TOK/S)';
      headerBadge.className = 'model-badge ds-active';
    } else if (active === 'qwen') {
      headerLabel.textContent = 'QWEN 3.8 FLASH NEXT // GUFO (196K)';
      headerBadge.className = 'model-badge qwen-active';
    } else {
      headerLabel.textContent = 'STANDBY // READY TO LOAD';
      headerBadge.className = 'model-badge standby';
    }
  }

  // 2. HUD Cluster State
  const hudState = document.getElementById('hud-cluster-state');
  if (hudState) {
    if (inFlight > 0) {
      hudState.textContent = `GENERATING // ${busyModel || 'ACTIVE STREAM'}`;
      hudState.style.color = 'var(--accent-amber)';
    } else if (active) {
      hudState.textContent = `ONLINE // ${active.toUpperCase()} READY FOR COPILOT`;
      hudState.style.color = 'var(--accent-emerald)';
    } else {
      hudState.textContent = 'STANDBY // WAITING FOR INFERENCE REQUEST';
      hudState.style.color = 'var(--accent-cyan)';
    }
  }

  // 3. Card 1: Resident Model
  const cardModName = document.getElementById('card-model-name');
  const cardModMeter = document.getElementById('card-model-meter');
  const cardModRam = document.getElementById('card-model-ram');
  const cardModStatus = document.getElementById('card-model-status');

  if (cardModName) {
    if (active === 'deepseek') {
      cardModName.innerHTML = `<span style="color:var(--accent-cyan)">DeepSeek V4.1 Flash</span>`;
      if (cardModMeter) {
        cardModMeter.style.width = '72%';
        cardModMeter.style.background = 'var(--accent-cyan)';
      }
      if (cardModRam) cardModRam.textContent = '88.0 GiB occupati / 122.2 GiB (Dual TP2)';
    } else if (active === 'qwen') {
      cardModName.innerHTML = `<span style="color:var(--accent-purple)">Qwen 3.8 Flash Next</span>`;
      if (cardModMeter) {
        cardModMeter.style.width = '78%';
        cardModMeter.style.background = 'var(--accent-purple)';
      }
      if (cardModRam) cardModRam.textContent = '95.4 GiB occupati / 122.2 GiB (Gufo Engine)';
    } else {
      cardModName.textContent = 'Standby (Pronto)';
      if (cardModMeter) cardModMeter.style.width = '0%';
      if (cardModRam) cardModRam.textContent = '0 GiB occupati';
    }
    if (cardModStatus) {
      cardModStatus.textContent = active ? 'RESIDENT' : 'STANDBY';
      cardModStatus.className = active ? 'badge badge-success' : 'badge badge-warning';
    }
  }

  // 4. Card 2: Generation Speed
  const speedDecode = document.getElementById('speed-decode');
  const speedPrefill = document.getElementById('speed-prefill');
  const speedTtft = document.getElementById('speed-ttft');
  const speedDspark = document.getElementById('speed-dspark');

  if (speedDecode && speeds.decode_tps !== undefined) {
    speedDecode.textContent = speeds.decode_tps.toFixed(1);
  }
  if (speedPrefill && speeds.prefill_tps !== undefined) {
    speedPrefill.textContent = `~${Math.round(speeds.prefill_tps)} tok/s`;
  }
  if (speedTtft && speeds.ttft_ms !== undefined) {
    speedTtft.textContent = `~${speeds.ttft_ms} ms`;
  }
  if (speedDspark && speeds.dspark_acc !== undefined) {
    speedDspark.textContent = `${speeds.dspark_acc}%`;
  }

  // 5. Card 4: Concurrency & Arbitration
  const cardInFlight = document.getElementById('card-in-flight');
  const cardQueueStatus = document.getElementById('card-queue-status');

  if (cardInFlight) {
    cardInFlight.innerHTML = `${inFlight} <small>in-flight</small>`;
  }
  if (cardQueueStatus) {
    if (inFlight > 0) {
      cardQueueStatus.textContent = `In generazione (${busyModel || 'client'})`;
      cardQueueStatus.style.color = 'var(--accent-amber)';
    } else {
      cardQueueStatus.textContent = 'Idle (FIFO Drain Guard)';
      cardQueueStatus.style.color = 'var(--accent-emerald)';
    }
  }

  // 6. Hardware Topology
  const n1 = telem.node01 || {};
  const n2 = telem.node02 || {};
  const tblink = telem.tb_link || {};

  const node01Ram = document.getElementById('node01-ram');
  const node01RamFill = document.getElementById('node01-ram-fill');
  const node02Ram = document.getElementById('node02-ram');
  const node02RamFill = document.getElementById('node02-ram-fill');
  const linkRtt = document.getElementById('link-rtt');
  const linkSpeed = document.getElementById('link-speed');

  if (node01Ram && n1.ram_used_gb) {
    const tot1 = n1.ram_total_gb || 122.2;
    node01Ram.textContent = `${n1.ram_used_gb} / ${tot1} GiB`;
    if (node01RamFill) {
      const pct = Math.min(100, Math.round((n1.ram_used_gb / tot1) * 100));
      node01RamFill.style.width = `${pct}%`;
    }
  }

  if (node02Ram && n2.ram_used_gb) {
    const tot2 = n2.ram_total_gb || 122.2;
    node02Ram.textContent = `${n2.ram_used_gb} / ${tot2} GiB`;
    if (node02RamFill) {
      const pct2 = Math.min(100, Math.round((n2.ram_used_gb / tot2) * 100));
      node02RamFill.style.width = `${pct2}%`;
    }
  }

  if (linkRtt && tblink.rtt_ms !== undefined) {
    linkRtt.textContent = `${tblink.rtt_ms} ms`;
    linkRtt.style.color = tblink.rtt_ms < 1.0 ? 'var(--accent-emerald)' : 'var(--accent-amber)';
  }
  if (linkSpeed && tblink.status) {
    linkSpeed.textContent = tblink.status === 'active' ? '40 Gbps Mesh · 10.55.0.0/30' : 'Degradato / Fallback IP';
  }

  // 7. Cumulative Totals
  const totals = stats.totals || {};
  const sumTokens = document.getElementById('sum-total-tokens');
  const sumRequests = document.getElementById('sum-total-requests');
  const sumDs = document.getElementById('sum-ds-tokens');
  const sumQwen = document.getElementById('sum-qwen-tokens');

  if (sumTokens) sumTokens.textContent = formatNumber(totals.total_tokens || 0);
  if (sumRequests) sumRequests.textContent = formatNumber(totals.total_requests || 0);
  if (sumDs) sumDs.textContent = formatNumber(totals.deepseek_tokens || 0);
  if (sumQwen) sumQwen.textContent = formatNumber(totals.qwen_tokens || 0);

  // 8. Sessions Table (Anonymized - NO client IPs or locations)
  renderSessionsTable(stats.recent_sessions || []);

  // 9. Chart Rendering (Retro flat bars)
  chartDataCache = stats.daily_tokens || {};
  renderTokensChart(chartDataCache);

  // 10. Server Time
  const serverTimeEl = document.getElementById('footer-server-time');
  if (serverTimeEl && data.server_time) {
    serverTimeEl.textContent = `[ GATEWAY TIME: ${data.server_time} CET · TLS CLOUDFLARE ]`;
  }
}

// Render Sessions Table (Zero IPs, Zero Geolocation)
function renderSessionsTable(sessions) {
  const tbody = document.getElementById('sessions-table-body');
  if (!tbody) return;

  if (!sessions || sessions.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" class="text-center py-4" style="color:var(--text-muted)">Nessuna sessione registrata. Invia una query da GitHub Copilot!</td></tr>`;
    return;
  }

  let html = '';
  for (const s of sessions) {
    const isDs = s.model && (s.model.includes('ds41') || s.model.includes('deepseek'));
    const badgeMod = isDs
      ? `<span class="badge badge-ds">DeepSeek V4.1</span>`
      : `<span class="badge badge-qwen">Qwen 3.8</span>`;

    const userLabel = s.user || (s.client === '127.0.0.1' ? 'funboy (local)' : 'cooper');
    const appLabel = s.client_app || 'Copilot Chat';
    const tpsVal = s.tok_per_sec ? `${s.tok_per_sec} tok/s` : '—';

    html += `
      <tr>
        <td><code>${escapeHtml(s.id || '')}</code></td>
        <td>${escapeHtml(s.time || '')}</td>
        <td><span class="user-tag">${escapeHtml(userLabel)}</span></td>
        <td><span class="app-tag">${escapeHtml(appLabel)}</span></td>
        <td>${badgeMod}</td>
        <td>${formatNumber(s.prompt_tokens || 0)}</td>
        <td><strong>${formatNumber(s.completion_tokens || 0)}</strong></td>
        <td>${s.duration_s ? s.duration_s + 's' : '—'}</td>
        <td><span class="speed-pill">${tpsVal}</span></td>
        <td><span class="status-badge ${s.status === 'completed' ? 'success' : 'pending'}">${escapeHtml(s.status || 'done').toUpperCase()}</span></td>
      </tr>
    `;
  }
  tbody.innerHTML = html;
}

// Render Retro Canvas Daily Chart
function renderTokensChart(daily) {
  const canvas = document.getElementById('tokens-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;

  // Adapt canvas size
  const rect = canvas.getBoundingClientRect();
  const width = rect.width || 560;
  const height = 240;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.scale(dpr, dpr);

  ctx.clearRect(0, 0, width, height);

  const dates = Object.keys(daily).sort();
  if (dates.length === 0) {
    ctx.fillStyle = currentTheme === 'dark' ? '#64748b' : '#94a3b8';
    ctx.font = '12px JetBrains Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Nessun dato storico giornaliero', width / 2, height / 2);
    return;
  }

  let maxTokens = 1000;
  for (const d of dates) {
    const sum = (daily[d].deepseek || 0) + (daily[d].qwen || 0);
    if (sum > maxTokens) maxTokens = sum;
  }
  maxTokens = Math.ceil(maxTokens * 1.15);

  const paddingLeft = 55;
  const paddingRight = 20;
  const paddingTop = 25;
  const paddingBottom = 40;
  const chartW = width - paddingLeft - paddingRight;
  const chartH = height - paddingTop - paddingBottom;

  const isDark = currentTheme === 'dark';
  const gridColor = isDark ? 'rgba(0, 242, 254, 0.08)' : 'rgba(2, 132, 199, 0.12)';
  const textColor = isDark ? '#94a3b8' : '#64748b';

  // Draw Horizontal Grid
  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 1;
  ctx.fillStyle = textColor;
  ctx.font = '10px JetBrains Mono, monospace';
  ctx.textAlign = 'right';

  const gridSteps = 4;
  for (let i = 0; i <= gridSteps; i++) {
    const y = paddingTop + chartH - (i / gridSteps) * chartH;
    const val = Math.round((i / gridSteps) * maxTokens);
    ctx.beginPath();
    ctx.moveTo(paddingLeft, y);
    ctx.lineTo(width - paddingRight, y);
    ctx.stroke();
    ctx.fillText(formatNumber(val), paddingLeft - 8, y + 4);
  }

  // Draw Retro Flat Sharp Bars (No Rounded Corners)
  const numDays = dates.length;
  const slotW = chartW / numDays;
  const barW = Math.min(38, Math.max(14, slotW * 0.55));

  for (let i = 0; i < numDays; i++) {
    const dateStr = dates[i];
    const dsTok = daily[dateStr].deepseek || 0;
    const qwenTok = daily[dateStr].qwen || 0;

    const x = Math.round(paddingLeft + i * slotW + (slotW - barW) / 2);

    const dsH = Math.round((dsTok / maxTokens) * chartH);
    const qwenH = Math.round((qwenTok / maxTokens) * chartH);

    const yBase = paddingTop + chartH;

    // Draw DeepSeek Bar (Bottom - Sharp Cyan)
    if (dsH > 0) {
      ctx.fillStyle = isDark ? '#00f2fe' : '#0284c7';
      ctx.fillRect(x, yBase - dsH, barW, dsH);
      // Subtle top highlight line
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x, yBase - dsH, barW, 1);
    }

    // Draw Qwen Bar (Top - Sharp Purple)
    if (qwenH > 0) {
      ctx.fillStyle = isDark ? '#c084fc' : '#9333ea';
      ctx.fillRect(x, yBase - dsH - qwenH, barW, qwenH);
      // Subtle top highlight line
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x, yBase - dsH - qwenH, barW, 1);
    }

    // X axis date label
    ctx.fillStyle = textColor;
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.textAlign = 'center';
    const shortDate = dateStr.slice(5); // MM-DD
    ctx.fillText(shortDate, x + barW / 2, height - paddingBottom + 18);
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Fetch Telemetry Poll
async function fetchTelemetry() {
  try {
    const res = await fetch('/api/telemetry', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    updateUI(data);
  } catch (err) {
    // Silent
  }
}

// Startup
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  fetchTelemetry();
  setInterval(fetchTelemetry, 2500);
});
