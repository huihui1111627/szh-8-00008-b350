/* 主控制器：阶段机 / 线路与脉冲 / 校准 / 稳定性与反弹 / 检查点与策略分支。 */
'use strict';

class Controller {
  constructor(shadow = false) {
    this.shadow = shadow;
    this.reset();
  }

  reset() {
    this.model = new ThermalModel();
    this.sensors = new SensorSystem();
    this.phaseIdx = 0;
    this.phaseT = 0;
    this.rampState = { p50: 0, p4: 0, still: 0, mxc: 0 };
    this.lines = { dc: false, mw: false, ro: false };
    this.running = false;
    this.autoAdvance = true;   // 主时间线：门限满足自动推进（可在界面关闭改为手动）
    this.stable = false;
    this.stableFor = 0;
    this.unstableFor = 0;
    this.everStable = false;
    this.gateAcc = [0, 0];
    this.baseEntryTime = null;
    this.minMxc = Infinity;
    this.reboundArm = false;
    this.pulseNoise = 0;
    this.cals = [];
    this.calSeq = 0;
    this.checkpoints = [];
    this.branches = [];
    this.ckSeq = 0;
    this.lastPenalty = null;
    this.series = { t: [], mxc: [], disp: { p50: [], p4: [], still: [], mxc: [] },
      est: { mxc: [] }, noise: [], flux: [[], [], [], []],
      phaseMark: [], pulseMark: [], flagMark: [] };
    this.sampleAcc = CFG.uiSampleEvery - 1; // 首秒即记录初始点
    this.autoMode = null;   // {extraSettle, stage, actionsDone}
  }

  get phaseId() { return CFG.phases[this.phaseIdx].id; }
  get time() { return this.model.time; }

  /* ---------- 负载 / 噪声 ---------- */
  currentLoads() {
    const load = { p50: 0, p4: 0, still: 0, mxc: 0 };
    for (const ln of CFG.lines) {
      const set = this.lines[ln.id] ? ln.on : ln.off;
      for (const k of Object.keys(load)) load[k] += set[k] || 0;
    }
    return load;
  }

  lineNoiseAdd() {
    let n = 0;
    for (const ln of CFG.lines) n += this.lines[ln.id] ? ln.noiseOn : ln.noiseOff;
    return n;
  }

  toggleLine(id, on) {
    if (this.lines[id] === on) return;
    this.lines[id] = on;
    const ln = CFG.lines.find(l => l.id === id);
    const hot = this.model.t.mxc < 0.1;
    this.log(on ? 'info' : 'ok', 'LINE',
      `${ln.name} 已${on ? '接通' : '断开'}（MXC 热负载 ${(on ? ln.on.mxc : ln.off.mxc)} nW）` +
      (on && hot ? '；低温下接线可能引起温度反弹，密切观察 MXC' : ''));
  }

  injectPulse(groupId, nW) {
    const ln = CFG.lines.find(l => l.id === groupId);
    // 衰减链：脉冲在各级耗散，MXC 处按额定幅度
    this.model.setLoads(this.currentLoads(), { mxc: nW, still: nW * 1.6, p4: nW * 3.2 });
    this.pulseNoise = Math.min(900, this.pulseNoise + nW * 7);
    this.series.pulseMark.push(this.time);
    this.log('warn', 'PULSE',
      `向 ${ln.name} 注入 ${nW} nW 脉冲；热量经衰减链逐级沉积（MXC ${nW} / Still ${nW * 1.6} / 4K ${nW * 3.2} nW），约 1 分钟消退`);
  }

  /* ---------- 阶段机 ---------- */
  rampNow() {
    const target = CFG.phases[this.phaseIdx].ramp;
    const out = {};
    for (const k of ['p50', 'p4', 'still', 'mxc']) {
      const tgt = target[k] || 0;
      // 制冷能力以 60 s 时间常数爬升到阶段目标（机器重启/阀门动作的惯性）
      const f = 1 - Math.exp(-this.phaseT / 60);
      out[k] = tgt * f;
    }
    return out;
  }

  gateStatus() {
    const ph = CFG.phases[this.phaseIdx];
    if (!ph.gate.length) return { ready: false, gates: [] };
    const gates = ph.gate.map((g, i) => ({
      ...g, acc: this.gateAcc[i] || 0,
      ready: (this.gateAcc[i] || 0) >= g.settle,
    }));
    return { gates, ready: gates.every(g => g.ready) };
  }

