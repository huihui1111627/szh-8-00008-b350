/* 轻量 SVG 图表（无外部依赖） */
(function (global) {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';

  function el(name, attrs) {
    const e = document.createElementNS(NS, name);
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function fmtT(t) {
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60);
    return h + ':' + String(m).padStart(2, '0');
  }
  function fmtK(v) { return v >= 1 ? v.toFixed(1) + 'K' : (v * 1000).toFixed(1) + 'mK'; }

  // 对称对数坐标：300K → 4mK
  function logT(v) { return Math.log(Math.max(v, 0.002)); }
  const LMIN = logT(0.004), LMAX = logT(320);

  function yTemp(v, h) {
    return h - ((logT(v) - LMIN) / (LMAX - LMIN)) * h;
  }

  function tempChart(svg, sim, opts) {
    opts = opts || {};
    clear(svg);
    const w = svg.clientWidth || 800, h = svg.clientHeight || 240;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    const padL = 52, padR = 110, padT = 12, padB = 24;
    const iw = w - padL - padR, ih = h - padT - padB;
    const hist = sample(sim.history, Math.min(900, sim.history.length));
    const tMax = Math.max(3600, sim.t || 3600);
    const X = t => padL + (t / tMax) * iw;
    const Y = v => padT + yTemp(v, ih);

    // 网格/刻度
    const grids = [300, 100, 50, 10, 4, 1, 0.3, 0.1, 0.03, 0.01, 0.005];
    for (const gv of grids) {
      const y = Y(gv);
      svg.appendChild(el('line', { x1: padL, x2: padL + iw, y1: y, y2: y,
        stroke: 'rgba(120,140,170,0.18)', 'stroke-dasharray': '2 3' }));
      const t = el('text', { x: padL - 6, y: y + 3, 'text-anchor': 'end',
        'font-size': 9, fill: '#8294ab' });
      t.textContent = fmtK(gv);
      svg.appendChild(t);
    }
    for (let hh = 0; hh <= 24; hh += 3) {
      const x = X(hh * 3600);
      if (x > padL + iw) break;
      const t = el('text', { x, y: h - 7, 'text-anchor': 'middle', 'font-size': 9, fill: '#8294ab' });
      t.textContent = hh + 'h';
      svg.appendChild(t);
    }

    // 事件标记（反弹/失效/校准/脉冲）
    const typeColor = { rebound: '#ff6b6b', invalidate: '#ff9f43', cal: '#5ed4a1',
      pulse: '#4dabf7', line: '#9775fa', ready: '#69db7c', sensor: '#ffa94d' };
    for (const ev of sim.events) {
      if (!typeColor[ev.type]) continue;
      const x = X(ev.t);
      if (x < padL || x > padL + iw) continue;
      svg.appendChild(el('line', { x1: x, x2: x, y1: padT, y2: padT + ih,
        stroke: typeColor[ev.type], 'stroke-width': 0.8, opacity: 0.55,
        'stroke-dasharray': ev.type === 'pulse' ? '1 2' : '3 2' }));
    }

    // 曲线：真值（半透明虚线）+ 显示读数（实线，故障期变黄、缺口断开）
    const colors = ['#74c0fc', '#4dabf7', '#63e6be', '#ffa94d', '#ff8787'];
    for (let i = 0; i < 5; i++) {
      let dTruth = '', dShown = '', pen = false;
      hist.forEach((p, k) => {
        dTruth += (k ? 'L' : 'M') + X(p.t).toFixed(1) + ' ' + Y(p.temp[i]).toFixed(1) + ' ';
      });
      // 显示读数需要 sim 在对应时刻的传感器状态；用当前状态近似绘制最近一段
      const rd = sim.sensorReading(i);
      if (rd.status === 'live' || rd.status === 'drift') {
        hist.forEach((p, k) => {
          dShown += (k ? 'L' : 'M') + X(p.t).toFixed(1) + ' ' + Y(p.temp[i]).toFixed(1) + ' ';
        });
      } else if (rd.status === 'frozen') {
        // 真值虚线 + 冻结水平线（从 failAt 起）
        hist.forEach(p => { /* truth already drawn */ });
      }
      svg.appendChild(el('path', { d: dTruth, fill: 'none',
        stroke: (rd.status === 'frozen' || rd.status === 'dead' || rd.status === 'gap') ? colors[i] : colors[i],
        'stroke-width': (rd.status === 'live' || rd.status === 'drift') ? 1.6 : 1,
        opacity: (rd.status === 'live' || rd.status === 'drift') ? 1 : 0.45,
        'stroke-dasharray': (rd.status === 'live' || rd.status === 'drift') ? null : '3 3' }));
      // 故障段叠加黄色显示轨迹
      if (rd.status === 'frozen' && sim.sensors[i].failAt != null) {
        const fv = sim.sensors[i].frozenValue;
        const x1 = X(sim.sensors[i].failAt);
        svg.appendChild(el('line', { x1, x2: X(sim.t), y1: Y(fv), y2: Y(fv),
          stroke: '#ffd43b', 'stroke-width': 1.8 }));
      }
      // 断线/读数缺口：当前段画黄色竖带提示“真实曲线仍在变化但暂不可见”
      if (rd.value == null) {
        const sn0 = sim.sensors[i];
        let gapStart = sim.t;
        if (rd.status === 'gap' && sn0.pending.length)
          gapStart = Math.min.apply(null, sn0.pending.map(p => p.collectAt));
        else if (sn0.failAt != null) gapStart = sn0.failAt;
        svg.appendChild(el('rect', { x: X(gapStart), y: 0,
          width: Math.max(2, X(sim.t) - X(gapStart)), height: 9999,
          fill: '#ffd43b', opacity: 0.06 }));
        svg.appendChild(el('circle', { cx: X(sim.t) - 2, cy: Y(sim.temp[i]),
          r: 3, fill: 'none', stroke: '#ffd43b', 'stroke-width': 1.5 }));
      }
      const t = el('text', { x: padL + iw + 6, y: Y(hist.length ? hist[hist.length - 1].temp[i] : 300) + 3,
        'font-size': 9, fill: (rd.status === 'live' || rd.status === 'drift') ? colors[i] : '#ffd43b' });
      t.textContent = CryoSim.STAGES[i].name;
      svg.appendChild(t);
    }

    // 当前时间游标
    const cx = X(sim.t);
    svg.appendChild(el('line', { x1: cx, x2: cx, y1: padT, y2: padT + ih, stroke: '#e9ecef', 'stroke-width': 1 }));
    return { X, Y };
  }

  function sample(arr, n) {
    if (arr.length <= n) return arr;
    const out = []; const step = arr.length / n;
    for (let i = 0; i < n; i++) out.push(arr[Math.floor(i * step)]);
    out.push(arr[arr.length - 1]);
    return out;
  }

  // 线性坐标通用图（噪声 mK / 热负荷 µW / 稳定分）
  function lineChart(svg, sim, pick) {
    clear(svg);
    const w = svg.clientWidth || 760, h = svg.clientHeight || 150;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    const padL = 52, padR = 110, padT = 12, padB = 22;
    const iw = w - padL - padR, ih = h - padT - padB;
    const hist = sample(sim.history, 700);
    let series = pick.build(hist);
    let ymax = 1;
    series.forEach(sr => sr.points.forEach(p => { if (p.y != null && p.y < 1e6) ymax = Math.max(ymax, p.y); }));
    ymax *= 1.15;
    const tMax = Math.max(3600, sim.t);
    const X = t => padL + (t / tMax) * iw;
    const Y = v => padT + ih - (v / ymax) * ih;

    for (let g = 0; g <= 4; g++) {
      const y = padT + ih - (g / 4) * ih;
      svg.appendChild(el('line', { x1: padL, x2: padL + iw, y1: y, y2: y,
        stroke: 'rgba(120,140,170,0.15)', 'stroke-dasharray': '2 3' }));
      const t = el('text', { x: padL - 6, y: y + 3, 'text-anchor': 'end', 'font-size': 9, fill: '#8294ab' });
      t.textContent = pick.fmt ? pick.fmt(ymax * g / 4) : (ymax * g / 4).toFixed(0);
      svg.appendChild(t);
    }

    series.forEach((sr, si) => {
      let d = '', gapStart = null;
      sr.points.forEach((p, k) => {
        if (p.y == null) { if (!gapStart) gapStart = k; return; }
        if (gapStart) gapStart = null;
        d += (d && sr.points[k - 1] && sr.points[k - 1].y != null ? 'L' : 'M') +
          X(p.x).toFixed(1) + ' ' + Y(p.y).toFixed(1) + ' ';
      });
      svg.appendChild(el('path', { d, fill: 'none', stroke: sr.color, 'stroke-width': 1.5,
        'stroke-dasharray': sr.dash ? '4 3' : null }));
      const last = sr.points.filter(p => p.y != null).slice(-1)[0];
      if (last) {
        const t = el('text', { x: padL + iw + 6, y: Y(last.y) + 3, 'font-size': 9, fill: sr.color });
        t.textContent = sr.label;
        svg.appendChild(t);
      }
    });
    const cx = X(sim.t);
    svg.appendChild(el('line', { x1: cx, x2: cx, y1: padT, y2: padT + ih, stroke: '#e9ecef' }));
  }

  // 甘特/时间线：降温阶段、线路启停、校准、脉冲
  function gantt(svg, sim) {
    clear(svg);
    const rows = [];
    CryoSim.STAGES.forEach(s => rows.push({ id: 'stg:' + s.id, label: s.name, color: '#4dabf7' }));
    CryoSim.GROUPS.forEach(g => rows.push({ id: 'grp:' + g.id, label: g.name, color: '#9775fa' }));
    CryoSim.CALS.forEach(c => rows.push({ id: 'cal:' + c.id, label: c.name, color: '#5ed4a1' }));

    const w = svg.clientWidth || 760, h = Math.max(180, rows.length * 22 + 34);
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    const padL = 110, padR = 12, padT = 8, rh = (h - 28) / rows.length;
    const iw = w - padL - padR;
    const tMax = Math.max(3600, sim.t);
    const X = t => padL + (t / tMax) * iw;

    rows.forEach((r, i) => {
      const y = padT + i * rh;
      const t = el('text', { x: padL - 6, y: y + rh * 0.72, 'text-anchor': 'end', 'font-size': 9, fill: '#c5d0e0' });
      t.textContent = r.label; svg.appendChild(t);
      svg.appendChild(el('line', { x1: padL, x2: padL + iw, y1: y + rh - 3, y2: y + rh - 3,
        stroke: 'rgba(120,140,170,0.15)' }));
    });

    // 温区到达时刻（从历史推断）
    CryoSim.STAGES.forEach((s, si) => {
      const reached = firstWhen(sim, p => p.temp[si] <= s.ready);
      if (reached != null) bar('stg:' + s.id, 0, reached, 'rgba(77,171,247,0.18)');
      bar('stg:' + s.id, reached != null ? reached : 0, sim.t, reached != null ? 'rgba(77,171,247,0.55)' : 'rgba(120,130,150,0.25)');
    });
    // 线路：从最近一次开启事件到现在（简化为事件扫描）
    const onAt = {};
    CryoSim.GROUPS.forEach(g => onAt[g.id] = sim.groups.find(x => x.id === g.id).enabled ? 0 : null);
    sim.events.forEach(ev => {
      for (const g of CryoSim.GROUPS) {
        if (ev.text.indexOf(g.name) >= 0) {
          if (ev.text.indexOf('开启') >= 0) onAt[g.id] = ev.t;
          if (ev.text.indexOf('关停') >= 0) { if (onAt[g.id] != null) { bar('grp:' + g.id, onAt[g.id], ev.t, 'rgba(151,117,250,0.4)'); onAt[g.id] = null; } }
        }
      }
    });
    for (const gid in onAt) if (onAt[gid] != null) bar('grp:' + gid, onAt[gid], sim.t, 'rgba(151,117,250,0.55)');

    // 脉冲条：从组 activeUntil 反推不可靠；用事件画短标记
    sim.events.filter(e => e.type === 'pulse').forEach(ev => {
      const m = ev.text.match(/(\d+)min/);
      const dur = m ? parseInt(m[1], 10) * 60 : 300;
      for (const g of CryoSim.GROUPS) if (ev.text.indexOf(g.name) >= 0)
        bar('grp:' + g.id, ev.t, ev.t + dur, '#4dabf7');
    });

    // 校准
    sim.cals.forEach(c => {
      if (c.startTime != null) {
        const def = CryoSim.CALS.find(d => d.id === c.id);
        const end = c.endTime || (c.status === 'invalid' ? c.invalidatedAt : sim.t);
        const color = c.status === 'done' ? '#5ed4a1' : c.status === 'invalid' ? '#ff8787' :
          c.status === 'running' ? '#ffd43b' : '#868e96';
        bar('cal:' + c.id, c.startTime, end, color);
        if (c.status === 'invalid' && c.invalidatedAt != null && c.endTime != null) {
          // 返工段
        }
      }
    });

    for (let hh = 0; hh <= 24; hh += 3) {
      const x = X(hh * 3600);
      if (x > padL + iw) break;
      const t = el('text', { x, y: h - 8, 'text-anchor': 'middle', 'font-size': 9, fill: '#8294ab' });
      t.textContent = hh + 'h'; svg.appendChild(t);
    }

    function bar(rowId, t1, t2, color) {
      const ri = rows.findIndex(r => r.id === rowId);
      if (ri < 0 || t1 == null) return;
      t2 = Math.max(t2, t1 + 60);
      svg.appendChild(el('rect', { x: X(t1), y: padT + ri * rh + 2,
        width: Math.max(2, X(t2) - X(t1)), height: rh - 7, rx: 2, fill: color, opacity: 0.9 }));
    }
  }

  function firstWhen(sim, fn) {
    for (const p of sim.history) if (fn(p)) return p.t;
    return null;
  }

  global.CryoCharts = { tempChart, lineChart, gantt, fmtK, fmtT };
})(window);
