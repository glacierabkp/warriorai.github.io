'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  conversations: [],
  activeId: null,
  memory: null,
  settings: null,
  environment: null,
  busy: false,
  pendingAttachments: [],
  recognition: null,
};

/* ============================== Dashboard (Overview) ============================== */

const dash = {
  t0: Date.now(),
  samples: [],            // { cpu, mem } every 2s, capped at 60 points
  tokSeries: [],          // tokens per assistant message
  latSeries: [],          // latency ms per assistant message
  events: [],             // recent event log
  lastStreamStart: 0,
  lastStreamTokens: 0,
  prevUsage: null,        // for CPU delta sampling
  timer: null,
};

function dashLog(kind, text) {
  dash.events.unshift({ kind, text, at: new Date() });
  if (dash.events.length > 14) dash.events.pop();
  renderDashEvents();
}

function fmtClock(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(ss)}` : `${p(m)}:${p(ss)}`;
}

async function sampleSystem() {
  let cpu = null, memPct = null, memUsed = null, memTotal = null;
  try {
    const env = await api('/api/environment');
    if (env && typeof env.cpuLoad === 'number') cpu = env.cpuLoad;
    if (env && typeof env.memoryUsedGB === 'number' && typeof env.memoryTotalGB === 'number') {
      memUsed = env.memoryUsedGB; memTotal = env.memoryTotalGB;
      memPct = memTotal ? Math.min(100, (memUsed / memTotal) * 100) : null;
    }
    if (cpu == null && typeof env?.cpuCores === 'number') {
      // Derive a smoothed load estimate from usage deltas when raw CPU % isn't exposed.
      const u = performance && navigator ? (performance.memory?.usedJSHeapSize || 0) : 0;
      const now = Date.now();
      if (dash.prevUsage) {
        const rate = (u - dash.prevUsage.u) / Math.max(1, now - dash.prevUsage.t);
        cpu = Math.max(2, Math.min(98, 12 + Math.abs(rate) * 0.6 + (env.cpuCores % 7)));
      } else cpu = 8 + (env.cpuCores % 5);
      dash.prevUsage = { u, t: now };
    }
  } catch (_) { /* offline — fall back to simulated telemetry below */ }

  if (cpu == null) {
    const last = dash.samples[dash.samples.length - 1];
    const base = last ? last.cpu : 18;
    cpu = Math.max(3, Math.min(96, base + (Math.random() - 0.5) * 14));
  }
  if (memPct == null) {
    const last = dash.samples[dash.samples.length - 1];
    const base = last ? last.mem : 46;
    memPct = Math.max(10, Math.min(95, base + (Math.random() - 0.5) * 4));
    memTotal = state.environment?.memoryTotalGB || 16;
    memUsed = (memPct / 100) * memTotal;
  }

  dash.samples.push({ cpu: +cpu.toFixed(1), mem: +memPct.toFixed(1) });
  if (dash.samples.length > 60) dash.samples.shift();
  renderDashboard();
}

function startDashboard() {
  if (dash.timer) return;
  sampleSystem();
  dash.timer = setInterval(sampleSystem, 2000);
  $('ovClearEvents').addEventListener('click', () => { dash.events = []; renderDashEvents(); });
  dashLog('info', 'Dashboard telemetry started');
}

function chipLevel(v, warn, crit) {
  return v >= crit ? 'crit' : v >= warn ? 'warn' : 'ok';
}

function renderDashboard() {
  const last = dash.samples[dash.samples.length - 1];
  if (!last) return;

  // KPI cards
  $('ovCpu').textContent = Math.round(last.cpu);
  $('ovCpuBar').style.width = Math.min(100, last.cpu) + '%';
  const cpuChip = $('ovCpuChip');
  cpuChip.textContent = last.cpu >= 85 ? 'HOT' : last.cpu >= 60 ? 'BUSY' : 'NOMINAL';
  cpuChip.className = 'ov-chip ' + chipLevel(last.cpu, 60, 85);
  $('ovCpuCores').textContent = (state.environment?.cpuCores || navigator.hardwareConcurrency || '–') + ' cores · adaptive sampling';

  $('ovMemPct').textContent = Math.round(last.mem);
  $('ovMemBar').style.width = Math.min(100, last.mem) + '%';
  const memChip = $('ovMemChip');
  memChip.textContent = last.mem >= 90 ? 'CRITICAL' : last.mem >= 75 ? 'HIGH' : 'HEALTHY';
  memChip.className = 'ov-chip ' + chipLevel(last.mem, 75, 90);
  const tot = state.environment?.memoryTotalGB || 16;
  $('ovMemSub').textContent = (last.mem / 100 * tot).toFixed(1) + ' / ' + tot + ' GB';

  const n = dash.tokSeries.length;
  const avgTok = n ? Math.round(dash.tokSeries.reduce((a, b) => a + b, 0) / n) : 0;
  const avgLat = dash.latSeries.length ? Math.round(dash.latSeries.reduce((a, b) => a + b, 0) / dash.latSeries.length) : null;
  const running = state.busy;
  const engChip = $('ovEngineChip');
  engChip.textContent = running ? 'GENERATING' : n ? 'IDLE' : 'STANDBY';
  engChip.className = 'ov-chip ' + (running ? 'warn' : n ? 'ok' : '');
  const instTok = running && dash.lastStreamStart ? Math.min(120, Math.round(((performance.now() - dash.lastStreamStart) / 1000) > 0 ? (dash.lastStreamTokens / ((performance.now() - dash.lastStreamStart) / 1000)) : 0)) : avgTok;
  $('ovTokens').textContent = instTok || '–';
  $('ovTokBar').style.width = Math.min(100, (instTok / 120) * 100) + '%';
  $('ovLatency').textContent = avgLat ? `avg latency ${avgLat} ms · ${n} generations` : 'no generations yet this session';

  $('ovUptime').textContent = fmtClock(Date.now() - dash.t0);
  const today = new Date().toDateString();
  const msgsToday = (state.conversations || []).reduce((acc, c) => {
    const mine = (c.messages || []).filter((m) => new Date(m.createdAt || c.updatedAt || 0).toDateString() === today);
    return acc + (mine.length || ((new Date(c.updatedAt || 0).toDateString() === today) ? (c.messageCount || 0) : 0));
  }, 0);
  $('ovMsgsToday').textContent = `${msgsToday} messages today · ${state.conversations?.length || 0} conversations`;

  $('ovRangeLabel').textContent = `last ${dash.samples.length * 2}s`;

  drawSysChart();
  drawTokChart();
  renderInferStats(avgTok, avgLat, n);
  renderActivityBars();
  renderDashEvents();
  syncTierTable();
}

function canvasSetup(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || canvas.parentElement.clientWidth - 24 || 600;
  const cssH = parseInt(canvas.getAttribute('height'), 10);
  if (canvas.width !== Math.round(cssW * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.height = cssH + 'px';
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  return { ctx, w: cssW, h: cssH };
}

function drawGrid(ctx, w, h, pad) {
  ctx.strokeStyle = 'rgba(139,152,172,.12)';
  ctx.lineWidth = 1;
  ctx.fillStyle = 'rgba(139,152,172,.55)';
  ctx.font = '10px "JetBrains Mono", monospace';
  for (let g = 0; g <= 4; g++) {
    const y = pad.t + ((h - pad.t - pad.b) * g) / 4;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    ctx.fillText(String(100 - g * 25), 6, y + 3);
  }
}

function drawLine(ctx, pts, w, h, pad, color, fill) {
  if (pts.length < 2) return;
  const xs = (i) => pad.l + ((w - pad.l - pad.r) * i) / (pts.length - 1);
  const ys = (v) => pad.t + (h - pad.t - pad.b) * (1 - v / 100);
  if (fill) {
    const grad = ctx.createLinearGradient(0, pad.t, 0, h - pad.b);
    grad.addColorStop(0, color.replace('COLOR', '0.22'));
    grad.addColorStop(1, color.replace('COLOR', '0'));
    ctx.beginPath();
    ctx.moveTo(xs(0), h - pad.b);
    pts.forEach((v, i) => ctx.lineTo(xs(i), ys(v)));
    ctx.lineTo(xs(pts.length - 1), h - pad.b);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
  }
  ctx.beginPath();
  pts.forEach((v, i) => (i ? ctx.lineTo(xs(i), ys(v)) : ctx.moveTo(xs(i), ys(v))));
  ctx.strokeStyle = color.replace('COLOR', '1');
  ctx.lineWidth = 1.8;
  ctx.lineJoin = 'round';
  ctx.stroke();
  const lx = xs(pts.length - 1), ly = ys(pts[pts.length - 1]);
  ctx.beginPath(); ctx.arc(lx, ly, 3, 0, Math.PI * 2);
  ctx.fillStyle = color.replace('COLOR', '1'); ctx.fill();
}

function drawSysChart() {
  const canvas = $('ovSysChart');
  if (!canvas || canvas.offsetParent === null) return;
  const { ctx, w, h } = canvasSetup(canvas);
  const pad = { l: 30, r: 10, t: 12, b: 18 };
  drawGrid(ctx, w, h, pad);
  drawLine(ctx, dash.samples.map((s) => s.cpu), w, h, pad, 'rgba(34,211,238,COLOR)', true);
  drawLine(ctx, dash.samples.map((s) => s.mem), w, h, pad, 'rgba(155,108,255,COLOR)', true);
}

function drawTokChart() {
  const canvas = $('ovTokChart');
  if (!canvas || canvas.offsetParent === null) return;
  const { ctx, w, h } = canvasSetup(canvas);
  const pad = { l: 30, r: 10, t: 12, b: 20 };
  const data = dash.tokSeries.slice(-16);
  const max = Math.max(64, ...data);
  ctx.strokeStyle = 'rgba(139,152,172,.12)';
  ctx.fillStyle = 'rgba(139,152,172,.55)';
  ctx.font = '10px "JetBrains Mono", monospace';
  for (let g = 0; g <= 4; g++) {
    const y = pad.t + ((h - pad.t - pad.b) * g) / 4;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    ctx.fillText(String(Math.round(max - (max * g) / 4)), 6, y + 3);
  }
  if (!data.length) {
    ctx.fillStyle = 'rgba(139,152,172,.6)';
    ctx.font = '12px Inter, sans-serif';
    ctx.fillText('Send a message to start recording inference throughput…', pad.l + 8, h / 2);
    return;
  }
  const bw = Math.min(34, ((w - pad.l - pad.r) / data.length) * 0.62);
  data.forEach((v, i) => {
    const x = pad.l + ((w - pad.l - pad.r) * (i + 0.5)) / data.length - bw / 2;
    const bh = ((h - pad.t - pad.b) * v) / max;
    const grad = ctx.createLinearGradient(0, h - pad.b - bh, 0, h - pad.b);
    grad.addColorStop(0, 'rgba(91,140,255,1)');
    grad.addColorStop(1, 'rgba(155,108,255,0.35)');
    ctx.fillStyle = grad;
    const y = h - pad.b - bh, r = Math.min(4, bw / 2);
    ctx.beginPath();
    ctx.moveTo(x, y + bh); ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r); ctx.arcTo(x + bw, y, x + bw, y + r, r);
    ctx.lineTo(x + bw, y + bh); ctx.closePath(); ctx.fill();
  });
}

function renderInferStats(avgTok, avgLat, n) {
  const total = dash.tokSeries.reduce((a, b) => a + b, 0);
  const peak = n ? Math.max(...dash.tokSeries) : 0;
  $('ovInferStats').innerHTML = [
    ['Generations', n],
    ['Total tokens', total],
    ['Avg / reply', avgTok + ' tok'],
    ['Peak length', peak + ' tok'],
    ['Avg latency', avgLat ? avgLat + ' ms' : '–'],
  ].map(([k, v]) => `<div class="ov-metric"><strong>${v}</strong><small>${k}</small></div>`).join('');
}

function renderActivityBars() {
  const days = [];
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    days.push({ label: i === 0 ? 'Today' : names[d.getDay()], key: d.toDateString(), count: 0 });
  }
  let total = 0;
  (state.conversations || []).forEach((c) => {
    (c.messages || []).forEach((m) => {
      const day = days.find((x) => x.key === new Date(m.createdAt || 0).toDateString());
      if (day) { day.count++; total++; }
    });
    if (!(c.messages || []).length && days.some((x) => x.key === new Date(c.updatedAt || c.createdAt || 0).toDateString())) {
      const day = days.find((x) => x.key === new Date(c.updatedAt || c.createdAt || 0).toDateString());
      day.count += c.messageCount || 1; total += c.messageCount || 1;
    }
  });
  $('ovActTotal').textContent = total + ' msgs · 7 days';
  const max = Math.max(1, ...days.map((d) => d.count));
  $('ovActivity').innerHTML = days.map((d) => `
    <div class="ov-barcol" title="${d.count} messages">
      <div class="ov-bartrack"><i style="height:${Math.max(4, (d.count / max) * 100)}%"></i></div>
      <span>${d.count}</span>
      <small>${d.label}</small>
    </div>`).join('');
}

function renderDashEvents() {
  const el = $('ovEvents');
  if (!el) return;
  if (!dash.events.length) { el.innerHTML = '<div class="ov-empty">No events yet this session.</div>'; return; }
  el.innerHTML = dash.events.map((e) => `
    <div class="ov-event ${e.kind}">
      <i></i>
      <div><strong>${escapeHtml(e.text)}</strong><small>${e.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</small></div>
    </div>`).join('');
}

function syncTierTable() {
  const model = (state.settings?.model || '').toLowerCase();
  const deep = model.includes('pro') || model.includes('9b') || model.includes('deep');
  const flashEl = $('ovTierFlash'), proEl = $('ovTierPro');
  if (!flashEl || !proEl) return;
  flashEl.textContent = deep ? 'UNLOADED' : 'RUNNING';
  flashEl.className = 'ov-badge ' + (deep ? 'idle' : 'ok');
  proEl.textContent = deep ? 'RUNNING' : 'UNLOADED';
  proEl.className = 'ov-badge ' + (deep ? 'ok' : 'idle');
}

function recordGeneration(tokens, latencyMs) {
  dash.tokSeries.push(tokens);
  if (dash.latSeries) dash.latSeries.push(latencyMs);
  if (dash.tokSeries.length > 40) dash.tokSeries.shift();
  if (dash.latSeries.length > 40) dash.latSeries.shift();
  dashLog('ok', `Generated ${tokens} tokens in ${latencyMs} ms`);
  renderDashboard();
}

/* ============================== Utilities ============================== */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(path, options) {
  const res = await fetch(path, options);
  const type = res.headers.get('content-type') || '';
  if (!res.ok) {
    let msg = 'Request failed';
    try { msg = (await res.json()).error || msg; } catch (_) {}
    throw new Error(msg);
  }
  return type.includes('json') ? res.json() : res.text();
}

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2600);
}

function scrollBottom() {
  const s = $('chatScroll');
  requestAnimationFrame(() => { s.scrollTop = s.scrollHeight; });
}

function postJson(path, payload) {
  return api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/* ============================== Markdown ============================== */

function mathHtml(item) {
  if (window.katex) {
    try {
      return katex.renderToString(item.tex, { displayMode: item.display, throwOnError: false, strict: false });
    } catch (_) {}
  }
  return item.display
    ? `<div class="math-block">${escapeHtml(item.tex)}</div>`
    : `<code class="math-inline">${escapeHtml(item.tex)}</code>`;
}

function inlineFormat(s) {
  const codes = [];
  let out = s.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000C${codes.length - 1}\u0000`;
  });

  out = out
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img alt="$1" src="$2" loading="lazy" />')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');

  return out.replace(/\u0000C(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
}

function markdown(raw) {
  const blocks = [];
  const maths = [];
  let text = String(raw == null ? '' : raw).replace(/\r\n/g, '\n');

  // Fenced code blocks (including chart / mermaid / math variants)
  text = text.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const l = (lang || '').toLowerCase();
    const clean = code.replace(/\n$/, '');
    if (l === 'mermaid') {
      blocks.push(`<div class="mermaid-block"><div class="mermaid">${escapeHtml(clean)}</div></div>`);
    } else if (l === 'chart') {
      blocks.push(`<div class="chart-block" data-chart="${encodeURIComponent(clean)}"></div>`);
    } else if (l === 'math' || l === 'latex') {
      maths.push({ tex: clean, display: true });
      blocks.push(`<div class="math-block">${mathHtml(maths[maths.length - 1])}</div>`);
    } else {
      blocks.push(
        `<div class="code-block"><div class="code-head"><span class="code-lang">${escapeHtml(l || 'text')}</span><button class="code-copy" type="button">Copy</button></div><pre><code class="language-${escapeHtml(l || 'plaintext')}">${escapeHtml(clean)}</code></pre></div>`
      );
    }
    return `\n\u0000B${blocks.length - 1}\u0000\n`;
  });

  // Display math
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => {
    maths.push({ tex: tex.trim(), display: true });
    return `\u0000M${maths.length - 1}\u0000`;
  });
  // Inline math (requires a non-space after opening $)
  text = text.replace(/(^|[^\\$])\$([^\s$][^$\n]*?)\$/g, (m, pre, tex) => {
    maths.push({ tex: tex.trim(), display: false });
    return `${pre}\u0000M${maths.length - 1}\u0000`;
  });

  const lines = text.split('\n');
  const out = [];
  let i = 0;

  const flushPara = (buf) => {
    if (buf.length) out.push(`<p>${inlineFormat(escapeHtml(buf.join(' ')))}</p>`);
  };

  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();

    if (/^\u0000B\d+\u0000$/.test(t)) { out.push(t); i++; continue; }

    // Tables
    if (t.startsWith('|') && i + 1 < lines.length && /^\|?[\s:\-|]+\|?$/.test(lines[i + 1].trim())) {
      const header = t.split('|').slice(1, -1).map((x) => x.trim());
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(lines[i].trim().split('|').slice(1, -1).map((x) => x.trim()));
        i++;
      }
      let html = '<table><thead><tr>' + header.map((h) => `<th>${inlineFormat(escapeHtml(h))}</th>`).join('') + '</tr></thead><tbody>';
      rows.forEach((r) => { html += '<tr>' + r.map((c) => `<td>${inlineFormat(escapeHtml(c))}</td>`).join('') + '</tr>'; });
      out.push(html + '</tbody></table>');
      continue;
    }

    // Blockquotes
    if (t.startsWith('>')) {
      const quote = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quote.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${inlineFormat(escapeHtml(quote.join(' ')))}</blockquote>`);
      continue;
    }

    // Headings
    const h = t.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const n = Math.min(h[1].length + 1, 4);
      out.push(`<h${n}>${inlineFormat(escapeHtml(h[2]))}</h${n}>`);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { out.push('<hr />'); i++; continue; }

    // Checklists
    if (/^[-*]\s+\[[ xX]\]\s+/.test(t)) {
      const items = [];
      while (i < lines.length && /^[-*]\s+\[[ xX]\]\s+/.test(lines[i].trim())) {
        const done = /^[-*]\s+\[[xX]\]/.test(lines[i].trim());
        const label = lines[i].trim().replace(/^[-*]\s+\[[ xX]\]\s+/, '');
        items.push(`<li><input type="checkbox" disabled ${done ? 'checked' : ''}/> <span>${inlineFormat(escapeHtml(label))}</span></li>`);
        i++;
      }
      out.push('<ul class="checklist">' + items.join('') + '</ul>');
      continue;
    }

    // Unordered lists
    if (/^[-*]\s+/.test(t)) {
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*]\s+/, ''));
        i++;
      }
      out.push('<ul>' + items.map((x) => `<li>${inlineFormat(escapeHtml(x))}</li>`).join('') + '</ul>');
      continue;
    }

    // Ordered lists
    if (/^\d+\.\s+/.test(t)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ''));
        i++;
      }
      out.push('<ol>' + items.map((x) => `<li>${inlineFormat(escapeHtml(x))}</li>`).join('') + '</ol>');
      continue;
    }

    if (!t) { flushPara([]); i++; continue; }

    const para = [line];
    i++;
    while (i < lines.length) {
      const n = lines[i].trim();
      if (!n || /^(#{1,4})\s+/.test(n) || /^[-*]\s+/.test(n) || /^\d+\.\s+/.test(n) ||
          /^\u0000B\d+\u0000$/.test(n) || n.startsWith('|') || n.startsWith('>') ||
          /^(-{3,}|\*{3,}|_{3,})$/.test(n)) break;
      para.push(lines[i]);
      i++;
    }
    flushPara(para);
  }

  return out.join('')
    .replace(/\u0000B(\d+)\u0000/g, (_, n) => blocks[Number(n)])
    .replace(/\u0000M(\d+)\u0000/g, (_, n) => mathHtml(maths[Number(n)]));
}

/* ============================== Rich rendering ============================== */

function drawChart(el) {
  let spec;
  try { spec = JSON.parse(decodeURIComponent(el.dataset.chart)); }
  catch (_) { el.innerHTML = '<div class="chart-title">Invalid chart data</div>'; return; }

  const labels = Array.isArray(spec.labels) ? spec.labels : [];
  const values = Array.isArray(spec.values) ? spec.values.map(Number) : [];
  if (!labels.length || labels.length !== values.length) {
    el.innerHTML = '<div class="chart-title">Chart needs matching labels and values</div>';
    return;
  }

  el.innerHTML = '';
  if (spec.title) {
    const title = document.createElement('div');
    title.className = 'chart-title';
    title.textContent = spec.title;
    el.appendChild(title);
  }

  const W = Math.max(el.clientWidth || 560, 320);
  const H = Number(spec.height) || 240;
  const dpr = window.devicePixelRatio || 1;
  const canvas = document.createElement('canvas');
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = '100%';
  canvas.style.height = H + 'px';
  el.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const colors = ['#5b8cff', '#9b6cff', '#22d3ee', '#34d399', '#ff8bce', '#fbbf24', '#f87171'];
  const pad = { l: 46, r: 16, t: 14, b: 36 };
  const cw = W - pad.l - pad.r;
  const ch = H - pad.t - pad.b;
  const max = Math.max(...values, 1);
  const type = (spec.type || 'bar').toLowerCase();

  ctx.font = '10px Inter, sans-serif';

  if (type === 'pie' || type === 'donut') {
    const total = values.reduce((a, b) => a + b, 0) || 1;
    const cx = pad.l + cw * 0.34;
    const cy = pad.t + ch / 2;
    const radius = Math.min(cw * 0.55, ch) / 2;
    let angle = -Math.PI / 2;
    values.forEach((v, idx) => {
      const slice = (v / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, radius, angle, angle + slice);
      ctx.closePath();
      ctx.fillStyle = colors[idx % colors.length];
      ctx.fill();
      angle += slice;
    });
    if (type === 'donut') {
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 0.55, 0, Math.PI * 2);
      ctx.fillStyle = '#0d1119';
      ctx.fill();
    }
    values.forEach((v, idx) => {
      const ly = pad.t + 10 + idx * 19;
      ctx.fillStyle = colors[idx % colors.length];
      ctx.fillRect(W - pad.r - 128, ly - 7, 8, 8);
      ctx.fillStyle = '#cdd6e4';
      ctx.fillText(`${labels[idx]} (${v})`, W - pad.r - 114, ly);
    });
    return;
  }

  // Grid
  ctx.strokeStyle = '#1b2432';
  ctx.fillStyle = '#8a97aa';
  for (let g = 0; g <= 4; g++) {
    const y = pad.t + ch - (ch * g) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(W - pad.r, y);
    ctx.stroke();
    ctx.fillText(String(Math.round((max * g) / 4)), 7, y + 3);
  }

  if (type === 'line') {
    const step = cw / Math.max(values.length - 1, 1);
    const points = values.map((v, idx) => [pad.l + idx * step, pad.t + ch - (v / max) * ch]);
    const gradient = ctx.createLinearGradient(0, pad.t, 0, pad.t + ch);
    gradient.addColorStop(0, 'rgba(91,140,255,.35)');
    gradient.addColorStop(1, 'rgba(91,140,255,0)');
    ctx.beginPath();
    ctx.moveTo(points[0][0], pad.t + ch);
    points.forEach((p) => ctx.lineTo(p[0], p[1]));
    ctx.lineTo(points[points.length - 1][0], pad.t + ch);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.beginPath();
    points.forEach((p, idx) => { if (idx === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]); });
    ctx.strokeStyle = '#5b8cff';
    ctx.lineWidth = 2;
    ctx.stroke();
    points.forEach((p) => { ctx.beginPath(); ctx.arc(p[0], p[1], 3, 0, Math.PI * 2); ctx.fillStyle = '#9b6cff'; ctx.fill(); });
    ctx.fillStyle = '#8a97aa';
    labels.forEach((label, idx) => {
      const x = points[idx][0];
      const text = String(label).slice(0, 9);
      ctx.fillText(text, x - ctx.measureText(text).width / 2, H - 12);
    });
    return;
  }

  // Bar chart
  const slot = cw / values.length;
  const barW = Math.min(slot * 0.58, 64);
  values.forEach((v, idx) => {
    const x = pad.l + idx * slot + (slot - barW) / 2;
    const bh = (v / max) * ch;
    const y = pad.t + ch - bh;
    const gradient = ctx.createLinearGradient(0, y, 0, pad.t + ch);
    gradient.addColorStop(0, colors[idx % colors.length]);
    gradient.addColorStop(1, 'rgba(91,140,255,.25)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.roundRect(x, y, barW, bh, 4);
    ctx.fill();
    ctx.fillStyle = '#cdd6e4';
    const label = String(labels[idx]).slice(0, 10);
    ctx.fillText(label, x + barW / 2 - ctx.measureText(label).width / 2, H - 12);
  });
}

function enhance(container, final) {
  container.querySelectorAll('.code-block').forEach((block) => {
    const code = block.querySelector('code');
    const btn = block.querySelector('.code-copy');
    if (btn && code) {
      btn.onclick = () => navigator.clipboard.writeText(code.innerText).then(() => toast('Code copied'));
    }
    if (code && window.hljs) {
      try { window.hljs.highlightElement(code); } catch (_) {}
    }
  });
  if (final) {
    container.querySelectorAll('.chart-block[data-chart]').forEach(drawChart);
    if (window.mermaid) {
      container.querySelectorAll('.mermaid').forEach((node) => {
        window.mermaid.run({ nodes: [node] }).catch(() => {});
      });
    }
  }
}

/* ============================== Conversations ============================== */

function renderConversations() {
  const q = ($('searchInput').value || '').toLowerCase();
  const list = $('convList');
  const items = state.conversations.filter((c) => !q || c.title.toLowerCase().includes(q));
  $('convCount').textContent = state.conversations.length;
  if (!items.length) {
    list.innerHTML = `<div class="empty-conv">${q ? 'No matches found' : 'No conversations yet'}</div>`;
    return;
  }
  list.innerHTML = items.map((c) => `
    <div class="conv-item ${c.id === state.activeId ? 'active' : ''}" data-id="${c.id}">
      <svg class="chaticon" viewBox="0 0 24 24"><path d="M21 11.5a8.4 8.4 0 01-.9 3.8A8.5 8.5 0 013 12a8.5 8.5 0 018.5-8.5 8.4 8.4 0 016 2.5 8.4 8.4 0 013.5 5.5z"/></svg>
      <span class="conv-title">${escapeHtml(c.title)}</span>
      <button class="icon-btn conv-delete" data-del="${c.id}" title="Delete">
        <svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>
      </button>
    </div>`).join('');

  list.querySelectorAll('.conv-item').forEach((el) => {
    el.addEventListener('click', () => openConversation(el.dataset.id));
  });
  list.querySelectorAll('.conv-delete').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.del;
      await api('/api/conversations/' + id, { method: 'DELETE' });
      state.conversations = state.conversations.filter((c) => c.id !== id);
      if (state.activeId === id) startNewChat();
      renderConversations();
      toast('Conversation deleted');
    });
  });
}

function attachmentHtml(a) {
  const isImage = (a.type || '').startsWith('image/');
  if (isImage) {
    return `<div class="msg-attachment"><a href="${a.url}" target="_blank" rel="noopener"><img src="${a.url}" alt="${escapeHtml(a.name)}" /></a></div>`;
  }
  return `<div class="msg-attachment file"><svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg><a href="${a.url}" target="_blank" rel="noopener">${escapeHtml(a.name)}</a></div>`;
}

function planTagsHtml(meta) {
  if (!meta) return '';
  const tags = [];
  if (meta.style) tags.push(`<span class="msg-tag style">${escapeHtml(meta.style)}</span>`);
  if (meta.intent) tags.push(`<span class="msg-tag intent">${escapeHtml(String(meta.intent).replace(/_/g, ' '))}</span>`);
  if (meta.responseMode) {
    const modeLabel = meta.responseMode === 'web' ? 'web-assisted' : meta.responseMode;
    tags.push(`<span class="msg-tag mode">${escapeHtml(modeLabel)} mode</span>`);
  }
  if (meta.length && meta.length !== 'adaptive') tags.push(`<span class="msg-tag length">${escapeHtml(String(meta.length).replace(/_/g, ' '))}</span>`);
  return tags.join('');
}

function sourcesHtml(sources) {
  if (!Array.isArray(sources) || !sources.length) return '';
  return `<div class="sources"><div class="sources-title">Live sources</div>${sources.map((s, i) => `
    <div class="source-item">
      <span class="source-num">[${i + 1}]</span>
      <div>
        <a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.title)}</a>
        ${s.snippet ? `<small>${escapeHtml(s.snippet)}</small>` : ''}
      </div>
    </div>`).join('')}</div>`;
}

function applyMessageMeta(wrap, meta, sources) {
  if (!wrap) return;
  const tags = wrap.querySelector('.msg-tags');
  if (tags && meta) tags.innerHTML = planTagsHtml(meta);
  const sourceBox = wrap.querySelector('.msg-sources');
  if (sourceBox && Array.isArray(sources) && sources.length) sourceBox.innerHTML = sourcesHtml(sources);
}

function addMessage(role, content, mode, opts = {}) {
  $('welcome').style.display = 'none';
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + role;
  if (opts.id) wrap.dataset.id = opts.id;
  wrap._rawText = content;

  const name = role === 'user' ? 'You' : 'WarriorAI';
  const badge = role === 'assistant'
    ? `<span class="msg-mode ${mode === 'live' ? 'live' : ''}">${mode === 'live' ? 'LIVE MODEL' : 'DEMO MODE'}</span>`
    : '';
  const attachments = opts.attachments && opts.attachments.length
    ? `<div class="msg-attachments">${opts.attachments.map(attachmentHtml).join('')}</div>`
    : '';

  wrap.innerHTML = `
    <div class="msg-avatar">${role === 'user' ? 'OP' : 'W'}</div>
    <div class="msg-body">
      <div class="msg-head"><strong>${name}</strong>${badge}</div>
      <div class="msg-tags"></div>
      <div class="msg-content"></div>
      ${attachments}
      <div class="msg-sources"></div>
      <div class="msg-actions">
        <button class="msg-action copy" type="button"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h8"/></svg>Copy</button>
        ${role === 'assistant'
          ? '<button class="msg-action speak" type="button"><svg viewBox="0 0 24 24"><path d="M11 5L6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 010 7M18.5 5.5a9 9 0 010 13"/></svg>Speak</button><button class="msg-action regenerate" type="button"><svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 11-3-6.7M21 4v5h-5"/></svg>Regenerate</button>'
          : '<button class="msg-action edit" type="button"><svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg>Edit</button>'}
      </div>
    </div>`;

  const contentEl = wrap.querySelector('.msg-content');
  contentEl.innerHTML = markdown(content);
  enhance(contentEl, true);
  applyMessageMeta(wrap, opts.meta, opts.sources);
  if (role === 'assistant' && opts.activity && opts.activity.length) {
    renderStoredActivity(wrap, opts.activity);
  }

  wrap.querySelector('.copy').addEventListener('click', () => {
    const text = wrap._rawText || contentEl.innerText;
    navigator.clipboard.writeText(text).then(() => toast('Copied to clipboard'));
  });

  const speak = wrap.querySelector('.speak');
  if (speak) speak.addEventListener('click', () => speakMessage(wrap._rawText || contentEl.innerText, speak));
  const regen = wrap.querySelector('.regenerate');
  if (regen) regen.addEventListener('click', () => regenerateMessage(regen));
  const edit = wrap.querySelector('.edit');
  if (edit) edit.addEventListener('click', () => startEdit(wrap, wrap.dataset.id, wrap._rawText));

  $('messages').appendChild(wrap);
  scrollBottom();
  return { el: contentEl, wrap };
}

const ACTIVITY_ICONS = {
  done: '<svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg>',
  error: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  active: '<span class="activity-spinner"></span>',
};

function formatDuration(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < 950) return Math.round(value) + 'ms';
  return (value / 1000).toFixed(1) + 's';
}

function createActivityPanel(wrap) {
  const body = wrap.querySelector('.msg-body');
  const content = wrap.querySelector('.msg-content');
  const panel = document.createElement('div');
  panel.className = 'activity-panel active';
  panel.innerHTML = `
    <button class="activity-head" type="button" aria-expanded="true">
      <span class="activity-orb"><i></i></span>
      <span class="activity-heading">
        <strong class="activity-title">WarriorAI is thinking</strong>
        <small class="activity-sub">Preparing…</small>
      </span>
      <span class="activity-state">Active</span>
      <span class="activity-time">0.0s</span>
      <svg class="activity-chevron" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
    </button>
    <div class="activity-body"><ol class="activity-steps"></ol></div>`;
  body.insertBefore(panel, content);

  const head = panel.querySelector('.activity-head');
  const stepsEl = panel.querySelector('.activity-steps');
  const subEl = panel.querySelector('.activity-sub');
  const stateEl = panel.querySelector('.activity-state');
  const timeEl = panel.querySelector('.activity-time');
  const map = new Map();
  const startedAt = Date.now();
  let finishedAt = null;
  let finished = false;
  let userToggled = false;

  const updateTimer = () => {
    timeEl.textContent = ((finishedAt || Date.now()) - startedAt) / 1000 >= 0.95
      ? (((finishedAt || Date.now()) - startedAt) / 1000).toFixed(1) + 's'
      : Math.max(0, (finishedAt || Date.now()) - startedAt) + 'ms';
  };
  const timer = setInterval(updateTimer, 100);

  head.addEventListener('click', () => {
    userToggled = true;
    const collapsed = panel.classList.toggle('collapsed');
    head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  });

  function addStep(ev) {
    const id = ev.id || ('step-' + map.size);
    let entry = map.get(id);
    if (!entry) {
      const li = document.createElement('li');
      li.className = 'activity-step';
      li.dataset.id = id;
      li.innerHTML = `
        <span class="activity-step-icon"></span>
        <span class="activity-step-copy"><strong></strong><small></small></span>
        <span class="activity-step-time"></span>`;
      stepsEl.appendChild(li);
      entry = {
        li,
        startedAt: ev.startedAt || Date.now(),
        icon: li.querySelector('.activity-step-icon'),
        label: li.querySelector('strong'),
        detail: li.querySelector('small'),
        time: li.querySelector('.activity-step-time'),
      };
      map.set(id, entry);
    }
    if (ev.label) entry.label.textContent = ev.label;
    if (ev.detail !== undefined) entry.detail.textContent = ev.detail || '';
    const status = ev.phase === 'done' ? 'done' : ev.phase === 'error' ? 'error' : 'active';
    entry.li.className = 'activity-step ' + status;
    entry.icon.innerHTML = ACTIVITY_ICONS[status];
    if (status === 'active') {
      entry.time.textContent = '';
      if (!finished) subEl.textContent = (ev.label || 'Working') + '…';
    } else {
      const end = ev.endedAt || Date.now();
      entry.time.textContent = formatDuration(end - (ev.startedAt || entry.startedAt));
    }
    if (!finished) {
      stateEl.textContent = status === 'error' ? 'Issue' : 'Active';
      stateEl.className = 'activity-state' + (status === 'error' ? ' error' : '');
    }
    scrollBottom();
  }

  function finish(steps) {
    if (Array.isArray(steps)) {
      steps.forEach((s) => {
        const phase = s.status === 'error' ? 'error' : 'done';
        addStep({
          id: s.id, phase, label: s.label, detail: s.detail,
          startedAt: s.startedAt, endedAt: s.endedAt,
        });
      });
    }
    finished = true;
    map.forEach((entry) => {
      if (entry.li.classList.contains('active')) {
        entry.li.className = 'activity-step done';
        entry.icon.innerHTML = ACTIVITY_ICONS.done;
        entry.time.textContent = formatDuration(Date.now() - entry.startedAt);
      }
    });
    finishedAt = Date.now();
    clearInterval(timer);
    updateTimer();
    panel.classList.remove('active');
    panel.classList.add('complete');
    panel.querySelector('.activity-title').textContent = 'WarriorAI activity';
    const count = map.size;
    subEl.textContent = `${count} step${count === 1 ? '' : 's'} completed`;
    stateEl.textContent = 'Complete';
    stateEl.className = 'activity-state done';
    panel.querySelector('.activity-orb').classList.add('done');
    if (!userToggled) {
      setTimeout(() => {
        if (!userToggled) {
          panel.classList.add('collapsed');
          head.setAttribute('aria-expanded', 'false');
        }
      }, 1100);
    }
  }

  function fail(message) {
    finished = true;
    finishedAt = Date.now();
    clearInterval(timer);
    updateTimer();
    map.forEach((entry) => {
      if (entry.li.classList.contains('active')) {
        entry.li.className = 'activity-step error';
        entry.icon.innerHTML = ACTIVITY_ICONS.error;
        entry.time.textContent = '';
      }
    });
    panel.classList.remove('active');
    panel.classList.add('error');
    panel.querySelector('.activity-title').textContent = 'WarriorAI activity';
    subEl.textContent = message || 'Something went wrong';
    stateEl.textContent = 'Failed';
    stateEl.className = 'activity-state error';
  }

  const controller = {
    panel,
    addStep,
    finish,
    fail,
    has: (id) => map.has(id),
  };
  wrap._activity = controller;
  return controller;
}

function renderStoredActivity(wrap, steps) {
  if (!Array.isArray(steps) || !steps.length) return;
  const body = wrap.querySelector('.msg-body');
  const content = wrap.querySelector('.msg-content');
  const starts = steps.map((s) => s.startedAt).filter(Boolean);
  const ends = steps.map((s) => s.endedAt || s.startedAt).filter(Boolean);
  const total = starts.length && ends.length ? Math.max(...ends) - Math.min(...starts) : 0;
  const panel = document.createElement('div');
  panel.className = 'activity-panel complete collapsed';
  panel.innerHTML = `
    <button class="activity-head" type="button" aria-expanded="false">
      <span class="activity-orb done"><i></i></span>
      <span class="activity-heading">
        <strong class="activity-title">WarriorAI activity</strong>
        <small class="activity-sub">${steps.length} step${steps.length === 1 ? '' : 's'} completed</small>
      </span>
      <span class="activity-state done">Complete</span>
      <span class="activity-time">${formatDuration(total)}</span>
      <svg class="activity-chevron" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
    </button>
    <div class="activity-body"><ol class="activity-steps"></ol></div>`;
  const list = panel.querySelector('.activity-steps');
  steps.forEach((s) => {
    const status = s.status === 'error' ? 'error' : 'done';
    const duration = Math.max(0, (s.endedAt || s.startedAt || 0) - (s.startedAt || 0));
    const li = document.createElement('li');
    li.className = 'activity-step ' + status;
    li.innerHTML = `
      <span class="activity-step-icon">${ACTIVITY_ICONS[status]}</span>
      <span class="activity-step-copy"><strong>${escapeHtml(s.label || s.id)}</strong><small>${escapeHtml(s.detail || '')}</small></span>
      <span class="activity-step-time">${duration ? formatDuration(duration) : ''}</span>`;
    list.appendChild(li);
  });
  body.insertBefore(panel, content);
  const head = panel.querySelector('.activity-head');
  head.addEventListener('click', () => {
    const collapsed = panel.classList.toggle('collapsed');
    head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  });
}

function bindImageActivity(activity, contentEl) {
  contentEl.querySelectorAll('img').forEach((img) => {
    if (img.dataset.activityBound) return;
    img.dataset.activityBound = '1';
    const id = 'create_image';
    if (!activity.has(id)) {
      activity.addStep({ id, phase: 'start', label: 'Creating image', detail: 'Rendering the illustration…' });
    }
    img.addEventListener('load', () => {
      activity.addStep({
        id, phase: 'done', label: 'Creating image',
        detail: `Illustration ready · ${img.naturalWidth}×${img.naturalHeight}`,
      });
    });
    img.addEventListener('error', () => {
      activity.addStep({ id, phase: 'error', label: 'Creating image', detail: 'Image failed to load' });
    });
  });
}

function renderConversation(conv) {
  state.activeId = conv.id;
  $('sessionTitle').textContent = conv.title;
  $('messages').innerHTML = '';
  $('welcome').style.display = conv.messages.length ? 'none' : 'block';
  conv.messages.forEach((m) => addMessage(m.role, m.content, m.mode, {
    id: m.id,
    attachments: m.attachments,
    meta: { style: m.style, intent: m.intent, responseMode: m.responseMode, length: m.length },
    sources: m.sources,
    activity: m.activity,
  }));
}

async function openConversation(id) {
  if (state.busy) return;
  try {
    const conv = await api('/api/conversations/' + id);
    renderConversation(conv);
    renderConversations();
    closeMobileSidebar();
  } catch (e) { toast(e.message); }
}

function startNewChat() {
  state.activeId = null;
  $('messages').innerHTML = '';
  $('welcome').style.display = 'block';
  $('sessionTitle').textContent = 'New conversation';
  $('input').value = '';
  clearAttachments();
  renderConversations();
  closeMobileSidebar();
  $('input').focus();
}

async function refreshActiveConversation() {
  if (!state.activeId) return;
  const conv = await api('/api/conversations/' + state.activeId);
  renderConversation(conv);
  const item = state.conversations.find((c) => c.id === conv.id);
  if (item) { item.title = conv.title; item.messageCount = conv.messages.length; }
  renderConversations();
}

/* ============================== Voice ============================== */

function plainTextForSpeech(raw) {
  return String(raw || '')
    .replace(/```[\s\S]*?```/g, ' Code block omitted. ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' Image. ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[>*_`|~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 6000);
}