  advancePhase(force = false) {
    if (this.phaseIdx >= CFG.phases.length - 1) {
      this.log('info', 'PHASE', '已处于最终阶段（基温稳定）');
      return false;
    }
    const gs = this.gateStatus();
    const ph = CFG.phases[this.phaseIdx];
    if (!force && ph.gate.length && !gs.ready) {
      this.log('warn', 'PHASE',
        `门限未满足，不能进入下一阶段：` +
        gs.gates.map(g => `${stageLabel(g.stage)} 需稳定 ${g.settle}s（已 ${Math.floor(g.acc)}s）`).join('；'));
      return false;
    }
    if (force && ph.gate.length && !gs.ready) {
      // 过快操作：未稳定即推进 → 混合气回流 / 热交换器失衡，热量回灌
      this.model.setLoads(this.currentLoads(), { mxc: 42, still: 900, p4: 3200 });
      this.pulseNoise = Math.min(900, this.pulseNoise + 480);
      const missing = gs.gates.map(g => `${stageLabel(g.stage)} 差 ${Math.ceil(g.settle - g.acc)}s`).join('，');
      this.lastPenalty = { time: this.time, missing };
      this.series.flagMark.push({ t: this.time, kind: 'penalty' });
      this.log('bad', 'PHASE',
        `⚠ 提前从「${ph.name}」推进，门限未达（${missing}）。热交换器失衡引发热量回灌：` +
        '预计 MXC 反弹约 100 mK、噪声飙升，若已校准将被标记失效');
    } else {
      this.log('phase', 'PHASE', `门限满足，进入「${CFG.phases[this.phaseIdx + 1].name}」`);
    }
    this.phaseIdx++;
    this.phaseT = 0;
    this.gateAcc = CFG.phases[this.phaseIdx].gate.map(() => 0);
    this.series.phaseMark.push(this.time);
    if (this.phaseId === 'base') {
      this.baseEntryTime = this.time;
      this.log('info', 'PHASE', '进入基温稳定阶段，开始评估 MXC 稳定性（门限 35 mK / 噪声 520 mK，保持 120 s）');
    }
    return true;
  }

  /* ---------- 校准 ---------- */
  startCal(type) {
    if (this.phaseId !== 'base' || !this.stable) {
      this.log('warn', 'CAL', '校准需要在基温稳定后启动（MXC<35 mK 且噪声<520 mK 并保持 120 s）');
      return;
    }
    if (this.cals.some(c => c.status === 'running')) {
      this.log('warn', 'CAL', '已有校准任务进行中，请先等待或取消');
      return;
    }
    const dur = CFG.cal.durations[type];
    const names = { resonator: '谐振器频率标定', rabi: 'Rabi / π 脉冲标定', readout: '读取矩阵校准' };
    this.cals.push({ id: ++this.calSeq, type, name: names[type], start: this.time,
      dur, prog: 0, status: 'running', stalled: 0 });
    this.log('info', 'CAL', `开始「${names[type]}」，预计 ${dur}s；期间需持续稳定，强脉冲或温升会暂停甚至作废`);
  }

  cancelCal() {
    const c = this.cals.find(c => c.status === 'running');
    if (c) { c.status = 'invalid'; this.log('warn', 'CAL', `「${c.name}」已手动取消`); }
  }

  updateCals(dt) {
    for (const c of this.cals) {
      if (c.status !== 'running') continue;
      if (this.stable) { c.prog += dt; c.stalled = 0; }
      else {
        c.stalled += dt;
        if (c.stalled === dt) this.log('warn', 'CAL', `「${c.name}」因温区失稳暂停计时`);
        if (c.stalled > 90) {
          c.status = 'invalid';
          this.log('bad', 'CAL', `「${c.name}」中断超 90s 已作废，需重新校准`);
        }
      }
      if (c.prog >= c.dur && c.status === 'running') {
        c.status = 'valid'; c.end = this.time;
        this.log('ok', 'CAL', `「${c.name}」完成，参数有效（完成于 ${fmtClock(this.time)}）`);
      }
    }
  }

  invalidateCals(reason) {
    let n = 0;
    for (const c of this.cals) if (c.status === 'valid') { c.status = 'invalid'; n++; }
    if (n) this.log('bad', 'CAL', `${n} 项既有校准因${reason}失效，需重新执行`);
  }

