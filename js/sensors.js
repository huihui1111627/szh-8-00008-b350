/* 传感器与数据链路：测量噪声、乱序/迟到（水位线）、失效期模型估计、恢复对账。 */
'use strict';

class SensorSystem {
  constructor() { this.reset(); }

  reset() {
    this.failedUntil = {};     // stage -> 恢复时刻（-1 表示已恢复待对账）
    this.watermark = {};       // stage -> 已确认最新测量时间
    this.lastReading = {};     // stage -> {ts, temp, late}
    this.pending = [];         // 在途读数 {stage, ts, arrival, temp}
    this.linkDelay = 0;        // 注入的链路延迟 s
    this.linkDelayUntil = -1;  // 延迟注入的到期时刻
    this.lateBatchLeft = 0;    // 迟到批次剩余条数
    this.estimator = null;     // 失效期间独立运行的预测模型
    this.estLoads = null;      // 失效瞬间冻结的负载快照（之后不再更新）
    this.estStage = null;
    this.awaitRecon = {};      // 恢复后等待首个读数对账的温区
    this.lastEst = {};
    this.recovering = {};      // 已进入“恢复待对账”状态，避免重复触发
    this.events = [];
    for (const s of CFG.stages) if (s.id !== 'room') this.watermark[s.id] = -Infinity;
  }

  isFailed(stage, now) {
    const u = this.failedUntil[stage];
    return u !== undefined && u !== null && now < u;
  }

  setFailed(stage, durationSec, now) {
    if (this.isFailed(stage, now) || this.recovering[stage]) return;
    this.failedUntil[stage] = now + durationSec;
    this.recovering[stage] = false;
    this.estStage = stage;
    // 预测器复制失效瞬间真实状态独立演化；负载快照冻结 → 期间若操作线路，恢复时必然出现偏差
    this.estimator = new ThermalModel();
    const m = SIM.ctrl.model;
    for (const s of CFG.stages) {
      this.estimator.t[s.id] = m.t[s.id];
      this.estimator.hist[s.id] = new HistoryBuf(m.t[s.id]);
    }
    this.estLoads = { ...SIM.ctrl.currentLoads() };
    this.events.push({ kind: 'bad', code: 'SENSOR_FAIL',
      msg: `${stageLabel(stage)} 传感器失效，预计 ${durationSec}s 恢复；界面改用模型估计值（虚线/琥珀色），期间读数不更新水位线` });
  }

  queueLateBatch() { this.lateBatchLeft = 5; }