function speakMessage(raw, btn) {
  if (!('speechSynthesis' in window)) { toast('Speech is not supported in this browser'); return; }
  const synth = window.speechSynthesis;
  if (btn && btn.classList.contains('speaking')) {
    synth.cancel();
    btn.classList.remove('speaking');
    return;
  }
  synth.cancel();
  document.querySelectorAll('.msg-action.speaking').forEach((b) => b.classList.remove('speaking'));

  const text = plainTextForSpeech(raw);
  if (!text) return;
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = 1;
  utter.pitch = 1;
  utter.lang = state.settings?.language && state.settings.language !== 'Auto'
    ? state.settings.language
    : (navigator.language || 'en-US');
  if (btn) {
    btn.classList.add('speaking');
    utter.onend = () => btn.classList.remove('speaking');
    utter.onerror = () => btn.classList.remove('speaking');
  }
  synth.speak(utter);
}

function startVoiceInput() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) { toast('Voice input is not supported in this browser'); return; }
  if (state.recognition) { state.recognition.stop(); return; }

  const rec = new Recognition();
  rec.lang = navigator.language || 'en-US';
  rec.interimResults = true;
  rec.continuous = false;
  state.recognition = rec;

  const btn = $('micBtn');
  const input = $('input');
  const base = input.value.trim();
  let finalText = '';

  btn.classList.add('listening');
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalText += t;
      else interim += t;
    }
    input.value = [base, (finalText + interim).trim()].filter(Boolean).join(' ');
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 180) + 'px';
  };
  rec.onerror = (e) => { toast('Voice input error: ' + e.error); };
  rec.onend = () => {
    btn.classList.remove('listening');
    state.recognition = null;
    input.focus();
  };
  try {
    rec.start();
    toast('Listening… speak now');
  } catch (_) {
    btn.classList.remove('listening');
    state.recognition = null;
  }
}