  /* ---------- 稳定性 / 反弹 ---------- */
  monitorStability(dt, noise) {
    const m = this.model.t;
    const ok = m.mxc < CFG.stable.mxcBelow && m.still < CFG.stable.stillBelow
             && noise < CFG.stable.noiseBelow;
    if (ok) {
      this.stableFor += dt; this.unstableFor = 0;
      if (!this.stable && this.stableFor >= CFG.stable.hold) {
        this.stable = true; this.everStable = true;
        this.log('ok', 'STABLE',
          `系统达到稳定：MXC ${fmtT(m.mxc)}，噪声 ${noise.toFixed(0)} mK；可安排校准任务`);
      }
    } else {
      this.unstableFor += dt;
      if (this.stableFor > 0 && this.unstableFor > CFG.stable.rearm) {
        if (this.stable) this.log('warn', 'STABLE', '稳定性丧失，重新计时（迟滞 180 s）');
        this.stable = false; this.stableFor = 0;
      }
    }

    if (this.phaseId === 'base') {
      // 基准只在已冷却到 50mK 以下后追踪，避免入场降温误判反弹；每次告警冷却 300s
      if (m.mxc < 0.05) {
        this.minMxc = this.minMxc === Infinity ? m.mxc : Math.min(this.minMxc, m.mxc);
        this.reboundArm = true;
      }
      this.reboundCooldown = (this.reboundCooldown || 0) - dt;
      if (this.reboundArm && m.mxc > this.minMxc + 0.018 && this.reboundCooldown <= 0) {
        this.series.flagMark.push({ t: this.time, kind: 'rebound' });
        this.log('bad', 'REBOUND',
          `温度反弹：MXC 由 ${fmtT(this.minMxc)} 升至 ${fmtT(m.mxc)}（Δ ${((m.mxc - this.minMxc) * 1000).toFixed(1)} mK）`);
        if (m.mxc > this.minMxc + 0.03) this.invalidateCals('温度反弹超过 30 mK');
        this.minMxc = m.mxc;
        this.reboundCooldown = 300;
      } else if (this.reboundArm && m.mxc <= this.minMxc + 0.018) {
        this.minMxc = Math.min(this.minMxc, m.mxc);
      }
      this.noiseBadCooldown = (this.noiseBadCooldown || 0) - dt;
      if (noise > CFG.stable.noiseBelow + 250 && this.noiseBadCooldown <= 0) {
        this.invalidateCals('噪声超限（>770 mK）');
        this.noiseBadCooldown = 300;
      }
    }
  }

  /* ---------- 数据完整性回调 ---------- */
  applyLateData(p) {
    // 迟到数据只补绘历史点（标记），不改当前控制状态；若迟到点落在一次校准窗口内则提示存疑
    this.series.flagMark.push({ t: p.ts, kind: 'late', until: p.ts + 30 });
    for (const c of this.cals) {
      if (c.status === 'valid' && c.start <= p.ts && p.ts <= (c.end || this.time)) {
        this.log('warn', 'DATA', `迟到点 T+${p.ts}s 落入「${c.name}」窗口，该项校准置信度下调`);
      }
    }
  }

  reconcileSensor(stage, bad) {
    if (bad) {
      let n = 0;
      for (const c of this.cals) if (c.status === 'valid' && c.end >= this.time - 600) {
        c.status = 'invalid'; n++;
      }
      if (n) this.log('bad', 'CAL', `传感器恢复对账失败，${n} 项近期校准标记为存疑并失效`);
    }
  }

  /* ---------- 主步 ---------- */
  step() {
    const dt = CFG.dt;
    const ramp = this.rampNow();
    this.model.setLoads(this.currentLoads(), null);
    this.model.step(ramp, this.phaseId);
    this.phaseT += dt;
    this.pulseNoise *= Math.exp(-dt / CFG.pulse.decay);

    // 门限计时
    const ph = CFG.phases[this.phaseIdx];
    if (ph.gate.length) {
      ph.gate.forEach((g, i) => {
        if (this.model.t[g.stage] < g.below) this.gateAcc[i] = (this.gateAcc[i] || 0) + dt;
        else this.gateAcc[i] = 0;
      });
    }

    const noise = this.model.noiseTemp(this.lineNoiseAdd(), this.pulseNoise);
    this.monitorStability(dt, noise);
    this.updateCals(dt);

    // 传感器链路（其内部事件需回填时间）
    const sev = this.sensors.tick(this.time, ramp);
    for (const e of sev) this.log(e.kind, e.code, e.msg);

    this.recordSample(noise);

    // 抽真空为无门限流程阶段：120s 后自动进入脉冲管降温
    if (!CFG.phases[this.phaseIdx].gate.length && this.phaseId === 'evac' && this.phaseT > 120) {
      this.advancePhase(false);
    }
    // 主时间线：门限满足自动推进（抽真空已在上面处理）
    if (!this.autoMode && this.autoAdvance && this.phaseId !== 'evac'
        && this.phaseIdx < CFG.phases.length - 1) {
      const gs2 = this.gateStatus();
      if (gs2.gates.length && gs2.ready) this.advancePhase(false);
    }
    // 自动策略（影子分支）
    if (this.autoMode) this.runAutoStrategy(noise);
  }

