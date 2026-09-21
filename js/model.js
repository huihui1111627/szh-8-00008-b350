/*
 * CryoSim — 超导量子制冷运行仿真内核（无 DOM 依赖，可在 Node / 浏览器中运行）
 *
 * 建模要点：
 *  - 级温区用一阶热平衡 + 上级耦合，热传导按实际时间常数产生延迟；
 *  - 线路空闲/开启/脉冲逐级沉积热量，过快操作会导致下级（尤其 MXC）温度反弹；
 *  - 校准任务按温度/稳定门限调度，温度反弹或强脉冲会使其失效；
 *  - 传感器支持迟到数据（按真实采集时间回填）、冻结/漂移/断线故障与恢复；
 *  - 任意检查点可派生（fork）新策略；同一模型支持快进离线推演与实时步进。
 */
(function (global) {
  'use strict';

  const DT = 20;                       // 物理步长（秒）
  const MAX_T = 24 * 3600;             // 单局最长 24h

  // 温区（从室温到混合室）。参数含义：
  //  tau      制冷机作用时间常数（s），越大降温越慢
  //  frac     上级导热相对本级冷却能力的比例（很小：隔热支柱/多层绝热）
  //  base     静态热负荷（W）
  //  loadT    该级冷源在“正常负荷”下的温度（K）；ready 为就绪判定门限
  const STAGES = [
    // 线性级（机械制冷/PT）：冷却力 k(T0-T)；frac 为稳态级间漏热比例
    { id: 'pt50', name: '50K 级',   target: 50,  ready: 55,    tau: 900,  frac: 0.012, base: 6.0 },
    { id: 'pt4',  name: '4K 级',    target: 4.2, ready: 4.8,   tau: 1800, frac: 0.005, base: 0.20 },
    { id: 'still',name: 'Still',    target: 0.7, ready: 0.95,  tau: 2700, frac: 0.002, base: 4e-3 },
    // 非线性级（稀释级）：Pcool=kn(T²-T0²)，小热容 ctau；
    // gbridge=降温期桥电导(W/K)，leak=稳态微漏热比例
    { id: 'cp',   name: '冷盘 CP',  target: 25e-3, ready: 85e-3, tau: 3000,
      kn: 1.5e-3, ctau: 400, gbridge: 0.05, offK: 1.2, leak: 0.006, base: 0.2e-6 },
    { id: 'mxc',  name: '混合室 MXC', target: 8e-3, ready: 14e-3, tau: 3600,
      kn: 2.2e-4, ctau: 150, gbridge: 0.02, offK: 0.06, leak: 0.006, base: 5e-9 }
  ];

  // 线路组：向量按 STAGES 顺序给出各级热沉积（W）。
  // idle = 已接入但静默；on = 开控制电子学；pulse = 满功率脉冲（按比例插值）。
  const GROUPS = [
    {
      id: 'mw', name: '微波驱动 ×8',
      idle:  [1.2, 0.06, 6e-4, 4e-7, 5e-9],
      on:    [2.6, 0.14, 1.4e-3, 1.1e-6, 25e-9],
      pulse: [4.5, 0.30, 4.5e-3, 12e-6, 800e-9],
      noiseBase: 45 // mK（电子学噪声折算到器件端）
    },
    {
      id: 'flux', name: '磁通偏置 ×16',
      idle:  [0.2, 0.008, 8e-5, 2e-7, 5e-9],
      on:    [0.5, 0.025, 2e-4, 0.1e-6, 20e-9],
      pulse: [2.6, 0.16, 2.4e-3, 5e-6, 250e-9],
      noiseBase: 8
    },
    {
      id: 'ro', name: '读出链路 ×4',
      idle:  [1.0, 0.05, 5e-4, 3e-7, 5e-9],
      on:    [2.2, 0.12, 1.2e-3, 0.9e-6, 25e-9],
      pulse: [4.0, 0.26, 4.0e-3, 10e-6, 650e-9],
      noiseBase: 30
    },
    {
      id: 'dc', name: '直流偏置 ×24',
      idle:  [0.12, 0.006, 6e-5, 1e-7, 5e-9],
      on:    [0.3, 0.02, 1.5e-4, 0.08e-6, 15e-9],
      pulse: [1.4, 0.09, 1.3e-3, 2.5e-6, 150e-9],
      noiseBase: 5
    }
  ];

  // 校准任务：gate 为允许开始的 MXC 温度；settle 为开始前的稳定保持要求（s）。
  // gate 为硬门限（高于此温度物理上无法校准）；策略可在更冷、更稳定时再安排。
  const CALS = [
    { id: 'gate',  name: '门参数校准',  dur: 1800, gate: 25e-3, settle: 600,
      groups: ['flux'], desc: '扫描门脉冲幅值与串扰（微波经共用耦合器）' },
    { id: 'ro',    name: '读出校准',    dur: 1500, gate: 25e-3, settle: 600,
      groups: ['ro'], desc: 'IQ 混频 / 判别阈值' },
    { id: 'flux',  name: '磁通标定',    dur: 2100, gate: 15e-3, settle: 900,
      groups: ['flux'], desc: '频率-磁通曲线 / sweet spot' }
  ];

  // 可从检查点派生的策略模板。plan 条目：
  //  {wait: {kind:'mxc'|'cp'|'still'|'time', le?:K, stable?:s}, then: [动作]}
  //  动作：group_on / group_off / pulse{group,dur,frac} / cal{id}
  function standardStrategy() {
    return {
      id: 'standard', name: '标准降温策略',
      desc: 'MXC 到位即分批上电并连续校准，保持时间较短，最后做一次满功率脉冲验证。',
      plan: [
        { when: { kind: 'mxc', le: 0.012, stable: 300 }, then: [
          { op: 'group_on', group: 'flux' }, { op: 'group_on', group: 'dc' } ] },
        { when: { kind: 'stable', stable: 300 }, then: [{ op: 'cal', cal: 'gate' }] },
        { when: { kind: 'cal', id: 'gate', status: 'done' }, then: [{ op: 'cal', cal: 'flux' }] },
        // 磁通完成后接入微波/读出，做读出校准，最后以一次中等脉冲收尾
        { when: { kind: 'cal', id: 'flux', status: 'done' }, then: [
          { op: 'group_on', group: 'mw' }, { op: 'group_on', group: 'ro' } ] },
        { when: { kind: 'stable', stable: 300 }, then: [{ op: 'cal', cal: 'ro' }] },
        { when: { kind: 'cal', id: 'ro', status: 'done' }, then: [{ op: 'pulse', group: 'ro', dur: 120, frac: 0.5 }] }
      ]
    };
  }

  function conservativeStrategy() {
    return {
      id: 'conservative', name: '保守降温策略',
      desc: '全部线路等 MXC 到位后才接入；校准顺序进行，只用小幅脉冲做验证，温度不反弹。',
      plan: [
        { when: { kind: 'mxc', le: 0.011, stable: 1200 }, then: [
          { op: 'group_on', group: 'flux' }, { op: 'group_on', group: 'dc' } ] },
        { when: { kind: 'stable', stable: 600 }, then: [{ op: 'group_on', group: 'mw' }, { op: 'group_on', group: 'ro' }] },
        { when: { kind: 'stable', stable: 600 }, then: [{ op: 'cal', cal: 'gate' }] },
        { when: { kind: 'cal', id: 'gate', status: 'done' }, then: [{ op: 'cal', cal: 'ro' }] },
        { when: { kind: 'cal', id: 'ro', status: 'done' }, then: [{ op: 'cal', cal: 'flux' }] },
        { when: { kind: 'cal', id: 'flux', status: 'done' }, then: [{ op: 'pulse', group: 'ro', dur: 120, frac: 0.3 }] }
      ]
    };
  }

  function aggressiveStrategy() {
    return {
      id: 'aggressive', name: '激进降温策略',
      desc: '高温段就开启电子学并试打脉冲抢时间；MXC 一过 20mK 就校准。温度反弹会作废校准，需返工。',
      plan: [
        { when: { kind: 'pt4', le: 10 }, then: [{ op: 'group_on', group: 'mw' }, { op: 'group_on', group: 'ro' }] },
        { when: { kind: 'still', le: 2 }, then: [
          { op: 'group_on', group: 'flux' }, { op: 'group_on', group: 'dc' } ] },
        { when: { kind: 'cp', le: 0.15 }, then: [{ op: 'pulse', group: 'mw', dur: 600, frac: 1.0 }] },
        { when: { kind: 'mxc', le: 0.020 }, then: [{ op: 'cal', cal: 'gate' }] },
        { when: { kind: 'mxc', le: 0.020, stable: 300 }, then: [{ op: 'cal', cal: 'ro' }] },
        { when: { kind: 'cal', id: 'ro', status: 'done' }, then: [
          { op: 'pulse', group: 'mw', dur: 600, frac: 1.0 },
          { op: 'pulse', group: 'ro', dur: 600, frac: 1.0 } ] },
        // 强脉冲若作废了前面的校准，温度回落稳定后自动返工
        { when: { kind: 'stable', stable: 900 }, then: [{ op: 'cal', cal: 'gate' }] },
        { when: { kind: 'cal', id: 'gate', status: 'done' }, then: [{ op: 'cal', cal: 'ro' }] },
        { when: { kind: 'cal', id: 'ro', status: 'done' }, then: [{ op: 'cal', cal: 'flux' }] }
      ]
    };
  }

  const STRATEGIES = {
    standard: standardStrategy,
    conservative: conservativeStrategy,
    aggressive: aggressiveStrategy
  };

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // 级间有效耦合：上级越接近其目标温度，冷桥效率越高；高温时弱耦合，降温呈链式延迟。
  function s_stageG(upTemp, myTarget, frac) {
    return frac; // 占位（实际比例在力项中由 k 放大），frac 已按各级冷却能力标定
  }
  function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
  function solveQuad(a, b, c, guess) {
    // a x² + b x + c = 0 的正根（a 很小时退化线性）
    if (a < 1e-12) return -c / b;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return guess;
    return (-b + Math.sqrt(disc)) / (2 * a);
  }
  function fmtTime(t) {
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60);
    return h + 'h' + String(m).padStart(2, '0') + 'm';
  }

  class Sim {
    constructor(opts) {
      opts = opts || {};
      this.seed = opts.seed != null ? opts.seed : (Math.random() * 1e9) | 0;
      this.rng = mulberry32(this.seed);
      this.t = 0;
      this.finished = false;
      this.strategyId = opts.strategyId || 'manual';
      this.strategyName = opts.strategyName || '手动策略';
      this.temp = STAGES.map(s => 300);
      this.groups = GROUPS.map(g => ({
        id: g.id, name: g.name, enabled: false,
        activeUntil: 0,      // 脉冲持续到的时刻
        pulseFrac: 0,        // 当前/最近一次脉冲强度
        lastToggleAt: -1e9
      }));
      this.cals = CALS.map(c => ({
        id: c.id, name: c.name, status: 'pending', // pending|running|done|invalid
        startTime: null, endTime: null, invalidatedAt: null,
        queueTime: null, note: null
      }));
      this.sensors = STAGES.map(() => ({
        mode: 'ok',           // ok|frozen|drift|dead
        driftPerHr: 0,
        failAt: null, recoveredAt: null,
        latency: 0,           // 当前通信延迟（s）
        pending: []           // 迟到数据队列 [{collectAt, value}]
      }));
      this.plan = (opts.plan || []).map(p => ({ when: p.when, then: p.then.slice(), fired: false }));
      this.planIdx = 0;
      this.history = [];     // 每步一条完整记录（快进时也保留，由 UI 抽样绘制）
      this.events = [];      // {t,type,text}
      this.firstStableAt = null;
      this.settleStartAt = null;
      this.lastDisturbAt = 0;
      this.readyAt = null;
      this.checkpoints = [];
      this.name = opts.name || ('运行 ' + Math.floor(this.rng() * 900 + 100));
      this.checkpoint('起点 (300K)');
      this._record();
    }

    stageIndex(id) { return STAGES.findIndex(s => s.id === id); }
    group(id) { return this.groups.find(g => g.id === id); }
    cal(id) { return this.cals.find(c => c.id === id); }
    T(id) { return this.temp[this.stageIndex(id)]; }

    log(type, text) {
      this.events.push({ t: this.t, type, text });
      if (this.events.length > 400) this.events.shift();
    }

    // —— 热量 ——
    groupHeat() {
      const Q = STAGES.map(() => 0);
      for (const gs of this.groups) {
        const def = GROUPS.find(g => g.id === gs.id);
        if (!gs.enabled) continue;
        const pulsing = this.t < gs.activeUntil;
        for (let i = 0; i < Q.length; i++) {
          Q[i] += pulsing
            ? def.on[i] + (def.pulse[i] - def.on[i]) * gs.pulseFrac
            : def.idle[i];
        }
      }
      return Q;
    }

    _coolingPower(i) {
      const s = STAGES[i];
      // 以“正常负荷下的温度”为基准：冷却能力 = (base + 设计余量) × τ / 温跨
      const designLoad = s.base * 1.25;
      return designLoad * s.tau / Math.max(s.target, 1e-6); // W per K
    }

    // —— 噪声（折算到器件端的有效噪声温度，mK）——
    noiseTemp(gs) {
      const def = GROUPS.find(g => g.id === gs.id);
      let n = def.noiseBase;
      // 等效输入噪声温度（mK）。冷衰减级服从量子噪声规律：
      // 噪声功率 ∝ hf/2·coth(hf/2kT)，高温退化为 T，低温趋于常数（量子极限），
      // 用 hf/k ≈ 40mK 的饱和项描述，避免 300K 时被线性放大。
      // 冷衰减级（MXC）：量子极限 ~40mK 饱和，8~50mK 近似线性；
      // 上级温区经强衰减后只贡献“有效噪声温度”，室温再热也被压到数百 mK。
      const q = 40;
      const w = [1e-9, 3e-8, 8e-7, 4e-4, 0.85];
      for (let i = 0; i < 5; i++) {
        const t = this.temp[i] * 1000; // mK
        let eff;
        if (i === 4) {
          // 量子饱和（~40mK）到冷态线性；升温到 K 级后噪声趋于平台（~400mK），不再线性增长
          eff = t <= 5 * q ? q * (1 + (t / q - 1) / 5)
                           : q * 5 + 250 * (1 - Math.exp(-(t - 5 * q) / 400));
        } else {
          eff = t > 5 * q ? q * 5 + 200 * (1 - Math.exp(-(t - 5 * q) / 80000))
                          : q * (1 + (t / q - 1) / 5);
        }
        n += w[i] * eff;
      }
      const pulsing = gs.enabled && this.t < gs.activeUntil;
      if (pulsing) n *= 1 + 0.25 * gs.pulseFrac;
      if (!gs.enabled) n += 18; // 未上电时链路噪声裕量差
      return Math.max(4, n);
    }

    maxNoise() {
      return Math.max.apply(null, this.groups.map(g => this.noiseTemp(g)));
    }

    // —— 稳定性 ——
    isStable(secs) {
      if (this.t - this.lastDisturbAt < secs) return false;
      const m = this.T('mxc');
      if (m > 0.014) return false;
      if (this.t - this._mxcSettleSince() < secs) return false;
      for (const gs of this.groups) if (this.t < gs.activeUntil) return false;
      const running = this.cals.find(c => c.status === 'running');
      return !running;
    }

    _mxcSettleSince() {
      // 最近一次 MXC 越过 14mK 门限后回落到门限内的时刻
      if (this._settleSinceCache == null) this._settleSinceCache = 0;
      return this._settleSinceCache;
    }

    // —— 手动/计划动作 ——
    toggleGroup(id, on) {
      const gs = this.group(id);
      if (gs.enabled === on) return;
      const prev = gs._prevToggleAt != null ? gs._prevToggleAt : -1e9;
      gs.enabled = on;
      gs.lastToggleAt = this.t;
      gs._prevToggleAt = this.t;
      this.lastDisturbAt = Math.max(this.lastDisturbAt, this.t);
      this.log('line', (on ? '开启' : '关停') + '线路组：' + gs.name);
      // 5 分钟内反复启停会向相关线路注入开关噪声，直接作废相关校准
      if (on && this.t - prev < 300) {
        this._invalidateCalsForGroup(id, '线路在 5 分钟内反复启停，注入开关噪声');
      }
      if (!on && this.t < gs.activeUntil) gs.activeUntil = 0;
    }

    pulse(id, dur, frac) {
      const gs = this.group(id);
      if (!gs.enabled) { this.log('warn', '无法脉冲：' + gs.name + ' 尚未开启'); return false; }
      dur = dur || 300; frac = clamp(frac == null ? 1 : frac, 0.05, 1);
      gs.activeUntil = this.t + dur;
      gs.pulseFrac = frac;
      this.lastDisturbAt = Math.max(this.lastDisturbAt, this.t + dur);
      this.log('pulse', gs.name + ' 发送脉冲 ' + Math.round(dur / 60) + 'min @' + Math.round(frac * 100) + '%');
      this._invalidateByPulse(id, frac, dur);
      return true;
    }

    startCal(id) {
      const c = this.cal(id), def = CALS.find(x => x.id === id);
      if (c.status === 'running') return false;
      const m = this.T('mxc');
      if (m > def.gate) {
        this.log('warn', def.name + '被拒绝：MXC ' + (m * 1000).toFixed(1) + 'mK 高于门限 ' + (def.gate * 1000) + 'mK');
        return false;
      }
      if (!this.isStable(def.settle)) {
        if (c.status !== 'pending') {
          this.log('warn', def.name + '排队等待：稳定保持不足 ' + Math.round(def.settle / 60) + ' 分钟');
          c.queueTime = this.t;
        }
        c.status = 'pending';
        return false;
      }
      const missing = def.groups.filter(gid => !this.group(gid).enabled);
      if (missing.length) {
        this.log('warn', def.name + '被拒绝：相关线路未开启（' + missing.map(x => this.group(x).name).join('、') + '）');
        return false;
      }
      c.status = 'running'; c.startTime = this.t; c.note = null;
      this.log('cal', '开始校准：' + def.name + '（' + Math.round(def.dur / 60) + 'min）');
      return true;
    }

    _invalidateCalsForGroup(gid, note) {
      for (const c of this.cals) {
        if (c.status !== 'done' && c.status !== 'running') continue;
        const def = CALS.find(x => x.id === c.id);
        if (def.groups.includes(gid)) this._invalidate(c, note);
      }
    }

    _invalidateByPulse(gid, frac, dur) {
      const m = this.T('mxc');
      const strong = frac >= 0.7 && dur >= 480 && m < 0.05;
      for (const c of this.cals) {
        if (c.status !== 'done' && c.status !== 'running') continue;
        const def = CALS.find(x => x.id === c.id);
        if (!def.groups.includes(gid)) continue;
        // 强脉冲本身作废；其余由后续温度超门限处理
        if (strong) this._invalidate(c, '强脉冲（≥70%、≥8min）改变器件工作点');
      }
    }

    _invalidate(c, note) {
      if (c.status === 'invalid') return;
      c.status = 'invalid'; c.invalidatedAt = this.t; c.note = note;
      this.lastDisturbAt = Math.max(this.lastDisturbAt, this.t);
      this.log('invalidate', '校准失效：' + c.name + '（' + note + '）');
    }

    _updateCals() {
      for (const c of this.cals) {
        const def = CALS.find(x => x.id === c.id);
        if (c.status === 'running') {
          // 运行中超温/被脉冲作废
          if (this.T('mxc') > def.gate * 1.5) this._invalidate(c, '校准期间 MXC 温度超门限 50%');
          else if (this.t - (c.startTime || this.t) >= def.dur) {
            c.status = 'done'; c.endTime = this.t; c.note = null;
            this.log('cal', '校准完成：' + c.name);
          }
        } else if (c.status === 'done' && this.T('mxc') > def.gate * 1.5) {
          this._invalidate(c, '温度反弹至 ' + (this.T('mxc') * 1000).toFixed(1) + 'mK');
        } else if (c.status === 'pending' && c.queueTime != null) {
          if (this.startCal(c.id)) c.queueTime = null;
        }
      }
    }

    // —— 策略条件 ——
    _conditionMet(w) {
      switch (w.kind) {
        case 'time': return this.t >= w.le;
        case 'mxc': case 'cp': case 'still': case 'pt4':
          if (this.T(w.kind) > w.le) return false;
          return w.stable ? this.isStable(w.stable) : true;
        case 'cal': {
          const c = this.cal(w.id);
          if (w.status === 'done') return c.status === 'done';
          return c.status === w.status;
        }
        case 'stable': return this.isStable(w.stable);
        default: return false;
      }
    }

    _runPlan() {
      // 推进所有条件已满足的节点；校准类动作若暂时不能开始则进入排队（由
      // _updateCals 在温度/稳定条件满足后自动执行），节点保持等待直到校准真正开始。
      for (let guard = 0; guard < this.plan.length; guard++) {
        const e = this.plan[this.planIdx];
        if (!e) break;
        if (e.fired || !this._conditionMet(e.when)) break;
        const onlyCals = e.then.every(a => a.op === 'cal');
        if (onlyCals) {
          const allStarted = e.then.map(a => this.cal(a.cal)).every(c =>
            c.status === 'running' || c.status === 'done');
          if (!allStarted) {
            for (const a of e.then) {
              const c = this.cal(a.cal);
              if (c.status === 'pending' && c.queueTime == null) {
                this.log('plan', '策略节点到达，排队等待：' + c.name + '（' + this._describeWhen(e.when) + '）');
                c.queueTime = this.t;
              }
              this.startCal(a.cal); // 条件满足即开始，否则继续排队
            }
            break; // 本步停在此节点，后续节点等校准真正开始后再推进
          }
        }
        e.fired = true;
        this.log('plan', '策略节点触发：' + this._describeWhen(e.when));
        if (!onlyCals) for (const a of e.then) this._applyPlanAction(a);
        this.planIdx++;
      }
    }

    _applyPlanAction(a) {
      if (a.op === 'group_on') this.toggleGroup(a.group, true);
      else if (a.op === 'group_off') this.toggleGroup(a.group, false);
      else if (a.op === 'pulse') this.pulse(a.group, a.dur, a.frac);
      else if (a.op === 'cal') this.startCal(a.cal);
    }

    _describeWhen(w) {
      if (w.kind === 'time') return 't ≥ ' + fmtTime(w.le);
      if (w.kind === 'stable') return '稳定 ≥ ' + Math.round(w.stable / 60) + 'min';
      if (w.kind === 'cal') {
        const c = CALS.find(x => x.id === w.id);
        return c.name + (w.status === 'done' ? '完成' : '进入 ' + w.status);
      }
      const s = STAGES.find(x => x.id === w.kind);
      let v = w.le >= 1 ? w.le.toFixed(1) + 'K' : (w.le * 1000).toFixed(0) + 'mK';
      return s.name + ' ≤ ' + v + (w.stable ? ' 且稳定' + Math.round(w.stable / 60) + 'min' : '');
    }

    // —— 物理步进 ——
    step() {
      if (this.finished) return;
      this.t += DT;
      const Q = this.groupHeat();
      const next = this.temp.slice();
      let mxcPrev = this.temp[4];
      for (let i = 0; i < STAGES.length; i++) {
        const st = STAGES[i];
        const qExt = st.base + Q[i];
        const nonlin = st.kn != null;
        let nt, C;
        if (nonlin) {
          // 隐式求解 C·(T'-T)/dt = kn(T0²-T'²) + G(Tup-T') + Q，避免刚性振荡
          C = st.kn * st.ctau;
          const Tup = i > 0 ? next[i - 1] : st.target;
          // 桥电导只在“上级明显更热”（Tup > offK）时存在；
          // 上级进入本级工作温区后，桥关闭，只剩微漏热，由稀释制冷力定平衡。
          let w = 0;
          if (Tup > st.offK) {
            const span = Math.max(Tup - st.offK, 1e-9);
            w = clamp((Tup - Math.max(this.temp[i], st.offK * 0.5)) / span, 0, 1);
            w = Math.pow(w, 1.5);
          }
          const leakG = st.leak * st.kn * clamp(this.temp[i], 0.003, 1);
          const G = leakG + w * st.gbridge;
          // C(T'-T)/dt = kn(T0²-T'²) + G(Tup-T') + Q
          // → kn·dt·T'² + (C+G·dt)T' - [C·T + dt(kn·T0²+G·Tup+Q)] = 0
          const A = st.kn * DT;
          const B = C + G * DT;
          const R = C * this.temp[i] + DT * (st.kn * st.target * st.target + G * Tup + qExt);
          nt = solveQuad(A, B, -R, this.temp[i]);
        } else {
          const k = this._coolingPower(i);
          C = k * st.tau;
          const ratio = i > 0
            ? clamp(this.temp[i] / Math.max(this.temp[i - 1], 1e-9), 0, 1) : 1;
          const g = i > 0 ? st.frac * k * Math.pow(ratio, 1.5) : 0;
          const Tup = i > 0 ? next[i - 1] : st.target;
          // 后向欧拉：(C+(k+g)dt)T' = C·T + dt(k·T0 + g·Tup + Q)
          nt = (C * this.temp[i] + DT * (k * st.target + g * Tup + qExt)) / (C + (k + g) * DT);
        }
        next[i] = nonlin ? Math.max(nt, 0.5 * st.target) : nt;
      }
      this.temp = next;

      // 温度反弹：温度从近期谷值显著回升（脉冲/过快操作），每次回升只报一次；
      // 重新回落到接近谷值（恢复冷却）后才允许下一次报警。
      if (this._mxcValley == null) this._mxcValley = next[4];
      if (next[4] < this._mxcValley) this._mxcValley = next[4];
      const rise = next[4] - this._mxcValley;
      const rising = next[4] > mxcPrev + 0.0002;
      if (!this._reboundLatched && rising && mxcPrev < 0.05 && rise > 0.004 && next[4] > this._mxcValley * 1.3) {
        this.log('rebound', 'MXC 温度反弹：' + (this._mxcValley * 1000).toFixed(1) +
          ' → ' + (next[4] * 1000).toFixed(1) + ' mK（回升 ' + (rise * 1000).toFixed(1) + 'mK）');
        this.lastDisturbAt = Math.max(this.lastDisturbAt, this.t);
        this._reboundLatched = true;
        this._reboundBase = this._mxcValley;
      }
      if (this._reboundLatched && next[4] <= this._reboundBase * 1.08) this._reboundLatched = false;
      if (next[4] <= 0.014 && mxcPrev > 0.014) this._settleSinceCache = this.t;
      if (next[4] > 0.014) this._settleSinceCache = this.t; // 门限之上不累计稳定时间

      // 记录传感器故障期间的真实温度峰值（恢复后追溯判定用）
      for (let i = 0; i < this.sensors.length; i++) {
        const sn = this.sensors[i];
        if (sn.mode !== 'ok' && sn.failAt != null)
          sn.maxRealDuringFault = Math.max(sn.maxRealDuringFault != null ? sn.maxRealDuringFault : this.temp[i], this.temp[i]);
      }
      this._updateCals();
      this._updateSensors();
      this._runPlan();
      this._checkReady();
      this._record();
      if (this.t >= MAX_T) this.finish('达到 24h 仿真上限');
    }

    // —— 传感器：迟到数据 / 故障 / 恢复 ——
    // 注入一次通信延迟：当前真实读数会在 delay 秒后到达（图表按“采集时刻”回填，虚线缺口）
    injectLatency(stageId, delay) {
      const i = this.stageIndex(stageId);
      const sn = this.sensors[i];
      sn.latency = delay;
      sn.pending.push({ collectAt: this.t, deliverAt: this.t + delay,
        value: this.temp[i], modeAtCollect: sn.mode });
      this.log('sensor', STAGES[i].name + ' 传感器出现 ' + Math.round(delay) + 's 通信延迟（数据将迟到回填）');
    }

    // mode: frozen（冻结在最后读数）/ drift（每小时偏移 bias K）/ dead（无读数）
    injectFailure(stageId, mode, driftPerHr) {
      const i = this.stageIndex(stageId);
      const sn = this.sensors[i];
      sn.mode = mode; sn.failAt = this.t;
      sn.driftPerHr = driftPerHr || 0;
      sn.frozenValue = this.temp[i];
      sn.maxRealDuringFault = this.temp[i];
      this.log('sensor', '⚠ ' + STAGES[i].name + ' 传感器' +
        (mode === 'dead' ? '断线，无读数' : mode === 'frozen' ? '冻结，读数不再更新' : '出现漂移'));
    }

    recoverSensor(stageId) {
      const i = this.stageIndex(stageId);
      const sn = this.sensors[i];
      if (sn.mode === 'ok') return;
      const real = this.temp[i];
      const shown = this.sensorReading(i);
      sn.mode = 'ok'; sn.recoveredAt = this.t; sn.driftPerHr = 0; sn.pending = [];
      const delta = shown.value != null ? Math.abs(real - shown.value) : null;
      let msg = STAGES[i].name + ' 传感器恢复，当前读数 ' + this._fmtK(real);
      if (delta != null) msg += '，与故障期间最后显示值相差 ' + this._fmtK(delta);
      msg += '；已按真实温度重新判定门限与校准状态。';
      this.log('sensor', msg);
      // 恢复后追溯：故障期真实温度若曾超校准门限（盲区内发生反弹/强脉冲），
      // 相关校准（含运行中、已完成）一律作废，必须重做。
      const peakFault = sn.maxRealDuringFault != null ? sn.maxRealDuringFault : real;
      for (const c of this.cals) {
        if (c.status !== 'done' && c.status !== 'running') continue;
        const def = CALS.find(x => x.id === c.id);
        if (peakFault > def.gate)
          this._invalidate(c, '传感器恢复后追溯：故障盲区真实温度曾达 ' +
            this._fmtK(peakFault) + '，校准期间读数不可信');
      }
      sn.maxRealDuringFault = null;
      if (peakFault > 0.014) this._settleSinceCache = this.t;
    }

    _updateSensors() {
      for (let i = 0; i < this.sensors.length; i++) {
        const sn = this.sensors[i];
        // 到达投递时刻的迟到读数出队（按采集时刻回填）
        for (let k = sn.pending.length - 1; k >= 0; k--) {
          if (this.t >= sn.pending[k].deliverAt) {
            const p = sn.pending[k];
            this.log('sensor', STAGES[i].name + ' 迟到读数到达：采集于 ' + fmtTime(p.collectAt) +
              '，' + this._fmtK(p.value) + '（晚到 ' + Math.round(p.deliverAt - p.collectAt) + 's，已按采集时刻回填）');
            sn.pending.splice(k, 1);
          }
        }
      }
    }

    sensorReading(i) {
      const sn = this.sensors[i];
      const real = this.temp[i];
      // 优先展示已到达的最新迟到读数（缺口期间无新点）
      const waiting = sn.pending.filter(p => this.t < p.deliverAt).sort((a, b) => b.collectAt - a.collectAt)[0];
      if (waiting) {
        // 上一条已到达的读数停留在延迟发生前
        return { value: null, collectedAt: waiting.collectAt, status: 'gap',
          note: '数据采集中，尚未到达' };
      }
      if (sn.mode === 'dead') return { value: null, collectedAt: this.t, status: 'dead', note: '传感器断线' };
      if (sn.mode === 'frozen') return { value: sn.frozenValue, collectedAt: sn.failAt, status: 'frozen', note: '读数冻结' };
      if (sn.mode === 'drift') {
        const v = sn.frozenValue + sn.driftPerHr * ((this.t - (sn.failAt || this.t)) / 3600);
        return { value: v, collectedAt: this.t, status: 'drift', note: '读数漂移中' };
      }
      const jitter = real > 1 ? (this.rng() - 0.5) * real * 0.004 : (this.rng() - 0.5) * real * 0.02;
      return { value: real + jitter, collectedAt: this.t, status: 'live', note: null };
    }

    _fmtK(v) {
      return v >= 1 ? v.toFixed(2) + ' K' : (v * 1000).toFixed(2) + ' mK';
    }

    // —— 就绪 / 完成 ——
    _checkReady() {
      const tempsOk = STAGES.every((s, i) => this.temp[i] <= s.ready);
      const calsOk = this.cals.every(c => c.status === 'done');
      const settled = this.isStable(900);
      const allOn = this.groups.every(g => g.enabled);
      if (tempsOk && calsOk && settled && allOn && !this.readyAt) {
        this.readyAt = this.t;
        // 稳定时间 = 最后一次扰动（脉冲/开关/反弹/失效）之后恢复稳定所需时间
        this.settleDuration = Math.max(0, this.t - this.lastDisturbAt);
        this.log('ready', '系统就绪：全部温区达标、校准有效、稳定保持 15 分钟');
      }
    }

    get ready() { return this.readyAt != null; }
    get totalTime() { return this.readyAt || (this.finished ? this.t : null); }

    // 从“最后一次扰动”到稳定的保持时长（当前值）
    get stableFor() {
      return Math.max(0, Math.min(this.t - this.lastDisturbAt, this.t - this._mxcSettleSince()));
    }

    stabilityScore() {
      let score = 100;
      const m = this.T('mxc');
      score -= Math.max(0, (m - 0.008) * 2000);
      score -= Math.max(0, 300 - this.maxNoise()) * 0;
      if (this.maxNoise() > 300) score -= (this.maxNoise() - 300) * 0.15;
      score -= Math.min(30, this.t - this.lastDisturbAt < 900 ? (900 - (this.t - this.lastDisturbAt)) / 60 : 0);
      return Math.max(0, Math.round(score));
    }

    t2Estimate() {
      const m = this.T('mxc') * 1000;
      const n = this.maxNoise();
      const t2 = 220 * Math.exp(-(m - 8) / 9) / (1 + Math.max(0, n - 200) / 600);
      return Math.max(2, t2);
    }

    // —— 检查点与派生 ——
    checkpoint(label) {
      const snap = this._snapshot();
      snap.label = label || ('检查点 @' + fmtTime(this.t));
      snap.createdAt = this.t;
      this.checkpoints.push(snap);
      if (this.checkpoints.length > 12) this.checkpoints.shift();
      this.log('checkpoint', '保存检查点：' + snap.label);
      return snap;
    }

    _snapshot() {
      return {
        t: this.t,
        temp: this.temp.slice(),
        groups: this.groups.map(g => ({ ...g })),
        cals: this.cals.map(c => ({ ...c })),
        sensors: this.sensors.map(sn => ({ ...sn, pending: sn.pending.map(p => ({ ...p })) })),
        plan: this.plan.map(e => ({ when: { ...e.when }, then: e.then.map(a => ({ ...a })), fired: e.fired })),
        planIdx: this.planIdx,
        lastDisturbAt: this.lastDisturbAt,
        settleSince: this._settleSinceCache || 0,
        reboundLatched: !!this._reboundLatched,
        reboundBase: this._reboundBase || 0,
        mxcValley: this._mxcValley || 0,
        strategyId: this.strategyId,
        seed: this.seed
      };
    }

    _restore(snap, overrides) {
      const s = new Sim({ seed: snap.seed, strategyId: overrides.strategyId || snap.strategyId,
        strategyName: overrides.strategyName, plan: overrides.plan || snap.plan,
        name: overrides.name });
      s.t = snap.t;
      s.temp = snap.temp.slice();
      s.groups = snap.groups.map(g => ({ ...g }));
      s.cals = snap.cals.map(c => ({ ...c }));
      s.sensors = snap.sensors.map(sn => ({ ...sn, pending: sn.pending.map(p => ({ ...p })) }));
      const newPlan = !!overrides.plan;
      s.plan = (overrides.plan || snap.plan).map(e => ({
        when: { ...e.when }, then: e.then.map(a => ({ ...a })),
        fired: newPlan ? false : e.fired
      }));
      // 派生新策略时重置计划游标与稳定/扰动时钟（旧策略的扰动记录不属于新分支）
      s.planIdx = newPlan ? 0 : snap.planIdx;
      s.lastDisturbAt = newPlan ? snap.t : snap.lastDisturbAt;
      s._settleSinceCache = newPlan
        ? (snap.temp[4] <= 0.014 ? snap.t : 0)
        : (snap.settleSince || 0);
      s._reboundLatched = newPlan ? false : !!snap.reboundLatched;
      s._reboundBase = newPlan ? 0 : (snap.reboundBase || 0);
      s._mxcValley = snap.mxcValley || snap.temp[4];
      s.rng = mulberry32(snap.seed + Math.floor(snap.t / DT) + 1);
      s.history = []; s.events = [];
      s.log('checkpoint', '从检查点派生：' + fmtTime(snap.t) + '（' + (overrides.label || snap.label) + '）');
      s._record();
      return s;
    }

    // 从任意检查点派生一条新策略分支
    fork(checkpointIndex, strategyKey, name) {
      const snap = this.checkpoints[checkpointIndex] || this.checkpoints[this.checkpoints.length - 1];
      let plan = [], sid = 'manual', sname = name || '手动派生';
      if (strategyKey && STRATEGIES[strategyKey]) {
        const st = STRATEGIES[strategyKey]();
        plan = st.plan; sid = st.id; sname = name || st.name + '（派生）';
      }
      return this._restore(snap, { plan, strategyId: sid, strategyName: sname, name, label: snap.label });
    }

    // 离线快进推演（不渲染中间历史，直接给结论），返回最终 Sim
    runFast(maxSeconds) {
      const limit = Math.min(maxSeconds || MAX_T, MAX_T);
      let steps = 0;
      while (!this.finished && steps < limit / DT) {
        this.step(); steps++;
        if (this.ready) break;
        if (steps % 500 === 0 && !this.plan.some(e => !e.fired) &&
            this.t - this.lastDisturbAt > 1800 && this.T('mxc') > 0.02) {
          // 无后续动作且已无希望在短时间内变化时仍继续到上限（简单实现：不提前退出）
        }
      }
      this.finish(this.ready ? '达到就绪条件' : '快进结束');
      return this;
    }

    advance(seconds) {
      const n = Math.max(1, Math.round(seconds / DT));
      for (let i = 0; i < n && !this.finished; i++) this.step();
    }

    finish(reason) {
      if (this.finished) return;
      this.finished = true;
      this.finishReason = reason;
      this.log('finish', reason);
    }

    _record() {
      const Q = this.groupHeat();
      this.history.push({
        t: this.t,
        temp: this.temp.slice(),
        q: Q,
        qSum: Q.reduce((a, b) => a + b, 0),
        noise: this.groups.map(g => this.noiseTemp(g)),
        pulse: this.groups.map(g => this.t < g.activeUntil ? g.pulseFrac : 0),
        enabled: this.groups.map(g => g.enabled),
        stableFor: this.stableFor,
        score: this.stabilityScore()
      });
      if (this.history.length > 6000) this.history.splice(0, this.history.length - 6000);
    }

    stats() {
      const rebounds = this.events.filter(e => e.type === 'rebound').length;
      const invalidations = this.events.filter(e => e.type === 'invalidate').length;
      return {
        name: this.name,
        strategy: this.strategyName,
        total: this.totalTime,
        settleTime: this.settleDuration != null ? this.settleDuration : null,
        ready: this.ready,
        rebounds,
        invalidations,
        maxNoise: this.history.filter(h => h.temp[4] < 0.1)
          .reduce((m, h) => Math.max(m, Math.max.apply(null, h.noise)), 0),
        minMxc: this.history.reduce((m, h) => Math.min(m, h.temp[4]), 300),
        cals: this.cals.map(c => ({ id: c.id, name: c.name, status: c.status,
          endTime: c.endTime, invalidatedAt: c.invalidatedAt, note: c.note }))
      };
    }
  }

  // 便捷：从 300K 按模板预演（离线），返回 Sim
  function simulate(strategyKey, seed) {
    const st = STRATEGIES[strategyKey] ? STRATEGIES[strategyKey]() : null;
    const sim = new Sim({
      seed: seed || 42,
      strategyId: st ? st.id : 'manual',
      strategyName: st ? st.name : '手动策略',
      plan: st ? st.plan : [],
      name: st ? st.name : '手动策略'
    });
    return sim.runFast(MAX_T);
  }

  const api = {
    Sim, STAGES, GROUPS, CALS, STRATEGIES, DT, MAX_T,
    simulate, fmtTime, mulberry32
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.CryoSim = api;
})(typeof window !== 'undefined' ? window : globalThis);
