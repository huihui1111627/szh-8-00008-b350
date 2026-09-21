/* UI 渲染：DOM 控件与 Canvas 图表。 */
'use strict';

class UI {
  constructor() {
    this.canvas = {
      temp: document.getElementById('tempChart'),
      noise: document.getElementById('noiseChart'),
      flux: document.getElementById('fluxChart'),
      wave: document.getElementById('waveCanvas'),
      cmp: document.getElementById('compareChart'),
    };
    this.wavePhase = 0;
    this.buildStatic();
  }

  ctx(c) {
    const dpr = window.devicePixelRatio || 1;
    const r = c.getBoundingClientRect();
    const cssH = parseInt(c.getAttribute('height'), 10) || 150;
    const W = Math.max(50, r.width), H = cssH;
    if (c.width !== Math.round(W * dpr) || c._cssH !== H) {
      c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
      c.style.height = H + 'px'; c._cssH = H;
    }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { g, w: W, h: H };
  }

  buildStatic() {
    // 温区列表（自上而下：热 → 冷）
    const body = document.getElementById('fridgeBody');
    body.innerHTML = '';
    const rows = CFG.stages.slice().reverse();
    rows.forEach((s, i) => {
      if (s.id !== 'room') {
        const link = document.createElement('div');
        link.className = 'stage-link';
        const c = CFG.cond.find(x => x.to === s.id);
        link.innerHTML = `<div class="pipe" data-delay="级间延迟 ${c.delay}s · G ${c.G} nW/K"><span class="flow-dot" id="dot-${s.id}"></span></div>`;
        body.appendChild(link);
      }
      const row = document.createElement('div');
      row.className = 'stage-row';
      row.id = 'stage-' + s.id;
      row.innerHTML = `
        <div class="stage-name">${s.name}<small>${s.sub}</small></div>
        <div class="stage-track"><div class="stage-fill" id="fill-${s.id}" style="background:${s.color}"></div></div>
        <div class="stage-temp" id="temp-${s.id}">—</div>
        <div class="stage-extra" id="extra-${s.id}"></div>`;
      body.appendChild(row);
    });

    // 图例
    document.getElementById('stageLegend').innerHTML =
      CFG.stages.filter(s => s.id !== 'room')
        .map(s => `<span><i style="background:${s.color}"></i>${s.name}</span>`).join('');

    // 线路组
    const lg = document.getElementById('lineGroups');
    lg.innerHTML = '';
    CFG.lines.forEach(ln => {
      const d = document.createElement('div');
      d.className = 'line-group';
      d.innerHTML = `
        <div class="lg-name">${ln.name}<small>${ln.sub}</small></div>
        <div class="lg-load">${ln.off.mxc}→${ln.on.mxc} nW</div>
        <label class="switch"><input type="checkbox" id="line-${ln.id}"><span class="track"></span></label>`;
      lg.appendChild(d);
    });
    const pg = document.getElementById('pulseGroup');
    pg.innerHTML = CFG.lines.map(l => `<option value="${l.id}">${l.name}</option>`).join('');
  }

  /* ---------- 温区 ---------- */
  renderStages() {
    const c = SIM.ctrl, now = c.time;
    for (const s of CFG.stages) {
      if (s.id === 'room') {
        document.getElementById('temp-room').textContent = fmtT(s.id === 'room' ? 300 : 0);
        document.getElementById('fill-room').style.width = '100%';
        continue;
      }
      const d = c.sensors.getDisplay(s.id, now);
      const tempEl = document.getElementById('temp-' + s.id);
      tempEl.innerHTML = fmtT(d.temp) +
        (d.mode === 'est' ? ' <span class="est">估</span>' : d.mode === 'late' ? ' <span class="est">迟</span>' : '');
      tempEl.style.color = d.mode === 'est' || d.mode === 'late' ? 'var(--warn)' : s.color;
      // 进度条按“距目标的相对降温量”对数映射
      const frac = s.id === 'room' ? 1 :
        clamp(1 - Math.log10(Math.max(d.temp, s.tTarget) / s.tTarget) / Math.log10(295 / s.tTarget), 0, 1);
      document.getElementById('fill-' + s.id).style.width = (frac * 100).toFixed(1) + '%';
      const row = document.getElementById('stage-' + s.id);
      row.classList.toggle('alarm', s.id === 'mxc' && c.phaseId === 'base' && !c.stable && c.phaseT > 300);
      const extras = [];
      if (s.id === 'mxc') {
        extras.push('稳定门限 ' + fmtT(CFG.stable.mxcBelow));
        extras.push(c.stable ? '✓ 稳定' : '未稳定');
      } else if (s.tTarget) extras.push('目标 ' + fmtT(s.tTarget));
      document.getElementById('extra-' + s.id).textContent = extras.join(' · ');

      // 延迟管上的流动点（热流越大越快下移）
      const dot = document.getElementById('dot-' + s.id);
      if (dot) {
        const ci = CFG.cond.findIndex(x => x.to === s.id);
        const q = c.model.flux[ci];
        const speed = clamp(Math.log10(Math.max(q, 1)) / 4, 0.05, 1);
        const y = (now * 4 * speed) % 18;
        dot.style.top = y + 'px';
        dot.style.background = q > 1000 ? 'var(--bad)' : q > 50 ? 'var(--warn)' : 'var(--accent2)';
      }
    }
  }