  recordSample(noise) {
    const t = this.time;
    this.sampleAcc++;
    if (this.sampleAcc < CFG.uiSampleEvery) {
      // 即使不画图也保留精简轨迹供分支叠加（每 30s）
      if (t % 30 === 0) { this.series.t.push(t); this.series.mxc.push(this.model.t.mxc); }
      return;
    }
    this.sampleAcc = 0;
    const s = this.series;
    s.t.push(t);
    s.disp.p50.push(this.sensors.getDisplay('p50', t).temp);
    s.disp.p4.push(this.sensors.getDisplay('p4', t).temp);
    s.disp.still.push(this.sensors.getDisplay('still', t).temp);
    const dm = this.sensors.getDisplay('mxc', t);
    s.disp.mxc.push(dm.temp);
    s.est.mxc.push(dm.mode === 'est' ? dm.temp : null);
    s.noise.push(noise);
    for (let i = 0; i < 4; i++) s.flux[i].push(this.model.flux[i]);
  }

  /* ---------- 检查点 ---------- */
  saveCheckpoint(label) {
    const cloneHist = (h) => {
      const c = new HistoryBuf(0);
      c.data = h.data.slice(-600);
      return c;
    };
    const snap = {
      id: ++this.ckSeq, label: label || `检查点 #${this.ckSeq}`,
      time: this.time, phaseIdx: this.phaseIdx, phaseT: this.phaseT,
      phaseName: CFG.phases[this.phaseIdx].name,
      temps: { ...this.model.t },
      t: { ...this.model.t },
      pulseHeat: { ...this.model.pulseHeat },
      hist: Object.fromEntries(Object.entries(this.model.hist).map(([k, v]) => [k, cloneHist(v)])),
      lines: { ...this.lines },
      rampState: { ...this.rampState },
      gateAcc: [...this.gateAcc],
      stable: this.stable, stableFor: this.stableFor, everStable: this.everStable,
      minMxc: this.minMxc, reboundArm: this.reboundArm,
      cals: this.cals.map(c => ({ ...c })),
      baseEntryTime: this.baseEntryTime,
    };
    this.checkpoints.push(snap);
    this.log('ok', 'CKPT', `已保存「${snap.label}」@ ${fmtClock(this.time)}（${snap.phaseName}，MXC ${fmtT(snap.t.mxc)}），可从此派生策略`);
    return snap;
  }

  latestCheckpoint() { return this.checkpoints[this.checkpoints.length - 1]; }

  forkFromCheckpoint(ck, strategy, asMain = false) {
    const st = CFG.strategies[strategy];
    const c = new Controller(true);
    c.model.t = { ...ck.t };
    c.model.hist = {};
    for (const [k, v] of Object.entries(ck.hist)) {
      c.model.hist[k] = new HistoryBuf(0);
      c.model.hist[k].data = v.data.slice();
    }
    c.model.pulseHeat = { ...ck.pulseHeat };
    c.model.time = ck.time;
    c.phaseIdx = ck.phaseIdx; c.phaseT = ck.phaseT;
    c.gateAcc = [...ck.gateAcc];
    c.lines = { ...ck.lines };
    c.stable = ck.stable; c.stableFor = ck.stableFor; c.everStable = ck.everStable;
    c.minMxc = ck.minMxc; c.reboundArm = ck.reboundArm;
    c.baseEntryTime = ck.baseEntryTime;
    c.cals = ck.cals.map(x => ({ ...x }));
    c.autoMode = { extraSettle: st.advanceExtraSettle, strategy, actionsDone: false,
      linePlan: { ...st.lines }, mxcOnBeforeBase: st.mxcOnBeforeBase };
    const id = this.branches.length + 1;
    const branch = {
      id, ckId: ck.id, strategy, label: `${st.label}策略 · ${ck.label}`,
      ctrl: c, status: 'queued', result: null,
    };
    this.branches.push(branch);
    this.log('phase', 'FORK',
      `从「${ck.label}」派生「${st.label}策略」并行推演（${st.desc}）`);
    return branch;
  }

