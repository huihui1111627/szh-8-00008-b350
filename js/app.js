/* CryoOps UI 控制层 */
(function () {
  'use strict';
  const { Sim, STAGES, GROUPS, CALS, STRATEGIES, DT, fmtTime } = window.CryoSim;
  const { tempChart, lineChart, gantt } = window.CryoCharts;

  const state = {
    runs: [],            // 所有分支（对比表 + 下拉）
    activeId: null,
    playing: false,
    speed: 300,          // 仿真秒 / 真实秒
    lastFrame: 0,
    filter: 'all'
  };

  const $ = id => document.getElementById(id);

  function newRun(opts) {
    const sim = new Sim(opts || { strategyId: 'manual', strategyName: '手动操作', name: '手动运行' });
    registerRun(sim);
    return sim;
  }

  function registerRun(sim) {
    const id = 'r' + Math.random().toString(36).slice(2, 8);
    state.runs.push({ id, sim });
    state.activeId = id;
    rebuildRunSelect();
    return id;
  }

  function active() {
    const r = state.runs.find(r => r.id === state.activeId);
    return r ? r.sim : null;
  }

  function rebuildRunSelect() {
    const sel = $('runSelect');
    sel.innerHTML = '';
    state.runs.forEach((r, i) => {
      const o = document.createElement('option');
      o.value = r.id;
      o.textContent = (i + 1) + '. ' + r.sim.name + '  @' + fmtTime(r.sim.t) +
        (r.sim.ready ? ' ✓就绪' : r.sim.finished ? ' ■结束' : '');
      sel.appendChild(o);
    });
    sel.value = state.activeId;
  }

  // ---------- 渲染：制冷机 ----------
  function renderFridge(sim) {
    const box = $('fridge');
    if (!box.dataset.built) {
      box.innerHTML = '';
      STAGES.forEach((st, i) => {
        const row = document.createElement('div');
        row.className = 'stage-row';
        row.dataset.i = i;
        row.innerHTML =
          '<div class="stage-name">' + st.name +
            '<div class="stage-tgt" style="color:#8294ab;font-size:10px">就绪 ≤ ' +
            (st.ready >= 1 ? st.ready + 'K' : (st.ready * 1000) + 'mK') + '</div></div>' +
          '<div><div class="stage-bar"><div class="stage-fill"></div></div>' +
          '<div class="stage-flag"></div></div>' +
          '<div class="stage-temp"></div>';
        row.addEventListener('click', e => openSensorMenu(e, i));
        box.appendChild(row);
      });
      box.dataset.built = '1';
    }
    const palette = ['#74c0fc', '#4dabf7', '#63e6be', '#ffa94d', '#ff8787'];
    STAGES.forEach((st, i) => {
      const row = box.children[i];
      const reading = sim.sensorReading(i);
      const v = reading.value;
      const fill = row.querySelector('.stage-fill');
      const tempEl = row.querySelector('.stage-temp');
      const flag = row.querySelector('.stage-flag');
      // 冷度进度：300K → target
      const cold = v == null ? 0 :
        Math.max(0, Math.min(1, (Math.log(305) - Math.log(Math.max(v, 0.004))) /
                                 (Math.log(305) - Math.log(st.target))));
      fill.style.width = (cold * 100).toFixed(1) + '%';
      fill.style.background = palette[i];
      if (v == null) {
        tempEl.textContent = '— 无读数';
        tempEl.style.color = 'var(--red)';
      } else {
        tempEl.textContent = v >= 1 ? v.toFixed(2) + ' K' : (v * 1000).toFixed(2) + ' mK';
        const faulty = reading.status === 'frozen' || reading.status === 'drift';
        const ok = v <= st.ready;
        tempEl.style.color = faulty ? 'var(--amber)' : ok ? 'var(--green)' : 'var(--text)';
      }
      row.classList.toggle('bad', reading.status !== 'live' && reading.status !== 'gap');
      let msg = '';
      if (reading.status === 'dead') msg = '⚠ 传感器断线，控制决策不使用该读数';
      else if (reading.status === 'frozen') msg = '⚠ 读数冻结于 ' + fmtTs(reading.collectedAt);
      else if (reading.status === 'drift') msg = '⚠ 读数漂移中（不可用于门限判定）';
      else if (reading.status === 'gap') msg = '… 数据采集中，等待到达（真实值：' +
        (sim.temp[i] >= 1 ? sim.temp[i].toFixed(2) + 'K' : (sim.temp[i] * 1000).toFixed(1) + 'mK') + '）';
      flag.textContent = msg;
    });
  }
  function fmtTs(t) { return fmtTime(t); }

  function kv(k, v, cls) {
    return '<div class="kv"><div class="k">' + k + '</div><div class="v ' + (cls || '') + '">' + v + '</div></div>';
  }

  function renderStability(sim) {
    const m = sim.T('mxc') * 1000;
    const noise = sim.maxNoise();
    const score = sim.stabilityScore();
    const t2 = sim.t2Estimate();
    const stabMin = Math.floor(sim.stableFor / 60);
    const pulseOn = sim.groups.some(g => sim.t < g.activeUntil);
    $('stabilityGrid').innerHTML =
      kv('稳定评分', score, score > 80 ? 'good' : score > 50 ? 'warn' : 'bad') +
      kv('估计 T₂*', t2.toFixed(0) + ' µs', t2 > 80 ? 'good' : 'warn') +
      kv('当前最噪链路', noise.toFixed(0) + ' mK', noise < 300 ? 'good' : 'bad') +
      kv('已稳定保持', stabMin + ' min', stabMin >= 15 ? 'good' : 'warn') +
      kv('MXC 热负荷', (sim.groupHeat()[4] * 1e9).toFixed(1) + ' nW', '') +
      kv('脉冲状态', pulseOn ? '发射中' : '静默', pulseOn ? 'warn' : 'good');
  }

  function renderReadiness(sim) {
    const checks = [
      ['温区全部达标', STAGES.every((s, i) => sim.temp[i] <= s.ready)],
      ['MXC ≤ 14mK', sim.T('mxc') <= 0.014],
      ['稳定保持 ≥15min', sim.isStable(900)],
      ['线路全部开启', sim.groups.every(g => g.enabled)],
      ['校准全部有效', sim.cals.every(c => c.status === 'done')],
      ['无脉冲进行', !sim.groups.some(g => sim.t < g.activeUntil)]
    ];
    const all = checks.every(c => c[1]);
    const banner = $('readyBanner');
    banner.textContent = all ? '✓ 系统就绪，可以开始实验' : '系统未就绪';
    banner.classList.toggle('ok', all);
    $('readyGrid').innerHTML = checks.map(([k, ok]) =>
      kv(k, ok ? '✓' : '—', ok ? 'good' : '')).join('') +
      (sim.totalTime != null
        ? kv('总耗时', fmtTime(sim.totalTime), 'good') + kv('稳定恢复时间', Math.round(sim.settleDuration / 60) + ' min', 'good')
        : kv('已运行', fmtTime(sim.t), '') + kv('剩余稳定保持', Math.max(0, 15 - Math.floor(sim.stableFor / 60)) + ' min', ''));
  }

  function renderLines(sim) {
    const box = $('lineControls');
    if (!box.dataset.built) {
      box.innerHTML = '';
      sim.groups.forEach((gs, gi) => {
        const def = GROUPS[gi];
        const row = document.createElement('div');
        row.className = 'line-row';
        row.dataset.g = gs.id;
        row.innerHTML =
          '<div class="line-top"><div class="line-title">' + gs.name +
            '<div class="pulse-badge"></div></div>' +
          '<label class="switch"><input type="checkbox"><i></i></label></div>' +
          '<div class="line-stats"><span class="n-noise"></span><span class="n-mxc"></span></div>' +
          '<div class="line-actions">' +
            '<button data-act="pulse" data-dur="120" data-frac="0.3">弱脉冲 2min</button>' +
            '<button data-act="pulse" data-dur="300" data-frac="1">脉冲 5min</button>' +
            '<button data-act="pulse" data-dur="600" data-frac="1">强脉冲 10min</button>' +
          '</div>';
        row.querySelector('input').addEventListener('change', e => {
          sim.toggleGroup(gs.id, e.target.checked); renderAll();
        });
        row.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
          const ok = sim.pulse(gs.id, parseInt(b.dataset.dur, 10), parseFloat(b.dataset.frac));
          if (ok) toast(gs.name + '：脉冲已排程，热量按级间延迟逐级传导');
          renderAll();
        }));
        box.appendChild(row);
      });
      box.dataset.built = '1';
    }
    sim.groups.forEach((gs, gi) => {
      const row = box.children[gi];
      const input = row.querySelector('input');
      if (input.checked !== gs.enabled) input.checked = gs.enabled;
      const pulsing = sim.t < gs.activeUntil;
      const remain = Math.max(0, gs.activeUntil - sim.t);
      row.querySelector('.pulse-badge').textContent =
        pulsing ? '● 脉冲中 ' + Math.ceil(remain / 60) + 'min @' + Math.round(gs.pulseFrac * 100) + '%' : '';
      const n = sim.noiseTemp(gs);
      row.querySelector('.n-noise').textContent = '噪声 ' + n.toFixed(0) + ' mK';
      row.querySelector('.n-noise').style.color = n > 300 ? 'var(--red)' : 'var(--muted)';
      row.querySelector('.n-mxc').textContent = 'MXC 热沉积 ' +
        (pulsing
          ? (defOn(gs.id)[4] + (defPulse(gs.id)[4] - defOn(gs.id)[4]) * gs.pulseFrac) * 1e9
          : defIdle(gs.id)[4] * 1e9).toFixed(0) + ' nW';
      row.querySelectorAll('button').forEach(b => b.disabled = !gs.enabled);
    });
  }
  function defOn(id) { return GROUPS.find(g => g.id === id).on; }
  function defIdle(id) { return GROUPS.find(g => g.id === id).idle; }
  function defPulse(id) { return GROUPS.find(g => g.id === id).pulse; }

  function renderCals(sim) {
    const box = $('calControls');
    if (!box.dataset.built) {
      box.innerHTML = '';
      CALS.forEach(c => {
        const row = document.createElement('div');
        row.className = 'cal-row';
        row.dataset.c = c.id;
        row.innerHTML =
          '<div><div class="cal-name">' + c.name + '</div>' +
          '<div class="cal-desc">' + c.desc + ' · ' + Math.round(c.dur / 60) + 'min · 门限 ' +
          (c.gate * 1000) + 'mK · 需稳定 ' + Math.round(c.settle / 60) + 'min</div></div>' +
          '<button>开始</button><div class="cal-status"></div><div class="cal-bar"><div></div></div>';
        row.querySelector('button').addEventListener('click', () => {
          const ok = sim.startCal(c.id);
          if (ok) toast(c.name + ' 开始');
          renderAll();
        });
        box.appendChild(row);
      });
      box.dataset.built = '1';
    }
    sim.cals.forEach((c, i) => {
      const row = box.children[i];
      const map = { done: '✓ 有效', running: '校准中…', invalid: '✗ 已失效，需重做', pending: '待执行' };
      const st = row.querySelector('.cal-status');
      st.textContent = map[c.status] +
        (c.status === 'invalid' && c.note ? '：' + c.note : '');
      st.className = 'cal-status ' + c.status;
      row.classList.remove('done', 'running', 'invalid', 'pending');
      row.classList.add(c.status);
      const def = CALS[i];
      let pct = 0;
      if (c.status === 'done') pct = 100;
      else if (c.status === 'running') pct = Math.min(100, (sim.t - c.startTime) / def.dur * 100);
      row.querySelector('.cal-bar > div').style.width = pct + '%';
      row.querySelector('button').textContent =
        c.status === 'running' ? '进行中' : c.status === 'done' ? '重新校准' :
        c.status === 'invalid' ? '返工校准' : '开始';
      row.querySelector('button').disabled = c.status === 'running';
    });
  }

  // ---------- 检查点 / 策略派生 ----------
  function renderCheckpoints(sim) {
    const box = $('checkpointList');
    box.innerHTML = '';
    if (!sim.checkpoints.length) {
      box.innerHTML = '<div class="hint">暂无检查点</div>';
      return;
    }
    sim.checkpoints.forEach((cp, idx) => {
      const item = document.createElement('div');
      item.className = 'cp-item';
      const mxc = cp.temp[4];
      item.innerHTML = '<span>#' + idx + ' ' + cp.label + ' · MXC ' +
        (mxc >= 1 ? mxc.toFixed(1) + 'K' : (mxc * 1000).toFixed(1) + 'mK') + '</span>';
      const fork = document.createElement('span');
      fork.className = 'cp-fork';
      Object.keys(STRATEGIES).forEach(key => {
        const b = document.createElement('button');
        b.textContent = { standard: '标准', conservative: '保守', aggressive: '激进' }[key];
        b.title = '从此检查点派生：' + STRATEGIES[key]().name;
        b.addEventListener('click', () => forkStrategy(idx, key));
        fork.appendChild(b);
      });
      item.appendChild(fork);
      box.appendChild(item);
    });
  }

  function forkStrategy(cpIdx, key) {
    const src = active();
    const st = STRATEGIES[key]();
    const child = src.fork(cpIdx, key);
    child.name = st.name + ' · 自 ' + fmtTime(src.checkpoints[cpIdx].t);
    child.runFast(24 * 3600);
    registerRun(child);
    toast('已从检查点派生并离线推演：' + child.name);
    renderCompare();
    renderAll();
  }

  function renderCompare() {
    const box = $('strategyStats');
    const done = state.runs
      .map(r => r.sim)
      .filter(s => s.finished || s.ready)
      .map(s => ({ s, st: s.stats() }));
    if (done.length < 2) { box.innerHTML = ''; return; }
    const bestTotal = Math.min.apply(null, done.filter(d => d.st.total != null).map(d => d.st.total));
    const bestSettle = Math.min.apply(null, done.filter(d => d.st.settleTime != null).map(d => d.st.settleTime));
    const rows = done.map(d => {
      const st = d.st;
      return '<tr class="' + (st.total === bestTotal && st.ready ? 'best' : '') + '">' +
        '<td title="' + st.strategy + '">' + shortName(st.name) + '</td>' +
        '<td>' + (st.total != null ? fmtTime(st.total) : '未就绪') + '</td>' +
        '<td>' + (st.settleTime != null ? Math.round(st.settleTime / 60) + 'min' : '—') + '</td>' +
        '<td>' + st.rebounds + '</td>' +
        '<td>' + st.invalidations + '</td>' +
        '<td>' + (st.maxNoise || 0).toFixed(0) + '</td>' +
        '<td>' + (st.ready ? '✓' : '✗') + '</td></tr>';
    }).join('');
    box.innerHTML = '<table><thead><tr><th>分支</th><th>总耗时</th><th>稳定时间</th>' +
      '<th>反弹</th><th>校准作废</th><th>峰值噪声</th><th>就绪</th></tr></thead><tbody>' +
      rows + '</tbody></table>';
  }
  function shortName(n) {
    return n.replace(' · 自 ', ' @').replace('降温策略', '').replace('（派生）', '');
  }

  // ---------- 事件日志 ----------
  function renderEvents(sim) {
    const box = $('eventLog');
    const want = state.filter;
    const evs = sim.events.filter(e => {
      if (want === 'all') return true;
      if (want === 'warn') return e.type === 'warn' || e.type === 'rebound' || e.type === 'invalidate';
      if (want === 'sensor') return e.type === 'sensor';
      return true;
    }).slice(-120);
    const atBottom = box.scrollTop + box.clientHeight > box.scrollHeight - 30;
    box.innerHTML = evs.map(e =>
      '<div class="ev ' + e.type + '"><span class="et">' + fmtTime(e.t) +
      '</span><span class="ex">' + escapeHtml(e.text) + '</span></div>').join('');
    if (atBottom) box.scrollTop = box.scrollHeight;
  }
  function escapeHtml(s) {
    return s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }

  // ---------- 传感器异常菜单 ----------
  function openSensorMenu(ev, stageIdx) {
    const menu = $('sensorMenu');
    const sim = active();
    const st = STAGES[stageIdx];
    const sn = sim.sensors[stageIdx];
    menu.innerHTML = '<h3>' + st.name + ' 传感器注入</h3>';
    const add = (label, fn, disabled) => {
      const b = document.createElement('button');
      b.textContent = label;
      if (disabled) b.disabled = true;
      b.addEventListener('click', () => { fn(); menu.classList.add('hidden'); renderAll(); });
      menu.appendChild(b);
    };
    add('模拟迟到数据（+5min 通信延迟）', () => {
      sim.injectLatency(st.id, 300);
      toast('读数将延迟 5 分钟到达，按真实采集时刻回填图表');
    });
    add('冻结读数（卡死在当前值）', () => sim.injectFailure(st.id, 'frozen'));
    add('漂移故障（+10%/h）', () => sim.injectFailure(st.id, 'drift',
      st.id === 'mxc' ? 0.001 : st.target * 0.1));
    add('断线（无读数）', () => sim.injectFailure(st.id, 'dead'));
    add('恢复传感器（按真实值重新判定）', () => {
      sim.recoverSensor(st.id);
      toast('传感器恢复：门限与校准已按真实温度重新评估');
    }, sn.mode === 'ok' && !sn.pending.length);
    menu.style.left = Math.min(ev.clientX, window.innerWidth - 250) + 'px';
    menu.style.top = Math.min(ev.clientY, window.innerHeight - 240) + 'px';
    menu.classList.remove('hidden');
  }
  document.addEventListener('click', e => {
    if (!e.target.closest('.ctx-menu') && !e.target.closest('.stage-row'))
      $('sensorMenu').classList.add('hidden');
  });

  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
  }

  // ---------- 图表 ----------
  function renderCharts(sim) {
    tempChart($('tempChart'), sim);
    overlaySensorGaps(sim);
    lineChart($('noiseChart'), sim, {
      fmt: v => v.toFixed(0),
      build: hist => GROUPS.map((g, gi) => ({
        label: g.name,
        color: ['#4dabf7', '#9775fa', '#63e6be', '#ffa94d'][gi],
        points: hist.map(p => ({ x: p.t, y: p.temp[4] < 0.1 ? p.noise[gi] : null }))
      })).concat([{
        label: '门限 300mK', color: '#ff8787', dash: true,
        points: hist.map(p => ({ x: p.t, y: 300 }))
      }])
    });
    gantt($('ganttChart'), sim);
  }

  // 在温度图上用虚线绘制传感器“显示读数”（冻结/漂移/缺口），与真值对比
  function overlaySensorGaps(sim) {
    const svg = $('tempChart');
    // 简化：仅在存在异常时给整张图加标注（完整缺口回放依赖每步读数，已在事件日志体现）
    const bad = sim.sensors.map((sn, i) => ({ sn, i }))
      .filter(o => o.sn.mode !== 'ok' || o.sn.pending.length);
    bad.forEach(({ sn, i }) => {
      const w = svg.clientWidth || 800, h = svg.clientHeight || 240;
      const padL = 52, padR = 110, padT = 12, ih = h - 36;
      const tMax = Math.max(3600, sim.t);
      const x = padL + ((sn.failAt != null ? sn.failAt : sim.t) / tMax) * (w - padL - padR);
      const NS = 'http://www.w3.org/2000/svg';
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('x', Math.min(x + 3, w - padR - 70));
      t.setAttribute('y', padT + 12 + i * 12);
      t.setAttribute('font-size', '9');
      t.setAttribute('fill', '#ffa94d');
      t.textContent = STAGES[i].name + '：' + (sn.mode !== 'ok' ? sn.mode : '迟到缺口');
      svg.appendChild(t);
    });
  }

  // ---------- 总渲染 ----------
  function renderAll() {
    const sim = active();
    if (!sim) return;
    $('simClock').textContent = fmtTime(sim.t);
    const phase = currentPhase(sim);
    $('simPhase').textContent = phase;
    $('progressBar').style.width = Math.min(100, sim.t / (24 * 3600) * 100) + '%';
    renderFridge(sim);
    renderStability(sim);
    renderReadiness(sim);
    renderLines(sim);
    renderCals(sim);
    renderCheckpoints(sim);
    renderEvents(sim);
    renderCharts(sim);
    rebuildRunSelect();
  }

  function currentPhase(sim) {
    if (sim.ready) return '✓ 就绪 · ' + fmtTime(sim.readyAt);
    if (sim.T('pt50') > 55) return '降温：50K 级预冷中';
    if (sim.T('pt4') > 4.8) return '降温：4K 级制冷中';
    if (sim.T('still') > 0.95) return '降温：Still 运行中';
    if (sim.T('cp') > 0.085) return '降温：冷盘冷却中';
    if (sim.T('mxc') > 0.014) return '降温：MXC 趋近基温';
    if (sim.cals.some(c => c.status === 'running')) return '校准进行中';
    return '低温保持 / 稳定中';
  }

  // ---------- 回放循环 ----------
  function frame(ts) {
    const sim = active();
    if (sim && state.playing && !sim.finished) {
      const dtReal = Math.min(0.5, (ts - state.lastFrame) / 1000 || 0);
      const seconds = dtReal * state.speed;
      sim.advance(seconds);
      if (sim.ready || sim.finished) {
        state.playing = false;
        $('btnPlay').textContent = '▶ 继续';
        if (sim.ready) toast('系统就绪！总耗时 ' + fmtTime(sim.readyAt) +
          '，最后一段稳定恢复用 ' + Math.round(sim.settleDuration / 60) + ' 分钟');
      }
      renderAll();
    }
    state.lastFrame = ts;
    requestAnimationFrame(frame);
  }

  // ---------- 绑定 ----------
  function bind() {
    $('btnPlay').addEventListener('click', () => {
      const sim = active();
      if (sim.finished) { toast('该分支已结束，请重置或派生新策略'); return; }
      state.playing = true;
      $('btnPlay').textContent = '▶ 运行中';
    });
    $('btnPause').addEventListener('click', () => {
      state.playing = false;
      $('btnPlay').textContent = '▶ 继续';
    });
    $('btnStep').addEventListener('click', () => { active().advance(60); renderAll(); });
    $('btnFast').addEventListener('click', () => {
      const sim = active();
      state.playing = false;
      sim.runFast(24 * 3600);
      $('btnPlay').textContent = '▶ 已结束';
      toast(sim.ready ? '快进完成：就绪于 ' + fmtTime(sim.readyAt) : '快进结束：24h 内未就绪');
      renderCompare();
      renderAll();
    });
    $('btnReset').addEventListener('click', () => {
      state.runs = state.runs.filter(r => r.id !== state.activeId);
      if (!state.runs.length) newRun();
      else state.activeId = state.runs[0].id;
      state.playing = false;
      $('btnPlay').textContent = '▶ 运行';
      renderCompare();
      renderAll();
    });
    document.querySelectorAll('.speed-group button').forEach(b =>
      b.addEventListener('click', () => {
        state.speed = parseInt(b.dataset.speed, 10);
        document.querySelectorAll('.speed-group button').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
      }));
    document.querySelectorAll('.filter-group button').forEach(b =>
      b.addEventListener('click', () => {
        state.filter = b.dataset.filter;
        document.querySelectorAll('.filter-group button').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        renderAll();
      }));
    $('runSelect').addEventListener('change', e => {
      state.activeId = e.target.value;
      state.playing = false;
      $('btnPlay').textContent = '▶ 运行';
      renderAll();
    });
    $('btnCheckpoint').addEventListener('click', () => {
      active().checkpoint();
      toast('检查点已保存，可派生多种降温策略');
      renderAll();
    });
    $('btnCompareAll').addEventListener('click', compareAllFromStart);
    window.addEventListener('resize', () => renderCharts(active()));
  }

  function compareAllFromStart() {
    Object.keys(STRATEGIES).forEach(key => {
      const st = STRATEGIES[key]();
      const sim = new Sim({ seed: 42, strategyId: st.id, strategyName: st.name,
        plan: st.plan, name: st.name });
      sim.runFast(24 * 3600);
      registerRun(sim);
    });
    toast('已从同一 300K 起点离线推演三种策略，见右下方对比表');
    renderCompare();
    renderAll();
  }

  // ---------- 启动 ----------
  newRun();
  bind();
  renderAll();
  requestAnimationFrame(frame);

  // 调试/自动化钩子
  window.__app = {
    state, active, newRun, registerRun, renderAll,
    play: () => { state.playing = true; $('btnPlay').textContent = '运行中'; },
    pause: () => { state.playing = false; },
    compare: () => $('btnCompareAll').click()
  };
})();
