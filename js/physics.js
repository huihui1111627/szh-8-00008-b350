/* 物理引擎：多级 RC 热网络，级间热流按真实延迟从历史温度取值。 */
'use strict';

class HistoryBuf {
  // 以固定步长保存温度历史，支持按延迟秒数插值回看
  constructor(initial) { this.data = [initial]; }
  push(v) { this.data.push(v); }
  // age 秒前的值；age 超出长度时返回最早值
  atAge(age) {
    const n = this.data.length;
    if (age <= 0) return this.data[n - 1];
    const pos = n - 1 - age;
    if (pos <= 0) return this.data[0];
    const i = Math.floor(pos), f = pos - i;
    return this.data[i] * (1 - f) + this.data[i + 1] * f;
  }
}

class ThermalModel {
  constructor() { this.reset(); }

  reset() {
    this.t = {};
    this.hist = {};
    for (const s of CFG.stages) {
      this.t[s.id] = s.id === 'room' ? CFG.ambient : 295;
      this.hist[s.id] = new HistoryBuf(this.t[s.id]);
    }
    this.flux = CFG.cond.map(() => 0);   // 最近一个步长到达的延迟热流 nW
    this.pulseHeat = {};                  // 各级脉冲余温 nW（指数衰减）
    this.time = 0;
  }

  // 当前各级外加负载（线路 + 脉冲），由控制器填充
  setLoads(loadByStage, pulse) { this.loads = loadByStage; this.pulseInput = pulse; }

  step(ramp, phaseId) {
    const dt = CFG.dt;
    // 脉冲热量指数衰减并叠加新脉冲
    for (const id of Object.keys(this.pulseHeat)) {
      this.pulseHeat[id] *= Math.exp(-dt / CFG.pulse.decay);
      if (this.pulseHeat[id] < 1e-6) delete this.pulseHeat[id];
    }
    if (this.pulseInput) {
      for (const [id, q] of Object.entries(this.pulseInput)) {
        this.pulseHeat[id] = (this.pulseHeat[id] || 0) + q;
      }
      this.pulseInput = null;
    }

    const nt = { room: CFG.ambient };
    // 延迟热流：用 delay 秒前上游温度与当前下游温度计算（模拟传导延迟抵达）
    // 带符号热流：下游比上游热时自动回流（被动导热），延迟取自上游历史温度
    const fluxInto = {};
    for (let i = 0; i < CFG.cond.length; i++) {
      const c = CFG.cond[i];
      const tUpOld = this.hist[c.from].atAge(c.delay);
      const q = c.G * (tUpOld - this.t[c.to]);
      this.flux[i] = q;
      fluxInto[c.to] = (fluxInto[c.to] || 0) + q;
    }

    for (let i = 1; i < CFG.stages.length; i++) {
      const s = CFG.stages[i];
      const id = s.id;
      const r = ramp[id] || 0;
      // 制冷抽热按指数松弛（半隐式，任意 g0 下数值稳定），再叠加外部热输入
      const relax = Math.exp(-r * s.g0 * dt / s.C);
      const cooled = s.tTarget + (this.t[id] - s.tTarget) * relax;
      // 制冷机未开启（r≈0）时，线路寄生漏热由室温锚定/支撑旁路，不计入该级温升
      const lineLoad = r > 0.1 ? (this.loads ? this.loads[id] || 0 : 0) : 0;
      const qIn = lineLoad + (fluxInto[id] || 0) + (this.pulseHeat[id] || 0);
      nt[id] = Math.max(s.tTarget * 0.9, cooled + qIn / s.C * dt);
    }

    for (const id of STAGE_IDS) {
      if (id === 'room') continue;
      this.t[id] = nt[id];
      this.hist[id].push(nt[id]);
    }
    this.time += dt;
    return this.t;
  }

  // 等效噪声温度 mK：级温（折算 mK）加权 + 开启线路附加噪声 + 脉冲瞬态贡献
  noiseTemp(lineNoiseAdd, pulseNoise) {
    let n = 0;
    for (const [id, w] of Object.entries(CFG.noiseWeight)) {
      n += w * Math.max(0, this.t[id]) * 1000;
    }
    return n + lineNoiseAdd + (pulseNoise || 0);
  }

  serialize() {
    return {
      t: { ...this.t },
      pulseHeat: { ...this.pulseHeat },
      time: this.time,
      histLen: this.hist.mxc.data.length,
    };
  }
}