  /* ---------- 自动策略执行（影子/主均可复用） ---------- */
  runAutoStrategy(noise) {
    const a = this.autoMode;
    // 激进策略脉冲管阶段即接通全部线路；标准/保守进基温前保持全断，基温后接 DC
    if (a.strategy === 'aggressive' && !a.actionsDone && this.phaseIdx >= 1) {
      for (const [id, on] of Object.entries(a.linePlan)) c2_setLine(this, id, on);
      a.actionsDone = true;
    }
    if (a.strategy !== 'aggressive' && this.phaseId === 'base' && !a.baseLinesDone) {
      a.baseLinesDone = true;
      c2_setLine(this, 'dc', true);
    }
    if (this.phaseIdx >= CFG.phases.length - 1) return;
    const gs = this.gateStatus();
    // extraSettle>0 保守：门限满足后再等待；<0 激进：未满足就强行推进
    const acc = Math.min(...gs.gates.map(g => g.acc));
    const settle = Math.max(...gs.gates.map(g => g.settle));
    if (a.extraSettle < 0) {
      if (acc >= Math.max(20, settle + a.extraSettle)) this.advancePhase(true);
    } else {
      if (gs.ready && acc >= settle + a.extraSettle) this.advancePhase(false);
    }
  }

  runBranchOffline(branch, maxSec = 14400) {
    const c = branch.ctrl;
    const start = c.time;
    let guard = 0;
    const out = { rebounded: false, penalty: false, minNoise: Infinity, minMxc: Infinity };
    const trajT = [], trajMxc = [];
    while (c.time - start < maxSec && guard++ < maxSec + 10) {
      c.step();
      if (c.time % 30 === 0) { trajT.push(c.time); trajMxc.push(c.model.t.mxc); }
      if (c.lastPenalty && !out.penalty) out.penalty = true;
      out.minMxc = Math.min(out.minMxc, c.model.t.mxc);
      const n = c.model.noiseTemp(c.lineNoiseAdd(), c.pulseNoise);
      out.minNoise = Math.min(out.minNoise, n);
      if (c.series.flagMark.some(f => f.kind === 'rebound')) out.rebounded = true;
      if (c.phaseId === 'base' && c.stable) break;
    }
    const st = CFG.strategies[branch.strategy];
    branch.status = c.stable ? 'stable' : 'timeout';
    branch.result = {
      total: c.time,
      toBase: c.baseEntryTime ?? c.time,
      stableAt: c.stable ? c.time : null,
      stableAfterBase: c.stable && c.baseEntryTime != null ? c.time - c.baseEntryTime : null,
      minMxc: out.minMxc, minNoise: out.minNoise,
      rebounded: out.rebounded, penalty: out.penalty,
      desc: st.desc,
      trajT, trajMxc,
    };
    this.log(branch.status === 'stable' ? 'ok' : 'warn', 'FORK',
      `「${branch.label}」推演完成：${branch.status === 'stable'
        ? `总耗时 ${fmtClock(c.time)}，基温后 ${fmtClock(branch.result.stableAfterBase)} 达稳`
        : `推演 ${maxSec}s 仍未达稳（MXC 最低 ${fmtT(out.minMxc)}）`}`);
    return branch;
  }

  log(kind, code, msg) {
    if (this.shadow && !SIM.verboseShadow) { /* 影子分支不污染主日志，结果另存 */ }
    SIM.events.push({ t: this.time, kind, code, msg });
    if (!this.shadow && SIM.ui) SIM.ui.appendEvent({ t: this.time, kind, code, msg });
  }
}

// 自动策略接线辅助（避免日志重复）
function c2_setLine(ctrl, id, on) {
  if (ctrl.lines[id] === on) return;
  ctrl.lines[id] = on;
  if (!ctrl.shadow) {
    const ln = CFG.lines.find(l => l.id === id);
    ctrl.log(on ? 'info' : 'ok', 'LINE', `策略动作：${ln.name} ${on ? '接通' : '断开'}`);
  }
}