  /* ---------- 通用绘图 ---------- */
  grid(g, w, h, n = 4) {
    g.strokeStyle = 'rgba(255,255,255,.05)'; g.lineWidth = 1;
    for (let i = 0; i <= n; i++) {
      const y = h * i / n;
      g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
    }
  }

  drawTempChart(showEst, showBranch) {
    const { g, w, h } = this.ctx(this.canvas.temp);
    g.clearRect(0, 0, w, h);
    this.grid(g, w, h);
    const s = SIM.ctrl.series;
    if (s.t.length < 2) return;
    const t0 = s.t[0], t1 = s.t[s.t.length - 1];
    const X = (t) => 4 + (t - t0) / Math.max(1, t1 - t0) * (w - 8);
    // 对数温度：10mK ~ 300K → 10..300000 mK
    const yMin = 10, yMax = 300000;
    const Y = (kelvin) => h - (Math.log10(clamp(kelvin * 1000, yMin, yMax)) - Math.log10(yMin))
      / (Math.log10(yMax) - Math.log10(yMin)) * h;
    // 门限参考线
    const drawH = (kel, color, label) => {
      g.strokeStyle = color; g.setLineDash([4, 4]); g.beginPath();
      g.moveTo(0, Y(kel)); g.lineTo(w, Y(kel)); g.stroke(); g.setLineDash([]);
      g.fillStyle = color; g.font = '9px monospace'; g.fillText(label, w - 108, Y(kel) - 2);
    };
    drawH(0.035, 'rgba(61,220,132,.5)', '稳定门限 35mK');
    drawH(0.8, 'rgba(167,139,250,.4)', 'Still 0.8K');

    // 分支轨迹叠加
    if (showBranch) {
      for (const b of SIM.ctrl.branches) {
        if (!b.result) continue;
        const colors = { aggressive: '#ff8ba0', conservative: '#7fe6cf', standard: '#8fb4ff' };
        g.strokeStyle = colors[b.strategy] + 'aa'; g.lineWidth = 1.2;
        g.beginPath();
        b.result.trajT.forEach((t, i) => {
          const x = X(t), y = Y(b.result.trajMxc[i]);
          i ? g.lineTo(x, y) : g.moveTo(x, y);
        });
        g.stroke();
      }
    }

    const ids = ['p50', 'p4', 'still', 'mxc'];
    ids.forEach((id, si) => {
      const st = CFG.stages.find(x => x.id === id);
      g.strokeStyle = st.color; g.lineWidth = id === 'mxc' ? 1.8 : 1.2;
      g.beginPath();
      s.disp[id].forEach((v, i) => {
        const x = X(s.t[i]), y = Y(v);
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      });
      g.stroke();
    });

    // 失效期估计段（虚线）与迟到点
    if (showEst) {
      g.strokeStyle = 'var(--warn)'; g.setLineDash([3, 3]); g.lineWidth = 1.4;
      let drawing = false;
      s.est.mxc.forEach((v, i) => {
        if (v == null) { drawing = false; return; }
        const x = X(s.t[i]), y = Y(v);
        if (!drawing) { g.moveTo(x, y); drawing = true; } else g.lineTo(x, y);
      });
      g.stroke(); g.setLineDash([]);
    }
    // 事件标记
    for (const m of s.phaseMark) {
      g.fillStyle = 'rgba(167,139,250,.8)';
      g.fillRect(X(m) - 1, 0, 2, h);
    }
    for (const m of s.flagMark) {
      if (m.kind === 'penalty') { g.fillStyle = 'rgba(255,93,115,.9)'; g.fillRect(X(m.t) - 1, 0, 2, h); }
      if (m.kind === 'rebound') {
        let bi = 0, bd = Infinity;
        s.t.forEach((tt, k) => { const d = Math.abs(tt - m.t); if (d < bd) { bd = d; bi = k; } });
        g.fillStyle = '#ff5d73'; g.beginPath(); g.arc(X(s.t[bi]), Y(s.disp.mxc[bi]), 3.5, 0, 7); g.fill();
      }
    }
    for (const pt of s.pulseMark) {
      g.fillStyle = 'rgba(255,180,84,.7)';
      g.beginPath(); g.arc(X(pt), 8, 2.5, 0, 7); g.fill();
    }
  }