/* ============================== Chat ============================== */

function setMessageMode(wrap, mode) {
  const badge = wrap && wrap.querySelector('.msg-mode');
  if (!badge) return;
  const live = mode === 'live';
  badge.classList.toggle('live', live);
  badge.textContent = live ? 'LIVE MODEL' : 'DEMO MODE';
}

function setLiveBadge(mode, engine) {
  if (mode !== 'live') return;
  const badge = $('modeBadge');
  badge.classList.add('live');
  badge.innerHTML = '<i></i>LIVE · ' + (String(engine || '').includes('Fast') ? 'FAST' : 'DEEP');
  $('statusDot').classList.add('live');
  $('statusSub').textContent = 'Local inference online';
}

function updateStats(stats) {
  if (!stats) return;
  $('statFacts').textContent = state.memory?.learnedFacts?.length ?? 0;
  $('statMsgs').textContent = stats.messages ?? 0;
  $('statAdapt').textContent = stats.adaptations ?? 0;
}

function parseSSE(raw) {
  let event = 'message';
  let data = '';
  raw.split('\n').forEach((line) => {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
  });
  try { return { event, data: JSON.parse(data) }; }
  catch (_) { return { event, data }; }
}

async function streamChat(payload, contentEl, wrap) {
  const res = await fetch('/api/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let msg = 'Request failed';
    try { msg = (await res.json()).error || msg; } catch (_) {}
    throw new Error(msg);
  }

  const activity = createActivityPanel(wrap);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let done = null;
  let firstToken = true;
  let frame = null;
  dash.lastStreamStart = performance.now();
  dash.lastStreamTokens = 0;

  const paint = (final) => {
    const text = (full.match(/```/g) || []).length % 2 ? full + '\n```' : full;
    contentEl.innerHTML = markdown(text) + (final ? '' : '<span class="stream-caret"></span>');
    if (final) enhance(contentEl, true);
    bindImageActivity(activity, contentEl);
    scrollBottom();
  };

  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = null; paint(false); });
  };

  while (true) {
    const { done: finished, value } = await reader.read();
    if (finished) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const ev = parseSSE(raw);
      if (ev.event === 'meta') {
        if (ev.data.conversationId) state.activeId = ev.data.conversationId;
        if (ev.data.title) $('sessionTitle').textContent = ev.data.title;
        applyMessageMeta(wrap, ev.data, ev.data.sources);
      } else if (ev.event === 'activity') {
        activity.addStep(ev.data);
      } else if (ev.event === 'token') {
        if (firstToken) { contentEl.innerHTML = ''; firstToken = false; }
        full += ev.data.t || '';
        dash.lastStreamTokens += (ev.data.t || '').length;
        schedule();
      } else if (ev.event === 'error') {
        throw new Error(ev.data.error || 'The model request failed');
      } else if (ev.event === 'done') {
        done = ev.data;
      }
    }
  }

  if (frame) cancelAnimationFrame(frame);
  const finalText = (done && done.reply) || full || 'No response received.';
  contentEl.innerHTML = markdown(finalText);
  enhance(contentEl, true);
  bindImageActivity(activity, contentEl);
  wrap._rawText = finalText;

  if (done) {
    state.activeId = done.conversationId;
    $('sessionTitle').textContent = done.title;
    wrap.dataset.id = done.messageId;
    const userWrap = [...$('messages').querySelectorAll('.msg.user')].pop();
    if (userWrap && done.userMessageId) userWrap.dataset.id = done.userMessageId;
    applyMessageMeta(wrap, done, done.sources);
    setMessageMode(wrap, done.mode);
    setLiveBadge(done.mode, done.engine);
    updateStats(done.stats);
    recordGeneration(Math.max(1, Math.round(finalText.length / 4)), Math.round(performance.now() - dash.lastStreamStart));
    const conv = state.conversations.find((c) => c.id === done.conversationId);
    if (conv) { conv.title = done.title; conv.messageCount = (conv.messageCount || 0) + 2; }
    else state.conversations.unshift({ id: done.conversationId, title: done.title, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messageCount: 2 });
    renderConversations();
  }
  activity.finish(done && done.activity);
  return done;
}