  tick(now, ramp) {
    const ev = this.events; this.events = [];
    const model = SIM.ctrl.model;

    // 失效恢复判定（在本帧生成新读数之前）
    for (const stage of Object.keys(this.failedUntil)) {
      const until = this.failedUntil[stage];
      if (until === undefined || until === null) continue;
      if (this.isFailed(stage, now)) {
        if (this.estStage === stage && this.estimator) {
          this.estimator.setLoads(this.estLoads, null);
          this.estimator.step(ramp, SIM.ctrl.phaseId);
        }
      } else if (until !== -1 && !this.awaitRecon[stage] && !this.recovering[stage]) {
        // 丢弃失效期间堆积的在途数据，防止旧读数污染恢复对账
        this.pending = this.pending.filter(p => p.stage !== stage);
        this.awaitRecon[stage] = true;
        this.recovering[stage] = true;
        this.failedUntil[stage] = -1;
        this.lastEst[stage] = this.estimator ? this.estimator.t[stage] : model.t[stage];
        this.estimator = null; this.estStage = null;
        ev.push({ kind: 'warn', code: 'SENSOR_RECOVER',
          msg: `${stageLabel(stage)} 传感器链路恢复，失效期积压数据已丢弃，等待首个新读数完成对账` });
      }
    }

    // 生成读数（1 Hz）
    for (const s of CFG.stages) {
      if (s.id === 'room' || this.isFailed(s.id, now)) continue;
      let delay = now < this.linkDelayUntil ? this.linkDelay : 0;
      if (this.lateBatchLeft > 0 && s.id === 'mxc') {
        delay = 30 + Math.floor(Math.random() * 40);
        this.lateBatchLeft--;
      }
      const noisy = model.t[s.id] * (1 + (Math.random() - 0.5) * 2 * CFG.sensors.noise);
      this.pending.push({ stage: s.id, ts: now,
        arrival: now + delay + (delay ? Math.random() * 2 : 0), temp: noisy });
    }

    // 处理到达
    const remain = [];
    for (const p of this.pending) {
      if (p.arrival > now) { remain.push(p); continue; }
      const wm = this.watermark[p.stage];
      const late = isFinite(wm) && p.ts < wm - 2;
      this.watermark[p.stage] = Math.max(wm, p.ts);
      this.lastReading[p.stage] = { ts: p.ts, temp: p.temp, late };

      if (this.awaitRecon[p.stage]) {
        this.awaitRecon[p.stage] = false;
        this.recovering[p.stage] = false;
        this.failedUntil[p.stage] = undefined;
        const est = this.lastEst[p.stage] ?? p.temp;
        const delta = p.temp - est;
        const abs = Math.abs(delta);
        const rel = p.temp > 0 ? abs / p.temp : 0;
        // 低温（<0.5K）看绝对偏差 10mK；高温看相对偏差 3%
        const bad = p.temp < 0.5 ? abs > 0.01 : rel > 0.03;
        const warnOnly = !bad && (p.temp < 0.5 ? abs > 0.005 : rel > 0.015);
        const pctText = p.temp >= 0.5 ? `（相对 ${(rel * 100).toFixed(1)}%）` : '';
        ev.push({ kind: bad ? 'bad' : warnOnly ? 'warn' : 'ok', code: 'RECONCILE',
          msg: `${stageLabel(p.stage)} 恢复后首个读数 ${fmtT(p.temp)}，失效期估计终值 ${fmtT(est)}，` +
            `偏差 ${(delta * 1000).toFixed(2)} mK${pctText}` +
            (bad ? '：偏差超限，失效期间完成的校准标记为存疑并需重做'
                 : warnOnly ? '：偏差偏大，置信度下调但校准暂保留' : '：对账一致，校准状态保留') });
        SIM.ctrl.reconcileSensor(p.stage, bad, warnOnly);
      } else if (late) {
        ev.push({ kind: 'warn', code: 'LATE_DATA',
          msg: `收到 ${stageLabel(p.stage)} 迟到读数：测量 T+${p.ts}s（滞后 ${now - p.ts}s，水位线 T+${wm}s），` +
            `读数 ${fmtT(p.temp)}，当前真值 ${fmtT(model.t[p.stage])}；归档为历史点，不回滚当前状态` });
        SIM.ctrl.applyLateData(p);
      }
    }
    this.pending = remain;
    return ev;
  }

  getDisplay(stage, now) {
    if (this.isFailed(stage, now) && this.estimator) {
      return { temp: this.estimator.t[stage], mode: 'est' };
    }
    const r = this.lastReading[stage];
    if (!r) return { temp: SIM.ctrl.model.t[stage], mode: 'none' };
    return { temp: r.temp, mode: r.late ? 'late' : 'ok' };
  }

  globalWatermark(now) {
    let wm = now;
    for (const s of CFG.stages) {
      if (s.id === 'room' || this.isFailed(s.id, now)) continue;
      const w = this.watermark[s.id];
      if (isFinite(w)) wm = Math.min(wm, w);
    }
    return wm;
  }

  pendingCount(stage) {
    if (stage) return this.pending.filter(p => p.stage === stage).length;
    return this.pending.length;
  }
  activeLinkDelay(now) { return now < this.linkDelayUntil ? this.linkDelay : 0; }
}

function stageLabel(id) {
  const s = CFG.stages.find(x => x.id === id);
  return s ? s.name : id;
}