  drawNoiseChart() {
    const { g, w, h } = this.ctx(this.canvas.noise);
    g.clearRect(0, 0, w, h); this.grid(g, w, h, 3);
    const s = SIM.ctrl.series;
    if (s.t.length < 2) return;
    const t0 = s.t[0], t1 = s.t[s.t.length - 1];
    const X = (t) => 4 + (t - t0) / Math.max(1, t1 - t0) * (w - 8);
    const Y = (n) => h - clamp(Math.log10(Math.max(n, 10)) / Math.log10(3000), 0, 1) * h;
    g.strokeStyle = 'rgba(255,180,84,.5)'; g.setLineDash([4, 4]);
    g.beginPath(); g.moveTo(0, Y(CFG.noiseTarget)); g.lineTo(w, Y(CFG.noiseTarget)); g.stroke();
    g.fillStyle = 'rgba(255,180,84,.7)'; g.font = '9px monospace';
    g.fillText('校准确许 ' + CFG.noiseTarget + ' mK', 6, Y(CFG.noiseTarget) - 2);
    g.strokeStyle = 'rgba(255,93,115,.4)';
    g.beginPath(); g.moveTo(0, Y(CFG.stabilityNoise)); g.lineTo(w, Y(CFG.stabilityNoise)); g.stroke(); g.setLineDash([]);
    g.fillText('稳定上限 ' + CFG.stabilityNoise, w - 86, Y(CFG.stabilityNoise) - 2);

    g.strokeStyle = '#ffb454'; g.lineWidth = 1.6; g.beginPath();
    s.noise.forEach((n, i) => { const x = X(s.t[i]), y = Y(n); i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.stroke();
    g.fillStyle = '#ffd79a'; g.font = '10px monospace';
    g.fillText(s.noise.length ? s.noise[s.noise.length - 1].toFixed(0) + ' mK' : '', w - 60, 12);
  }

  drawFluxChart() {
    const { g, w, h } = this.ctx(this.canvas.flux);
    g.clearRect(0, 0, w, h); this.grid(g, w, h, 3);
    const s = SIM.ctrl.series;
    if (s.t.length < 2) return;
    const t0 = s.t[0], t1 = s.t[s.t.length - 1];
    const X = (t) => 4 + (t - t0) / Math.max(1, t1 - t0) * (w - 8);
    // 全局最大热流（正值）
    let qmax = 1;
    for (let i = 0; i < 4; i++) for (const q of s.flux[i]) qmax = Math.max(qmax, Math.abs(q));
    const Y = (q) => h / 2 - q / qmax * (h / 2 - 6);
    const colors = ['#4da3ff', '#36d1c4', '#a78bfa', '#3ddc84'];
    const labels = ['室→50K', '50K→4K', '4K→Still', 'Still→MXC'];
    for (let ci = 0; ci < 4; ci++) {
      g.strokeStyle = colors[ci]; g.lineWidth = ci === 3 ? 1.8 : 1.1; g.beginPath();
      s.flux[ci].forEach((q, i) => { const x = X(s.t[i]), y = Y(q); i ? g.lineTo(x, y) : g.moveTo(x, y); });
      g.stroke();
    }
    g.fillStyle = '#8a97c4'; g.font = '9px monospace';
    labels.forEach((l, i) => { g.fillStyle = colors[i]; g.fillText(l, 6 + i * 78, h - 5); });
  }

  drawWave() {
    const { g, w, h } = this.ctx(this.canvas.wave);
    g.clearRect(0, 0, w, h);
    g.strokeStyle = 'rgba(255,255,255,.12)';
    g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
    const on = ['dc', 'mw', 'ro'].filter(id => SIM.ctrl.lines[id]);
    const colors = { dc: '#4da3ff', mw: '#a78bfa', ro: '#36d1c4' };
    this.wavePhase += 0.12;
    if (!on.length) {
      g.fillStyle = '#5a679a'; g.font = '10px sans-serif';
      g.fillText('所有线路断开（仅残余漏热）', 10, h / 2 - 6);
      return;
    }
    on.forEach((id, li) => {
      g.strokeStyle = colors[id]; g.lineWidth = 1.3; g.beginPath();
      const freq = id === 'mw' ? 0.22 : id === 'ro' ? 0.14 : 0.04;
      const amp = id === 'dc' ? 5 : 12;
      for (let x = 0; x < w; x++) {
        const env = 0.6 + 0.4 * Math.sin(x * 0.02 + li);
        const y = h / 2 + Math.sin(x * freq + this.wavePhase * (id === 'dc' ? 0.2 : 1)) * amp * env;
        x ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke();
    });
  }

  /* ---------- 阶段 / 校准 / 传感器面板 ---------- */
  renderPhase() {
    const c = SIM.ctrl;
    const bar = document.getElementById('phaseBar');
    bar.innerHTML = CFG.phases.map((p, i) =>
      `<div class="phase-seg ${i < c.phaseIdx ? 'done' : i === c.phaseIdx ? 'active' : ''}" title="${p.name}"></div>`).join('');
    document.getElementById('phasePill').textContent = CFG.phases[c.phaseIdx].name;
    const gs = c.gateStatus();
    const gateEl = document.getElementById('phaseGate');
    if (gs.gates.length) {
      gateEl.innerHTML = '下一阶段门限：' + gs.gates.map(g => {
        const pct = Math.min(100, g.acc / g.settle * 100);
        return `<span class="${g.ready ? 'ready' : 'notready'}">${CFG.stages.find(s => s.id === g.stage).name} &lt;${fmtT(g.below)} 保持 ${Math.floor(g.acc)}/${g.settle}s（${pct.toFixed(0)}%）</span>`;
      }).join('　');
      document.getElementById('btnAdvance').textContent = gs.ready ? '✓ 进入下一阶段' : '⚠ 强行提前推进（有风险）';
      document.getElementById('btnAdvance').classList.toggle('warn', !gs.ready);
    } else {
      gateEl.innerHTML = c.stable ? '<span class="ready">系统已稳定，可执行校准与脉冲实验</span>' : '<span class="notready">基温稳定中：MXC &lt;35 mK 且噪声 &lt;520 mK，持续 120 s</span>';
      document.getElementById('btnAdvance').textContent = '进入下一阶段';
    }
    const pb = document.getElementById('penaltyBox');
    if (c.lastPenalty && c.time - c.lastPenalty.time < 180) {
      pb.classList.remove('hidden');
      pb.textContent = `⚠ ${fmtClock(c.lastPenalty.time)} 强行提前推进（${c.lastPenalty.missing}），系统正在消化热回灌：温度反弹 / 噪声上升中`;
    } else pb.classList.add('hidden');
  }

  renderLines() {
    const c = SIM.ctrl;
    for (const ln of CFG.lines) document.getElementById('line-' + ln.id).checked = !!c.lines[ln.id];
  }

  renderCal() {
    const c = SIM.ctrl;
    const box = document.getElementById('calList');
    if (!c.cals.length) {
      box.innerHTML = '<div class="hint">尚无校准任务。基温稳定后可执行。</div>';
    } else {
      box.innerHTML = c.cals.slice().reverse().map(x => `
        <div class="cal-item">
          <span class="ci-name">${x.name}</span>
          <span class="ci-badge ${x.status}">${x.status === 'valid' ? '有效' : x.status === 'running' ? '进行中' : '已失效'}</span>
          <div class="cal-bar"><i style="width:${clamp(x.prog / x.dur * 100, 0, 100)}%"></i></div>
          <span class="ci-meta">开始 ${fmtClock(x.start)}${x.status === 'running' ? ` · 进度 ${clamp(x.prog / x.dur * 100, 0, 100).toFixed(0)}%${x.stalled ? ' · 已暂停 ' + x.stalled + 's' : ''}` : ''}</span>
        </div>`).join('');
    }
    const g = document.getElementById('calGlobal');
    const valid = c.cals.some(x => x.status === 'valid');
    const running = c.cals.some(x => x.status === 'running');
    g.textContent = running ? '校准进行中…' : valid ? '存在有效校准' : '无有效校准';
    g.className = 'cal-status ' + (running ? 'running' : valid ? 'ok' : 'bad');
    document.getElementById('btnCalStart').disabled = c.phaseId !== 'base' || !c.stable || running;
  }

  renderSensors() {
    const c = SIM.ctrl, now = c.time;
    const box = document.getElementById('sensorList');
    box.innerHTML = CFG.stages.filter(s => s.id !== 'room').map(s => {
      const failed = c.sensors.isFailed(s.id, now);
      const awaitR = c.sensors.awaitRecon[s.id];
      const r = c.sensors.lastReading[s.id];
      const wm = c.sensors.watermark[s.id];
      const lag = r ? now - r.ts : 0;
      const pending = failed ? 0 : c.sensors.pendingCount(s.id);
      let state, cls;
      if (failed) { state = '失效 · 估计中'; cls = 'fail'; }
      else if (awaitR) { state = '恢复 · 待对账'; cls = 'late'; }
      else if (!r) { state = '等待读数'; cls = 'late'; }
      else if (lag > 8) { state = `读数滞后 ${lag}s`; cls = 'late'; }
      else { state = '正常'; cls = 'ok'; }
      const wmText = isFinite(wm) ? 'WM T+' + wm + 's' : '尚未建立水位线';
      return `<div class="sensor-row ${failed ? 'failed' : ''}">
        <span class="sr-name">${s.name}</span>
        <span class="sr-state ${cls}">${state}</span>
        <span class="sr-wm">${wmText}${pending ? ' · 在途 ' + pending : ''}</span>
      </div>`;
    }).join('');
  }

  /* ---------- 检查点与分支 ---------- */
  renderBranches() {
    const c = SIM.ctrl;
    const box = document.getElementById('branchList');
    const cks = c.checkpoints.slice().reverse();
    if (!cks.length) {
      box.innerHTML = '<div class="hint">运行中保存检查点，即可从任意时刻派生不同降温策略。</div>';
      document.getElementById('strategyCompare').classList.add('hidden');
      return;
    }
    box.innerHTML = cks.map(ck => {
      const bs = c.branches.filter(b => b.ckId === ck.id);
      return `<div class="branch-item">
        <div class="bi-head">
          <span class="bi-name">📌 ${ck.label}</span>
          <span class="bi-meta">${fmtClock(ck.time)} · ${ck.phaseName}</span>
        </div>
        <div class="bi-meta">MXC ${fmtT(ck.t.mxc)} · 线路 ${CFG.lines.filter(l => ck.lines[l.id]).map(l => l.name.slice(0, 2)).join('/') || '全断'}</div>
        <div class="bi-actions">
          <button class="btn tiny" data-act="restore" data-id="${ck.id}">↩ 恢复到此点</button>
          ${['standard', 'aggressive', 'conservative'].map(k =>
            `<button class="btn tiny strategy" data-strategy="${k}" data-id="${ck.id}">派生·${CFG.strategies[k].label}</button>`).join('')}
        </div>
        ${bs.length ? '<div class="bi-meta" style="margin-top:5px">策略：' + bs.map(b => {
          const r = b.result;
          const cls = b.strategy;
          return `<span class="bi-tag ${cls}">${CFG.strategies[b.strategy].label}: ${
            r ? (r.stableAt != null ? fmtClock(r.total) + ' 达稳' : '未达稳') : '推演中…'}</span>`;
        }).join(' ') + '</div>' : ''}
      </div>`;
    }).join('');

    const done = c.branches.filter(b => b.result);
    if (done.length) {
      document.getElementById('strategyCompare').classList.remove('hidden');
      this.renderCompare(done);
    }
  }

  renderCompare(branches) {
    const tbl = document.getElementById('compareTable');
    const head = '<tr><th>策略</th><th>总耗时</th><th>达基温</th><th>基温→稳定</th><th>最低 MXC</th><th>反弹</th><th>结果</th></tr>';
    const stable = branches.filter(b => b.result.stableAt != null);
    const bestTotal = stable.length ? Math.min(...stable.map(b => b.result.total)) : null;
    const bestSet = stable.length ? Math.min(...stable.map(b => b.result.stableAfterBase)) : null;
    tbl.innerHTML = head + branches.map(b => {
      const r = b.result, st = CFG.strategies[b.strategy];
      const isBest = r.stableAt != null && r.total === bestTotal;
      return `<tr class="${isBest ? 'best' : ''}">
        <td>${st.label}</td>
        <td>${r.stableAt != null ? fmtClock(r.total) : '—'}</td>
        <td>${fmtClock(r.toBase)}</td>
        <td>${r.stableAfterBase != null ? fmtClock(r.stableAfterBase) : '—'}</td>
        <td>${fmtT(r.minMxc)}</td>
        <td>${r.penalty || r.rebounded ? '⚠ 有' : '无'}</td>
        <td>${r.stableAt != null ? (isBest ? '最快 ✓' : '达稳') : '未达稳'}</td>
      </tr>`;
    }).join('');
    this.drawCompareChart(branches);
  }

  drawCompareChart(branches) {
    const { g, w, h } = this.ctx(this.canvas.cmp);
    g.clearRect(0, 0, w, h);
    const colors = { aggressive: '#ff8ba0', conservative: '#7fe6cf', standard: '#8fb4ff' };
    let tmin = Infinity, tmax = 0, vmin = 0.01, vmax = 300;
    for (const b of branches) {
      tmin = Math.min(tmin, b.result.trajT[0]);
      tmax = Math.max(tmax, b.result.trajT[b.result.trajT.length - 1]);
    }
    const X = (t) => 4 + (t - tmin) / Math.max(1, tmax - tmin) * (w - 8);
    const Y = (k) => h - (Math.log10(clamp(k, vmin, vmax)) - Math.log10(vmin)) /
      (Math.log10(vmax) - Math.log10(vmin)) * (h - 14) - 2;
    for (const b of branches) {
      g.strokeStyle = colors[b.strategy]; g.lineWidth = 1.5; g.beginPath();
      b.result.trajT.forEach((t, i) => { const x = X(t), y = Y(b.result.trajMxc[i]); i ? g.lineTo(x, y) : g.moveTo(x, y); });
      g.stroke();
      const st = CFG.strategies[b.strategy];
      g.fillStyle = colors[b.strategy]; g.font = '9px sans-serif';
      g.fillText(st.label, 6 + ['standard', 'aggressive', 'conservative'].indexOf(b.strategy) * 60, h - 2);
    }
  }

  /* ---------- 事件 / 时钟 ---------- */
  appendEvent(e) {
    const log = document.getElementById('eventLog');
    const div = document.createElement('div');
    div.className = 'ev ' + e.kind;
    div.innerHTML = `<span class="ev-t">${fmtClock(e.t)}</span><span class="ev-k">${e.code}</span><span>${e.msg}</span>`;
    log.appendChild(div);
    while (log.children.length > 220) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
  }

  clearEvents() { document.getElementById('eventLog').innerHTML = ''; }

  renderHeader() {
    const c = SIM.ctrl;
    document.getElementById('simClock').textContent = fmtClock(c.time);
    const run = document.getElementById('runPill');
    run.textContent = c.running ? '推演中' : '已暂停';
    run.className = 'run-pill ' + (c.running ? 'running' : 'stopped');
  }

  renderAll() {
    this.renderHeader();
    this.renderStages();
    this.renderPhase();
    this.renderLines();
    this.renderCal();
    this.renderSensors();
    this.renderBranches();
    this.drawTempChart(
      document.getElementById('chkShowEst').checked,
      document.getElementById('chkShowBranch').checked);
    this.drawNoiseChart();
    this.drawFluxChart();
    this.drawWave();
  }
}