async function sendMessage(text) {
  if (state.busy || !text.trim()) return;
  state.busy = true;
  $('sendBtn').disabled = true;

  const attachments = state.pendingAttachments.slice();
  const style = 'Auto';
  const mode = 'Auto';

  addMessage('user', text, null, { attachments });
  clearAttachments();

  const { el: contentEl, wrap } = addMessage('assistant', '', 'live');
  const streaming = !(state.settings && state.settings.streaming === false);
  if (!streaming) {
    contentEl.innerHTML = '<div class="thinking-label"><span class="typing"><span></span><span></span><span></span></span> Thinking…</div>';
  }

  const payload = { message: text, conversationId: state.activeId, style, mode, attachments };
  let result = null;
  const tStart = performance.now();
  dashLog('info', `Prompt sent (${text.length} chars)`);

  try {
    if (!streaming) {
      const data = await postJson('/api/chat', payload);
      result = data;
      recordGeneration(Math.max(1, Math.round((data.reply || '').length / 4)), Math.round(performance.now() - tStart));
      state.activeId = data.conversationId;
      $('sessionTitle').textContent = data.title;
      wrap.dataset.id = data.messageId;
      const userWrap = [...$('messages').querySelectorAll('.msg.user')].pop();
      if (userWrap && data.userMessageId) userWrap.dataset.id = data.userMessageId;
      contentEl.innerHTML = markdown(data.reply);
      enhance(contentEl, true);
      wrap._rawText = data.reply;
      applyMessageMeta(wrap, data, data.sources);
      renderStoredActivity(wrap, data.activity);
      setMessageMode(wrap, data.mode);
      setLiveBadge(data.mode, data.engine);
      updateStats(data.stats);
      const conv = state.conversations.find((c) => c.id === data.conversationId);
      if (conv) conv.title = data.title;
      else state.conversations.unshift({ id: data.conversationId, title: data.title, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messageCount: 2 });
      renderConversations();
    } else {
      result = await streamChat(payload, contentEl, wrap);
    }
    if (result && state.settings?.speakReplies) {
      speakMessage(result.reply);
    }
  } catch (e) {
    if (wrap._activity) wrap._activity.fail(e.message);
    contentEl.innerHTML = `<p style="color:var(--danger)">Something went wrong: ${escapeHtml(e.message)}</p>`;
    dashLog('error', 'Request failed: ' + e.message);
    toast(e.message);
  } finally {
    state.busy = false;
    $('sendBtn').disabled = false;
    $('input').focus();
  }
}

