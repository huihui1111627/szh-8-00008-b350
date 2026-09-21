/* 全局配置：温区 / 阶段 / 线路 / 策略。单位：温度 K，热 nW，时间 s。 */
'use strict';

const CFG = {
  dt: 1,                 // 物理步长（仿真秒）
  ambient: 300,          // 室温热沉
  uiSampleEvery: 10,     // 曲线采样间隔（仿真秒），密集保证脉冲可见

  // 五级温区（含室温顶盘）。G 为相对上一级制冷热导（nW/K），C 热容（nW·s/K）
  stages: [
    { id: 'room',  name: '室温顶板', sub: '300 K 法兰',   C: Infinity, g0: 0,
      tTarget: 300,     color: '#8a97c4' },
    { id: 'p50',   name: '50 K 级',  sub: '脉冲管一级',   C: 1800, g0: 90,
      tTarget: 45,  noiseFloor: 50000, color: '#4da3ff' },
    { id: 'p4',    name: '4 K 级',   sub: '脉冲管二级',   C: 3000, g0: 100,
      tTarget: 3.2, noiseFloor: 4000,  color: '#36d1c4' },
    { id: 'still', name: 'Still 级', sub: '蒸馏器 ~0.8K', C: 1400, g0: 120,
      tTarget: 0.8, noiseFloor: 800,   color: '#a78bfa' },
    { id: 'mxc',   name: 'MXC 级',   sub: '混合室 · 器件位', C: 7200, g0: 200,
      tTarget: 0.02, noiseFloor: 25,   color: '#3ddc84' },
  ],

  // 级间导热链路：cond[i] 是热量从 i 流向 i+1 的热导与传导延迟
  // 延迟来源：逆流热交换器长度、热声传播、金属导热扩散
  cond: [
    { from: 'room',  to: 'p50',   G: 1.2, delay: 8  },
    { from: 'p50',   to: 'p4',    G: 0.05, delay: 20 },
    { from: 'p4',    to: 'still', G: 1.5, delay: 45 },
    { from: 'still', to: 'mxc',   G: 0.6, delay: 90 },
  ],

  // 降温阶段：门限均要求相应温区进入温度门限并保持 settle 秒
  phases: [
    { id: 'evac',    name: '抽真空',     dur: 120,
      ramp: { p50: 0.02 }, gate: [] },
    { id: 'pt',      name: '脉冲管降温', dur: 1500,
      ramp: { p50: 1, p4: 0.55 },
      gate: [{ stage: 'p50', below: 60, settle: 45 }] },
    { id: 'condense',name: '氦冷凝',     dur: 900,
      ramp: { p50: 1, p4: 1, still: 0.45 },
      gate: [{ stage: 'p4', below: 5, settle: 45 }] },
    { id: 'circulate', name: '循环运行', dur: 2400,
      ramp: { p50: 1, p4: 1, still: 1, mxc: 1 },
      gate: [
        { stage: 'still', below: 1.2, settle: 75 },
        { stage: 'p4', below: 4, settle: 75 },
      ] },
    { id: 'base',    name: '基温稳定',   dur: Infinity,
      ramp: { p50: 1, p4: 1, still: 1, mxc: 1 }, gate: [] },
  ],

  // 线路组：各温区的寄生/导通热负载（nW），on 为启用，off 为断开（残余漏热）
  lines: [
    { id: 'dc',  name: 'DC 直流偏置', sub: '直流源 · 低通滤波',
      off: { p50: 40, p4: 12, still: 1.5, mxc: 0.25 },
      on:  { p50: 90, p4: 30, still: 4.0, mxc: 0.8 },
      noiseOn: 8, noiseOff: 2 },
    { id: 'mw',  name: '微波控制线', sub: 'AWG · 衰减器链路',
      off: { p50: 70, p4: 20, still: 2.5, mxc: 0.4 },
      on:  { p50: 220, p4: 90, still: 14, mxc: 3.2 },
      noiseOn: 120, noiseOff: 5 },
    { id: 'ro',  name: '读取线路', sub: '泵浦源 · JPC 放大链',
      off: { p50: 55, p4: 16, still: 2.0, mxc: 0.3 },
      on:  { p50: 160, p4: 70, still: 10, mxc: 2.2 },
      noiseOn: 70, noiseOff: 4 },
  ],

  // 全局噪声：加权等效噪声温度（mK），权重按器件耦合程度
  noiseWeight: { p50: 0.001, p4: 0.006, still: 0.18, mxc: 0.80 },
  noiseTarget: 420,     // 校准确许的等效噪声 mK
  stabilityNoise: 520,

  // 稳定判据（基温校准窗口）
  stable: {
    mxcBelow: 0.035,
    stillBelow: 0.95,
    noiseBelow: 520,
    hold: 120,           // 持续秒数
    rearm: 180,          // 失稳后重新计时的迟滞
  },

  pulse: { stages: ['mxc', 'still', 'p4'], decay: 28 }, // 脉冲热在各级的衰减与时间常数 s
  cal: { durations: { resonator: 240, rabi: 420, readout: 300 } },
  sensors: { noise: 0.004, failDriftRate: 0.0009 }, // 测量相对噪声；失效期估计漂移率/s

  strategies: {
    standard: {
      label: '标准', advanceExtraSettle: 0, lines: { dc: false, mw: false, ro: false },
      mxcOnBeforeBase: true, desc: '按门限推荐时间推进，进基温后再接 DC 线' },
    aggressive: {
      label: '激进', advanceExtraSettle: -60, lines: { dc: true, mw: true, ro: true },
      mxcOnBeforeBase: false, desc: '门限一到立即推进，线路全程开启，速度快但风险高' },
    conservative: {
      label: '保守', advanceExtraSettle: 240, lines: { dc: false, mw: false, ro: false },
      mxcOnBeforeBase: true, desc: '额外稳定等待，线路最后才接，慢但温升风险最小' },
  },
};

const STAGE_IDS = CFG.stages.map(s => s.id);
const fmtT = (t) => {
  if (t >= 100) return t.toFixed(0) + ' K';
  if (t >= 1) return t.toFixed(2) + ' K';
  return (t * 1000).toFixed(1) + ' mK';
};
const fmtClock = (sec) => {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return `T+${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
