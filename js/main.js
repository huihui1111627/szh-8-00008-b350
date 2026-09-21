/* 入口：全局状态、推演主循环、控件事件绑定。 */
'use strict';

const SIM = {
  ctrl: null, ui: null, events: [], speed: 60, verboseShadow: false,
  acc: 0, lastFrame: 0,
};

function restoreCheckpoint(ck) {
  const fresh = new Controller(false);
  // 保留同一控制器里历史检查点与分支列表
  fresh.checkpoints = SIM.ctrl.checkpoints;
  fresh.branches = SIM.ctrl.branches;
  fresh.model.t = { ...ck.t };
  fresh.model.hist = {};
  for (const [k, v] of Object.entries(ck.hist)) {
    fresh.model.hist[k] = new HistoryBuf(0);
    fresh.model.hist[k].data = v.data.slice();
  }
  fresh.model.pulseHeat = { ...ck.pulseHeat };
  fresh.model.time = ck.time;
  fresh.phaseIdx = ck.phaseIdx; fresh.phaseT = ck.phaseT;
  fresh.gateAcc = [...ck.gateAcc];
  fresh.lines = { ...ck.lines };
  fresh.stable = ck.stable; fresh.stableFor = ck.stableFor; fresh.everStable = ck.everStable;
  fresh.minMxc = ck.minMxc; fresh.reboundArm = ck.reboundArm;
  fresh.baseEntryTime = ck.baseEntryTime;
  fresh.cals = ck.cals.map(x => ({ ...x }));
  fresh.sampleAcc = CFG.uiSampleEvery - 1;
  fresh.recordSample(fresh.model.noiseTemp(fresh.lineNoiseAdd(), fresh.pulseNoise));
  // 重置数据链路与曲线（恢复后重新观测）
  SIM.ctrl = fresh;
  fresh.log('phase', 'RESTORE', `主时间线已回滚/切换到「${ck.label}」@ ${fmtClock(ck.time)}，检查点与已派生策略保留`);
}

function runOfflineStrategies(ck) {
  const wanted = ['standard', 'aggressive', 'conservative'];
  for (const k of wanted) {
    if (SIM.ctrl.branches.some(b => b.ckId === ck.id && b.strategy === k)) continue;
    const b = SIM.ctrl.forkFromCheckpoint(ck, k, false);
    // 离线推演分批让出主线程，避免界面卡死
    setTimeout(() => SIM.ctrl.runBranchOffline(b), 0);
  }
}

let modalConfirm = null;
function askConfirm(title, body, onOk) {
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalBody').textContent = body;
  document.getElementById('modal').classList.remove('hidden');
  modalConfirm = onOk;
}