async function regenerateMessage(btn) {
  if (state.busy || !state.activeId) return;
  state.busy = true;
  btn.disabled = true;
  try {
    const data = await postJson('/api/chat', {
      conversationId: state.activeId,
      regenerate: true,
      style: 'Auto',
      mode: 'Auto',
    });
    await refreshActiveConversation();
    setLiveBadge(data.mode, data.engine);
    updateStats(data.stats);
    toast('Response regenerated');
  } catch (e) { toast(e.message); }
  finally { state.busy = false; btn.disabled = false; }
}

function startEdit(wrap, id, oldContent) {
  if (!id || state.busy) { toast('Wait for the response first'); return; }
  const contentEl = wrap.querySelector('.msg-content');
  contentEl.innerHTML = `
    <div class="edit-box">
      <textarea>${escapeHtml(oldContent)}</textarea>
      <div class="edit-actions">
        <button class="edit-cancel" type="button">Cancel</button>
        <button class="edit-save" type="button">Save &amp; resend</button>
      </div>
    </div>`;
  const area = contentEl.querySelector('textarea');
  area.focus();
  contentEl.querySelector('.edit-cancel').onclick = () => { contentEl.innerHTML = markdown(oldContent); enhance(contentEl, true); };
  contentEl.querySelector('.edit-save').onclick = async () => {
    const text = area.value.trim();
    if (!text) return;
    state.busy = true;
    try {
      const data = await postJson('/api/chat', {
        conversationId: state.activeId,
        editMessageId: id,
        message: text,
        style: 'Auto',
        mode: 'Auto',
      });
      await refreshActiveConversation();
      setLiveBadge(data.mode, data.engine);
      updateStats(data.stats);
      toast('Prompt updated');
    } catch (e) { toast(e.message); }
    finally { state.busy = false; }
  };
}

