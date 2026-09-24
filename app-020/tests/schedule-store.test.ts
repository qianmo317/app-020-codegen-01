/**
 * 季度派工计划的 store 集成：
 * - 排产出批、重新排产时已完成批保留、未完成批重排
 * - 登记检查后批次自动判定完成；一键顺延生成承接批、原批留痕
 * - 巡检员删改与批次指派同步、容器引用语义（UI 订阅）
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getState,
  addBuilding,
  addFloor,
  addFacility,
  addCheck,
  deleteBuilding,
  deletePlan,
  generatePlan,
  carryBatch,
  addInspector,
  updateInspector,
  deleteInspector,
  updatePlanSettings,
  updateBatch,
  deleteBatch,
  subscribe,
} from '../src/store/store';
import { batchProgress } from '../src/lib/schedule';

const snap = () => getState();

beforeEach(() => {
  for (const b of [...snap().buildings]) deleteBuilding(b.id);
});

function setupBuilding() {
  const bid = addBuilding('计划测试楼', 'office');
  const fid = addFloor(bid, 3);
  // 6/15 检查的灭火器 → Q3 三批：7/15、8/14、9/13
  const ex1 = addFacility(fid, 'extinguisher', 1000, 1000);
  addCheck(fid, ex1, { date: '2026-06-15', status: 'ok' });
  // 3/1 检查的安全出口 → 8/28 一批
  const ex2 = addFacility(fid, 'exit', 2000, 1000);
  addCheck(fid, ex2, { date: '2026-03-01', status: 'ok' });
  return { bid, fid, ex1, ex2 };
}

describe('generatePlan', () => {
  it('P1 排产：生成「楼层×月份」批次，全部落在工作日，默认有巡检员', () => {
    const { fid } = setupBuilding();
    const n = generatePlan('2026-Q3');
    const plan = snap().plans['2026-Q3'];
    // 月份：07（灭火器 1 件）、08（灭火器+安全出口 2 件）、09（灭火器 1 件）= 3 批
    expect(n).toBe(3);
    expect(plan.batches).toHaveLength(3);
    for (const b of plan.batches) {
      const day = new Date(`${b.date}T00:00:00`).getDay();
      expect(day).not.toBe(0);
      expect(day).not.toBe(6);
      expect(b.inspectorId).toBeTruthy();
      expect(b.tools.length).toBeGreaterThan(0);
    }
    const aug = plan.batches.find((b) => b.monthKey === '2026-08')!;
    expect(aug.facilityIds).toHaveLength(2);
    expect(aug.floorId).toBe(fid);
  });

  it('P2 登记检查（派工日当天或之后）后批次自动完成；重新排产不覆盖已完成批', () => {
    const { fid, ex1 } = setupBuilding();
    generatePlan('2026-Q3');
    const before = snap().plans['2026-Q3'].batches;
    const jul = before.find((b) => b.monthKey === '2026-07')!;
    expect(batchProgress(jul, snap().floors).completed).toBe(false);

    // 在 7/15 当天登记灭火器检查
    addCheck(fid, ex1, { date: jul.date, status: 'ok' });
    expect(batchProgress(jul, snap().floors).completed).toBe(true);

    // 重新排产：7 月已完成，该「楼层×月份」保留；按新记录（7/15）8/14、9/13 两批重算
    generatePlan('2026-Q3');
    const after = snap().plans['2026-Q3'].batches;
    const julAfter = after.find((b) => b.monthKey === '2026-07');
    expect(julAfter).toBeDefined();
    expect(julAfter!.id).toBe(jul.id); // 原批保留
    expect(julAfter!.facilityIds).toEqual([ex1]);
  });

  it('P3 一键顺延：部分检查后，未查设施挪到下一工作日新批，原批留痕划掉', () => {
    const { fid, ex1 } = setupBuilding();
    generatePlan('2026-Q3');
    const jul = snap().plans['2026-Q3'].batches.find((b) => b.monthKey === '2026-07')!;
    // 不改检查记录（0 件已查）→ 原批直接替换为顺延批
    carryBatch('2026-Q3', jul.id);
    let plan = snap().plans['2026-Q3'];
    let moved = plan.batches.find((b) => b.carryover);
    expect(moved).toBeDefined();
    expect(moved!.date).toBe('2026-07-16');
    expect(plan.batches.find((b) => b.id === jul.id && !b.carried)).toBeUndefined();

    // 构造部分完成场景：8 月合批（灭火器+出口），只查灭火器，再顺延 → 原批留痕 carried，新批含出口
    addCheck(fid, ex1, { date: '2026-07-15', status: 'ok' });
    generatePlan('2026-Q3');
    plan = snap().plans['2026-Q3'];
    const aug = plan.batches.find((b) => b.monthKey === '2026-08')!;
    addCheck(fid, ex1, { date: aug.date, status: 'ok' }); // 只查了灭火器
    carryBatch('2026-Q3', aug.id);
    plan = snap().plans['2026-Q3'];
    const orig = plan.batches.find((b) => b.id === aug.id)!;
    expect(orig.carried).toBe(true);
    const movedAug = plan.batches.find((b) => b.carryover && b.monthKey === '2026-08')!;
    expect(movedAug.facilityIds).not.toContain(ex1);
    expect(movedAug.facilityIds).toHaveLength(1); // 只剩安全出口
  });

  it('P4 全部查完时一键顺延无效', () => {
    const { fid, ex1 } = setupBuilding();
    generatePlan('2026-Q3');
    const jul = snap().plans['2026-Q3'].batches.find((b) => b.monthKey === '2026-07')!;
    addCheck(fid, ex1, { date: jul.date, status: 'ok' });
    const countBefore = snap().plans['2026-Q3'].batches.length;
    carryBatch('2026-Q3', jul.id);
    expect(snap().plans['2026-Q3'].batches.length).toBe(countBefore);
  });
});

describe('巡检员与设置', () => {
  it('P5 增删改巡检员；删除后名下批次变为未指派；引用更新触发订阅', () => {
    setupBuilding();
    generatePlan('2026-Q3');
    const id = addInspector('临时员');
    expect(snap().inspectors.some((i) => i.id === id)).toBe(true);

    let notified = 0;
    const un = subscribe(() => notified++);
    updateInspector(id, { name: '临时员2', active: false });
    expect(snap().inspectors.find((i) => i.id === id)!.name).toBe('临时员2');

    // 把一批派给他再删除
    const someBatch = snap().plans['2026-Q3'].batches[0];
    updateBatch('2026-Q3', someBatch.id, { inspectorId: id });
    deleteInspector(id);
    un();
    expect(notified).toBeGreaterThan(0);
    expect(snap().plans['2026-Q3'].batches.find((b) => b.id === someBatch.id)!.inspectorId).toBeNull();
    expect(snap().inspectors.some((i) => i.id === id)).toBe(false);
  });

  it('P6 改日上限后重新排产：cap=1 时同日两批被顺延到不同工作日', () => {
    for (const b of [...snap().buildings]) deleteBuilding(b.id); // store 单例跨用例共享，先清空
    deletePlan('2026-Q3'); // 旧用例留下的 carried/已完成批会在重排时保留，先清掉
    // 两个楼层各放一个同日应检的灭火器，6 批均为 1 件；单人 cap=1，每月第二批发必须顺延一天
    const bid = addBuilding('上限楼', 'office');
    const f1 = addFloor(bid, 1);
    const f2 = addFloor(bid, 2);
    const a = addFacility(f1, 'extinguisher', 1, 1);
    const bb = addFacility(f2, 'extinguisher', 1, 1);
    addCheck(f1, a, { date: '2026-06-15', status: 'ok' });
    addCheck(f2, bb, { date: '2026-06-15', status: 'ok' });

    updatePlanSettings({ cap: 1 });
    // 只剩一个可用巡检员（store 是跨用例共享的单例，其他用例可能加过人），同日第二发必须顺延
    const all = snap().inspectors;
    for (const ins of all.slice(1)) updateInspector(ins.id, { active: false });
    updateInspector(all[0].id, { active: true });
    generatePlan('2026-Q3');
    const dates = snap().plans['2026-Q3'].batches.map((x) => x.date);
    expect(dates).toHaveLength(6);
    expect(new Set(dates).size).toBe(6); // 同一天一个人只能 1 件 → 全部错开
    // 7 月：15 日一批，另一批顺延 16 日并带原因
    const postpone = snap()
      .plans['2026-Q3'].batches
      .filter((x) => x.monthKey === '2026-07')
      .find((x) => x.date === '2026-07-16');
    expect(postpone?.postponeReason).toContain('人均日上限 1 件/人/天');
    updatePlanSettings({ cap: 30 });
  });

  it('P7 updateBatch/deleteBatch 替换计划内引用（UI 订阅语义）', () => {
    setupBuilding();
    generatePlan('2026-Q3');
    const plan0 = snap().plans['2026-Q3'];
    const b = plan0.batches[0];
    updateBatch('2026-Q3', b.id, { date: '2026-09-30' });
    const plan1 = snap().plans['2026-Q3'];
    expect(plan1).not.toBe(plan0);
    expect(plan1.batches).not.toBe(plan0.batches);
    deleteBatch('2026-Q3', b.id);
    expect(snap().plans['2026-Q3'].batches.some((x) => x.id === b.id)).toBe(false);
  });
});