function bindEvents() {
  const $ = (id) => document.getElementById(id);

  $('btnRun').onclick = () => { SIM.ctrl.running = true; };
  $('btnPause').onclick = () => { SIM.ctrl.running = false; SIM.ui.renderHeader(); };
  $('btnStep').onclick = () => { SIM.ctrl.running = false; SIM.ctrl.step(); SIM.ui.renderAll(); };

  document.querySelectorAll('#speedSeg button').forEach(b => {
    b.onclick = () => {
      document.querySelectorAll('#speedSeg button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      SIM.speed = +b.dataset.speed;
    };
  });

  $('btnAdvance').onclick = () => {
    const gs = SIM.ctrl.gateStatus();
    if (gs.gates.length && !gs.ready) {
      askConfirm('确认强行提前推进？',
        '门限尚未全部满足。过早切换制冷阶段会导致热交换器失衡、混合气回流：\n' +
        '· MXC 可能反弹 80–120 mK\n· 噪声瞬时飙升并冲过稳定上限\n· 已完成的校准将被标记失效\n\n仍要推进吗？',
        () => { SIM.ctrl.advancePhase(true); SIM.ui.renderAll(); });
    } else {
      SIM.ctrl.advancePhase(false);
      SIM.ui.renderAll();
    }
  };
  $('modalCancel').onclick = () => { $('modal').classList.add('hidden'); modalConfirm = null; };
  $('modalOk').onclick = () => {
    $('modal').classList.add('hidden');
    if (modalConfirm) modalConfirm();
    modalConfirm = null;
    SIM.ui.renderAll();
  };

  $('chkAuto').onchange = (e) => { SIM.ctrl.autoAdvance = e.target.checked; };
  $('btnReset').onclick = () => askConfirm('重置仿真？', '将清空全部状态、检查点与策略分支，回到室温初始状态。',
    () => { SIM.events = []; SIM.ui.clearEvents(); SIM.ctrl = new Controller(false); SIM.ui.renderAll(); });

  CFG.lines.forEach(ln => {
    $('line-' + ln.id).onchange = (e) => {
      const on = e.target.checked;
      if (on && SIM.ctrl.model.t.mxc < 0.1) {
        askConfirm('低温下接通线路',
          `MXC 已低于 100 mK，此时接通「${ln.name}」会沉积 ${ln.on.mxc} nW 热负载，可能引起温度反弹并使校准失效。\n\n确认接通？`,
          () => SIM.ctrl.toggleLine(ln.id, true));
        e.target.checked = SIM.ctrl.lines[ln.id];
      } else SIM.ctrl.toggleLine(ln.id, on);
      SIM.ui.renderAll();
    };
  });

  $('pulseGroup').value = 'mw';
  $('btnPulse').onclick = () => {
    SIM.ctrl.injectPulse($('pulseGroup').value, +$('pulseAmp').value);
    SIM.ui.renderAll();
  };

  $('btnCalStart').onclick = () => { SIM.ctrl.startCal($('calType').value); SIM.ui.renderAll(); };
  $('btnCalCancel').onclick = () => { SIM.ctrl.cancelCal(); SIM.ui.renderAll(); };

  $('btnFaultAll').onclick = () => {
    SIM.ctrl.sensors.setFailed('mxc', 30, SIM.ctrl.time);
    SIM.ui.renderAll();
  };
  $('btnLateInject').onclick = () => {
    const d = +$('lateDelay').value;
    if (d > 0) {
      SIM.ctrl.sensors.linkDelay = d;
      SIM.ctrl.sensors.linkDelayUntil = SIM.ctrl.time + 70;
      SIM.ctrl.sensors.queueLateBatch();
      SIM.ctrl.log('info', 'DATA',
        `注入 70s 链路扰动（基础延迟 ${d}s）：期间读数滞后到达，另发 5 条 30–70s 乱序迟到数据；按水位线判定并归档`);
    }
  };

  $('btnCheckpoint').onclick = () => {
    const ck = SIM.ctrl.saveCheckpoint();
    SIM.ui.renderAll();
    askConfirm('检查点已保存', `「${ck.label}」已保存。\n是否立即派生标准/激进/保守三种策略并离线推演对比？`,
      () => runOfflineStrategies(ck));
  };

  $('branchList').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const id = +btn.dataset.id;
    const ck = SIM.ctrl.checkpoints.find(x => x.id === id);
    if (btn.dataset.act === 'restore') {
      askConfirm('恢复到该检查点？', '主时间线将回滚到该时刻（检查点与策略分支保留），当前之后的操作将丢失。',
        () => restoreCheckpoint(ck));
    } else if (btn.dataset.strategy) {
      const exist = SIM.ctrl.branches.find(b => b.ckId === id && b.strategy === btn.dataset.strategy);
      if (exist) return;
      const b = SIM.ctrl.forkFromCheckpoint(ck, btn.dataset.strategy);
      setTimeout(() => SIM.ctrl.runBranchOffline(b), 0);
    }
    SIM.ui.renderAll();
  });

  $('btnClearLog').onclick = () => { SIM.events = []; SIM.ui.clearEvents(); };
}

function frame(ts) {
  if (!SIM.lastFrame) SIM.lastFrame = ts;
  const wall = (ts - SIM.lastFrame) / 1000;
  SIM.lastFrame = ts;
  if (SIM.ctrl.running) {
    const steps = Math.min(2000, Math.floor(wall * SIM.speed));
    for (let i = 0; i < steps; i++) SIM.ctrl.step();
  }
  SIM.ui.renderAll();
  requestAnimationFrame(frame);
}

window.addEventListener('DOMContentLoaded', () => {
  SIM.ctrl = new Controller(false);
  SIM.ui = new UI();
  bindEvents();
  SIM.ctrl.log('info', 'SYS',
    '系统就绪：室温 300 K。点击「开始」按 ×60 推演；也可随时保存检查点并派生降温策略。');
  SIM.ctrl.log('info', 'SYS',
    '提示：阶段门限未满足时强行推进会引发温度反弹；MXC 低温时接通线路/注入脉冲同理。');
  requestAnimationFrame(frame);
});