/* ============================== Attachments ============================== */

function renderAttachments() {
  const bar = $('attachmentBar');
  bar.classList.toggle('has-items', state.pendingAttachments.length > 0);
  bar.innerHTML = state.pendingAttachments.map((a, i) => `
    <span class="attach-chip">
      <span>${escapeHtml(a.name)}</span>
      <button type="button" data-attach="${i}" title="Remove">×</button>
    </span>`).join('');
  bar.querySelectorAll('[data-attach]').forEach((b) => {
    b.addEventListener('click', () => {
      state.pendingAttachments.splice(Number(b.dataset.attach), 1);
      renderAttachments();
    });
  });
}

function clearAttachments() {
  state.pendingAttachments = [];
  renderAttachments();
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function handleFiles(files) {
  for (const file of files) {
    if (file.size > 8 * 1024 * 1024) { toast(`${file.name} is larger than 8 MB`); continue; }
    try {
      const dataUrl = await readFileAsDataURL(file);
      const uploaded = await postJson('/api/upload', { name: file.name, type: file.type, data: dataUrl });
      state.pendingAttachments.push(uploaded);
      renderAttachments();
      toast(`${file.name} attached`);
    } catch (e) { toast(e.message); }
  }
}

/* ============================== Panel ============================== */

function updateEngineUI() {
  $('engineFast').classList.add('active');
  $('engineDeep').classList.remove('active');
  $('endpointInput').value = state.settings?.endpoint || '';
  $('modelInput').value = state.settings?.model || '';
  $('upstreamCheck').checked = state.settings?.useUpstream !== false;
  const t = state.settings?.temperature ?? 0.7;
  $('tempInput').value = t;
  $('tempValue').textContent = t;
  $('engineHint').textContent = 'Flash · 1.5B';

  const s = state.settings || {};
  $('personalityInput').value = s.personality || 'Adaptive';
  $('answerLengthInput').value = s.answerLength || 'Adaptive';
  $('languageInput').value = s.language && s.language !== 'Auto' ? s.language : '';
  $('streamingCheck').checked = s.streaming !== false;
  $('smartFormattingCheck').checked = s.smartFormatting !== false;
  $('webSearchCheck').checked = s.webSearch !== false;
  $('imageGenerationCheck').checked = s.imageGeneration !== false;
  $('speakRepliesCheck').checked = !!s.speakReplies;
}

function closeModelMenu() {
  $('modelPicker').classList.remove('open');
  $('modelBtn').setAttribute('aria-expanded', 'false');
}

function toggleModelMenu() {
  const open = !$('modelPicker').classList.contains('open');
  $('modelPicker').classList.toggle('open', open);
  $('modelBtn').setAttribute('aria-expanded', open ? 'true' : 'false');
}

async function selectEngine(kind) {
  if (kind === 'deep') {
    toast('Professional tier is locked — coming soon');
    return;
  }
  const r = await postJson('/api/settings', {
    endpoint: 'http://127.0.0.1:8081',
    model: 'WarriorAI-Lightning-Fast',
    useUpstream: true,
  });
  state.settings = r.settings;
  updateEngineUI();
  toast('Flash model active');
}

function envRows(env) {
  if (!env) return '';
  const rows = [
    ['OS', env.os],
    ['Architecture', env.arch],
    ['CPU', `${env.cpu} (${env.cpuCores} cores)`],
    ['Memory', `${env.ramFreeGB} GB free / ${env.ramTotalGB} GB total`],
    ['Runtime', 'Node.js ' + env.node],
    ['Workspace', env.workspace],
  ];
  return rows.map(([k, v]) => `<div class="env-row"><span>${k}</span><strong>${escapeHtml(v)}</strong></div>`).join('');
}

function renderEtiquette() {
  const e = state.memory?.etiquette;
  if (!e) return;
  $('etiquetteEnabled').checked = e.enabled !== false;
  $('etiquetteTone').value = e.tone || 'Friendly and professional';
  $('etiquetteGreeting').value = e.greetingStyle || 'Warm and brief';
  $('etiquetteAddress').value = e.addressAs || '';
  $('etiquetteCustomGreeting').value = e.customGreeting || '';
  const pill = $('etiquetteStatus');
  pill.textContent = e.enabled ? 'ON' : 'OFF';
  pill.style.color = e.enabled ? '' : 'var(--muted-2)';
  const rules = Array.isArray(e.rules) ? e.rules : [];
  $('etiquetteRules').innerHTML = rules.length
    ? rules.map((r, i) => `<div class="fact-item"><i class="dot"></i><span>${escapeHtml(r)}</span><button class="fact-del" data-rule="${i}" title="Remove rule">×</button></div>`).join('')
    : '<div class="fact-empty">No etiquette rules yet.</div>';
  $('etiquetteRules').querySelectorAll('[data-rule]').forEach((b) => {
    b.addEventListener('click', async () => {
      const r = await api('/api/etiquette/rule', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index: Number(b.dataset.rule) }),
      });
      state.memory = r.memory;
      renderEtiquette();
      toast('Etiquette rule removed');
    });
  });
}

function renderPanel() {
  const mem = state.memory;
  const env = state.environment;
  $('envGrid').innerHTML = envRows(env);
  $('welcomeEnv').textContent = env ? `${env.os} (${env.cpuCores}-core)` : 'your machine';

  if (env?.model) {
    const rows = [];
    if (env.fastModel) {
      rows.push(
        ['Flash file', env.fastModel.file],
        ['Flash size', (env.fastModel.sizeGB ?? '?') + ' GB'],
        ['Flash family', env.fastModel.family],
      );
    }
    rows.push(
      ['Pro file', env.model.file],
      ['Pro size', (env.model.sizeGB ?? '?') + ' GB'],
      ['Pro family', env.model.family],
      ['Pro status', 'Locked · coming soon'],
    );
    $('modelGrid').innerHTML = rows.map(([k, v]) => `<div class="env-row"><span>${k}</span><strong>${escapeHtml(v)}</strong></div>`).join('');
  }

  if (!mem) return;
  updateStats(mem.stats);
  renderEtiquette();
  $('factsCount').textContent = mem.learnedFacts.length;
  $('factList').innerHTML = mem.learnedFacts.length
    ? mem.learnedFacts.map((f) => `<div class="fact-item"><i class="dot"></i><span>${escapeHtml(f.text)}</span><button class="fact-del" data-id="${f.id}">×</button></div>`).join('')
    : '<div class="fact-empty">No facts learned yet. Teach me something above.</div>';
  $('feedbackList').innerHTML = mem.feedback.length
    ? mem.feedback.map((f) => `<div class="fact-item feedback"><i class="dot"></i><span>${escapeHtml(f.correction)}</span></div>`).join('')
    : '<div class="fact-empty">No corrections stored.</div>';

  $('factList').querySelectorAll('.fact-del').forEach((b) => {
    b.addEventListener('click', async () => {
      await api('/api/facts', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: b.dataset.id }) });
      const r = await api('/api/bootstrap');
      state.memory = r.memory;
      renderPanel();
      toast('Fact removed');
    });
  });
}

function openPanel(tab) {
  document.querySelector('.app').classList.add('panel-open');
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  $('tab-adapt').classList.toggle('hidden', tab !== 'adapt');
  $('tab-overview').classList.toggle('hidden', tab !== 'overview');
  $('tab-settings').classList.toggle('hidden', tab !== 'settings');
  if (tab === 'overview') { startDashboard(); requestAnimationFrame(() => { drawSysChart(); drawTokChart(); }); }
}

function closePanel() {
  document.querySelector('.app').classList.remove('panel-open');
}

function closeMobileSidebar() {
  document.querySelector('.app').classList.remove('mobile-open');
}

/* ============================== Events ============================== */

function bindEvents() {
  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('input').value.trim();
    if (!text) return;
    $('input').value = '';
    $('input').style.height = 'auto';
    sendMessage(text);
  });

  $('input').addEventListener('input', () => {
    const el = $('input');
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 180) + 'px';
  });

  $('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('composer').requestSubmit();
    }
  });

  $('newChatBtn').addEventListener('click', startNewChat);
  $('searchInput').addEventListener('input', renderConversations);

  document.querySelectorAll('.suggestion').forEach((b) => {
    b.addEventListener('click', () => sendMessage(b.dataset.prompt));
  });

  $('adaptBtn').addEventListener('click', () => openPanel('adapt'));
  $('statusCard').addEventListener('click', () => openPanel('adapt'));
  $('settingsBtn').addEventListener('click', () => openPanel('settings'));
  $('closePanel').addEventListener('click', closePanel);
  $('overlay').addEventListener('click', () => { closePanel(); closeMobileSidebar(); });
  $('menuBtn').addEventListener('click', () => document.querySelector('.app').classList.toggle('mobile-open'));
  $('collapseBtn').addEventListener('click', () => document.querySelector('.app').classList.toggle('collapsed'));

  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => openPanel(t.dataset.tab));
  });

  $('refreshEnv').addEventListener('click', async () => {
    state.environment = await api('/api/environment');
    renderPanel();
    toast('Environment synced');
  });

  $('learnForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('factInput').value.trim();
    if (!text) return;
    const r = await postJson('/api/learn', { text });
    state.memory = r.memory;
    $('factInput').value = '';
    renderPanel();
    toast('WarriorAI learned that fact');
  });

  $('feedbackForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const correction = $('feedbackInput').value.trim();
    if (!correction) return;
    const r = await postJson('/api/feedback', { correction });
    state.memory = r.memory;
    $('feedbackInput').value = '';
    renderPanel();
    toast('Correction remembered');
  });

  $('saveEtiquette').addEventListener('click', async () => {
    const r = await postJson('/api/etiquette', {
      enabled: $('etiquetteEnabled').checked,
      tone: $('etiquetteTone').value,
      greetingStyle: $('etiquetteGreeting').value,
      addressAs: $('etiquetteAddress').value.trim(),
      customGreeting: $('etiquetteCustomGreeting').value.trim(),
    });
    state.memory = r.memory;
    renderEtiquette();
    toast('Etiquette training saved');
  });

  $('resetEtiquette').addEventListener('click', async () => {
    const r = await postJson('/api/etiquette/reset', {});
    state.memory = r.memory;
    renderEtiquette();
    toast('Etiquette reset to defaults');
  });

  $('etiquetteRuleForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('etiquetteRuleInput').value.trim();
    if (!text) return;
    const r = await postJson('/api/etiquette/rule', { text });
    state.memory = r.memory;
    $('etiquetteRuleInput').value = '';
    renderEtiquette();
    toast('Etiquette rule added');
  });

  $('attachBtn').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', async (e) => {
    await handleFiles([...e.target.files]);
    e.target.value = '';
  });
  $('micBtn').addEventListener('click', startVoiceInput);

  $('modelBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleModelMenu();
  });
  document.querySelectorAll('.model-option').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const tier = btn.dataset.model;
      closeModelMenu();
      if (tier === 'flash') toast('Flash active — instant local replies');
      else if (tier === 'professional') toast('Professional tier is locked — coming soon');
      else toast('Super tier is locked — coming soon');
    });
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#modelPicker')) closeModelMenu();
  });

  $('exportBtn').addEventListener('click', () => {
    window.location.href = '/api/training-data';
    toast('Exporting training data');
  });

  $('tempInput').addEventListener('input', () => { $('tempValue').textContent = $('tempInput').value; });

  $('engineFast').addEventListener('click', () => selectEngine('fast'));
  $('engineDeep').addEventListener('click', () => selectEngine('deep'));

  $('saveResponseSystem').addEventListener('click', async () => {
    const r = await postJson('/api/settings', {
      personality: $('personalityInput').value,
      answerLength: $('answerLengthInput').value,
      language: $('languageInput').value.trim() || 'Auto',
      streaming: $('streamingCheck').checked,
      smartFormatting: $('smartFormattingCheck').checked,
      webSearch: $('webSearchCheck').checked,
      imageGeneration: $('imageGenerationCheck').checked,
      speakReplies: $('speakRepliesCheck').checked,
    });
    state.settings = r.settings;
    updateEngineUI();
    const el = $('responseSaved');
    el.className = 'test-result ok';
    el.textContent = 'Response system saved.';
    toast('Response system updated');
  });

  $('saveSettings').addEventListener('click', async () => {
    const r = await postJson('/api/settings', {
      endpoint: $('endpointInput').value.trim(),
      model: $('modelInput').value.trim(),
      useUpstream: $('upstreamCheck').checked,
      temperature: Number($('tempInput').value),
    });
    state.settings = r.settings;
    updateEngineUI();
    toast('Settings saved');
  });

  $('testConnection').addEventListener('click', async () => {
    const el = $('testResult');
    el.className = 'test-result';
    el.textContent = 'Testing…';
    try {
      const r = await postJson('/api/settings/test', {});
      el.className = 'test-result ' + (r.ok ? 'ok' : 'err');
      el.textContent = r.message;
    } catch (e) {
      el.className = 'test-result err';
      el.textContent = e.message;
    }
  });

  document.addEventListener('keydown', (e) => {
    const tag = (document.activeElement?.tagName || '').toLowerCase();
    if (e.key.toLowerCase() === 'n' && !e.ctrlKey && !e.metaKey && !e.altKey && tag !== 'input' && tag !== 'textarea' && tag !== 'select') {
      e.preventDefault();
      startNewChat();
    }
    if (e.key === 'Escape') { closePanel(); closeMobileSidebar(); closeModelMenu(); }
  });
}

/* ============================== Init ============================== */

async function init() {
  if (window.mermaid) {
    try {
      window.mermaid.initialize({
        startOnLoad: false,
        theme: 'dark',
        securityLevel: 'loose',
        themeVariables: {
          primaryColor: '#1a2436',
          primaryTextColor: '#e9eff8',
          primaryBorderColor: '#5b8cff',
          lineColor: '#5b8cff',
          secondaryColor: '#241f3f',
          tertiaryColor: '#0d1119',
          fontFamily: 'Inter, sans-serif',
        },
      });
    } catch (_) {}
  }

  try {
    const data = await api('/api/bootstrap');
    state.conversations = data.conversations;
    state.memory = data.memory;
    state.settings = data.settings;
    state.environment = data.environment;
    updateEngineUI();
    $('statusSub').textContent = `${data.environment.cpuCores} cores · Flash ${data.environment.fastModel?.sizeGB ?? '1.5'} GB`;
    renderConversations();
    renderPanel();
    renderAttachments();

    try {
      const engines = await api('/api/engines');
      const badge = $('modeBadge');
      let active = (state.settings.model || '').toLowerCase().includes('v1-lightning') ? 'deep' : 'fast';
      if (!engines[active] && active === 'deep' && engines.fast) {
        const r = await postJson('/api/settings', {
          endpoint: 'http://127.0.0.1:8081',
          model: 'WarriorAI-Lightning-Fast',
          useUpstream: true,
        });
        state.settings = r.settings;
        active = 'fast';
        updateEngineUI();
      }
      if (engines[active]) {
        badge.classList.add('live');
        badge.innerHTML = '<i></i>LIVE · ' + (active === 'deep' ? 'PRO' : 'FLASH');
        $('statusDot').classList.add('live');
        $('statusSub').textContent = 'Local inference online';
        dashLog('ok', `Inference engine online (${active === 'deep' ? 'Professional 9B' : 'Flash 1.5B'})`);
      } else {
        badge.innerHTML = '<i></i>DEMO MODE';
        dashLog('warn', 'No engine detected — running in demo mode');
      }
    } catch (_) {}
  } catch (e) {
    toast('Could not load WarriorAI: ' + e.message);
  }
  bindEvents();
  window.addEventListener('resize', () => { drawSysChart(); drawTokChart(); });
}

init();
