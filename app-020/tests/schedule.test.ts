/**
 * 季度检查排程验收用例：
 * - 各类型设施按自身周期算应检日（月/季/半年）；
 * - 同层整批、按人日容量上限顺延并写清原因（周末/节假日/排满/整层超限）；
 * - 已查自动划掉、未查完一键顺延；
 * - 派工清单按日期/按人导出。
 */
import { describe, it, expect } from 'vitest';
import type { Building, CheckRecord, Facility, FacilityKind, Floor } from '../src/model';
import {
  addDays,
  nextWorkingDay,
  quarterRange,
  weekdayCN,
} from '../src/lib/date';
import {
  batchProgress,
  buildQuarterUnits,
  carryOverBatches,
  dispatchText,
  facilityQuarterItem,
  generatePlan,
  toolsForKinds,
} from '../src/lib/schedule';

// 固定时钟：2026-01-01（周四），Q1 = 01-01 ~ 03-31
const NOW = new Date('2026-01-01T12:00:00').getTime();
const Y = 2026;
const Q = 1;
const INSP = ['i-zhang', 'i-li'];

function check(daysFromJan1: number, status: CheckRecord['status'] = 'ok'): CheckRecord {
  return { date: addDays('2026-01-01', daysFromJan1), status };
}

function mkFac(kind: FacilityKind, idx: number, checks: CheckRecord[] = []): Facility {
  return {
    id: `f-${kind}-${idx}`,
    kind,
    x: 0,
    y: 0,
    code: `1F-${kind}-${String(idx).padStart(2, '0')}`,
    checks,
  };
}

type FloorSpec = {
  fid: string;
  level: number;
  facs: { kind: FacilityKind; checks?: CheckRecord[] }[];
};

function mkWorld(specs: FloorSpec[]) {
  const buildings: Building[] = [
    { id: 'b1', name: '一号楼', kind: 'office', floors: specs.map((s) => s.fid), createdAt: '2025-01-01' },
  ];
  const floors: Record<string, Floor> = {};
  for (const s of specs) {
    const seq = new Map<FacilityKind, number>();
    const facilities: Facility[] = s.facs.map((fc) => {
      const n = (seq.get(fc.kind) ?? 0) + 1;
      seq.set(fc.kind, n);
      const f = mkFac(fc.kind, n, fc.checks ?? []);
      f.code = `${s.level >= 1 ? s.level : `B${-s.level}`}F-${f.kind}-${String(n).padStart(2, '0')}`;
      f.id = `${s.fid}-${fc.kind}-${n}`;
      return f;
    });
    floors[s.fid] = {
      id: s.fid,
      buildingId: 'b1',
      level: s.level,
      scaleMmPerUnit: 1,
      rooms: [],
      facilities,
      exits: facilities.filter((f) => f.kind === 'exit').map((f) => f.id),
      version: 0,
    };
  }
  return { buildings, floors };
}

describe('facilityQuarterItem（按各自周期算本季应检日）', () => {
  it('L1 灭火器 30 天：12-15 检查 → 01-14 应检，落 Q1', () => {
    const fac = mkFac('extinguisher', 1, [check(-17)]);
    const item = facilityQuarterItem(fac, { id: 'fl', buildingId: 'b' }, Y, Q, NOW);
    expect(item?.dueDate).toBe('2026-01-14');
  });

  it('L2 消火栓同为 30 天周期', () => {
    const fac = mkFac('hydrant', 1, [check(-17)]);
    expect(facilityQuarterItem(fac, { id: 'fl', buildingId: 'b' }, Y, Q, NOW)?.dueDate).toBe('2026-01-14');
  });

  it('L3 指示灯 90 天：11-15 检查 → 02-13 应检，落 Q1', () => {
    const fac = mkFac('exit_sign', 1, [check(-47)]);
    expect(facilityQuarterItem(fac, { id: 'fl', buildingId: 'b' }, Y, Q, NOW)?.dueDate).toBe('2026-02-13');
  });

  it('L4 应急照明 90 天：10-20 检查 → 01-18 应检', () => {
    const fac = mkFac('emergency_light', 1, [check(-73)]);
    expect(facilityQuarterItem(fac, { id: 'fl', buildingId: 'b' }, Y, Q, NOW)?.dueDate).toBe('2026-01-18');
  });

  it('L5 安全出口/喷淋 180 天：季内不到期返回 null；会在季内到期的仍纳入', () => {
    // -30 检查 → 2026-01-31 +180 天前 = 2025-07-05 检查，到期 2026-01-01，在 Q1
    expect(
      facilityQuarterItem(mkFac('exit', 1, [check(-180)]), { id: 'fl', buildingId: 'b' }, Y, Q, NOW)?.dueDate,
    ).toBe('2026-01-01');
    // 2026-01-01 + 180 = 06-30（Q2 末），对 Q1 而言已在季末之后? 不，06-30 > 03-31 → 不纳入 Q1
    expect(
      facilityQuarterItem(mkFac('sprinkler', 1, [check(0)]), { id: 'fl', buildingId: 'b' }, Y, Q, NOW),
    ).toBeNull();
  });

  it('L6 安全出口 200 天前检（逾期）→ 180 天周期在 Q1 内无再到期，应检日保留季初逾期锚点', () => {
    // 2025-06-15 + 180 = 2025-12-12（< 季首），+180 = 2026-06-10（> 季末）
    const item = facilityQuarterItem(mkFac('exit', 1, [check(-200)]), { id: 'fl', buildingId: 'b' }, Y, Q, NOW);
    expect(item?.dueDate).toBe('2025-12-12');
  });

  it('L7 灭火器 200 天前检（逾期）→ 季内还有到期日，取季内第一个（2026-01-11）', () => {
    // 2025-06-15 起逐次 +30：…12-12 → 2026-01-11，是首个 >= 2026-01-01 的
    const item = facilityQuarterItem(mkFac('extinguisher', 1, [check(-200)]), { id: 'fl', buildingId: 'b' }, Y, Q, NOW);
    expect(item?.dueDate).toBe('2026-01-11');
  });

  it('L8 从未检查过 → 季首即应检（尽快补检）', () => {
    const item = facilityQuarterItem(mkFac('sprinkler', 1, []), { id: 'fl', buildingId: 'b' }, Y, Q, NOW);
    expect(item?.dueDate).toBe(quarterRange(Y, Q).start);
    expect(item?.basedOnCheck).toBeNull();
  });
});

describe('buildQuarterUnits（按楼栋/楼层归并）', () => {
  it('L9 同一楼层的多类设施归并成一个单元，anchorDue 取层内最早应检日', () => {
    const { buildings, floors } = mkWorld([
      {
        fid: 'fl1',
        level: 1,
        facs: [
          { kind: 'extinguisher', checks: [check(-17)] }, // 01-14
          { kind: 'exit_sign', checks: [check(-47)] }, // 02-13
          { kind: 'exit', checks: [check(-10)] }, // 半年周期，不在本季
        ],
      },
    ]);
    const units = buildQuarterUnits(buildings, floors, Y, Q, NOW);
    expect(units).toHaveLength(1);
    expect(units[0].items).toHaveLength(2);
    expect(units[0].anchorDue).toBe('2026-01-14');
    // 每类设施都在
    expect(units[0].items.map((i) => i.kind).sort()).toEqual(['exit_sign', 'extinguisher']);
  });

  it('L10 不到期的楼层不出现在清单里', () => {
    const { buildings, floors } = mkWorld([
      { fid: 'fl1', level: 1, facs: [{ kind: 'exit', checks: [check(-10)] }, { kind: 'sprinkler', checks: [check(-30)] }] },
    ]);
    expect(buildQuarterUnits(buildings, floors, Y, Q, NOW)).toHaveLength(0);
  });
});

describe('generatePlan（批次/容量/顺延）', () => {
  const settings = { inspectorIds: INSP, dailyCap: 10, holidays: new Set<string>() };

  it('L11 每层一批：两层各 3 项同季应检，两人各拿一层，都排在 01-01（周四工作日）', () => {
    const { buildings, floors } = mkWorld([
      { fid: 'A', level: 1, facs: Array.from({ length: 3 }, () => ({ kind: 'extinguisher' as const })) },
      { fid: 'B', level: 2, facs: Array.from({ length: 3 }, () => ({ kind: 'extinguisher' as const })) },
    ]);
    const plan = generatePlan(buildings, floors, Y, Q, settings, NOW);
    expect(plan.batches).toHaveLength(2);
    expect(plan.batches.every((b) => b.date === '2026-01-01')).toBe(true);
    expect(new Set(plan.batches.map((b) => b.inspectorId)).size).toBe(2); // 两人摊派
    // 季首即工作日，未顺延、无说明
    expect(plan.batches.every((b) => b.postponement === null)).toBe(true);
  });

  it('L12 同层设施必须在同一批（不被日容量拆开）', () => {
    const { buildings, floors } = mkWorld([
      { fid: 'A', level: 1, facs: Array.from({ length: 10 }, () => ({ kind: 'extinguisher' as const })) },
      { fid: 'B', level: 2, facs: Array.from({ length: 10 }, () => ({ kind: 'extinguisher' as const })) },
    ]);
    const plan = generatePlan(buildings, floors, Y, Q, settings, NOW);
    const a = plan.batches.find((b) => b.floorIds.includes('A'))!;
    const b2 = plan.batches.find((b) => b.floorIds.includes('B'))!;
    expect(a.items).toHaveLength(10);
    expect(b2.items).toHaveLength(10);
    // 两人当天各 10，恰好打满
    expect(a.date).toBe(b2.date);
  });

  it('L13 超上限：第三个同应检日楼层顺延到下一工作日，原因写「排满」与具体日期', () => {
    const { buildings, floors } = mkWorld([
      { fid: 'A', level: 1, facs: Array.from({ length: 10 }, () => ({ kind: 'extinguisher' as const })) },
      { fid: 'B', level: 2, facs: Array.from({ length: 10 }, () => ({ kind: 'extinguisher' as const })) },
      { fid: 'C', level: 3, facs: Array.from({ length: 6 }, () => ({ kind: 'extinguisher' as const })) },
    ]);
    const plan = generatePlan(buildings, floors, Y, Q, settings, NOW);
    const c = plan.batches.find((b) => b.floorIds.includes('C'))!;
    expect(c.date).toBe('2026-01-02'); // 01-01 两人都满 10，次日（周五）才有名额
    expect(c.postponement).toContain('排满');
    expect(c.postponement).toContain('2026-01-02');
  });

  it('L14 应检日是周末 → 顺移到周一并说明周末', () => {
    // 2026-01-28 + 30 = 2026-02-27 周五；取应检为 01-31（周六）的构造：
    // 最后检查 2026-01-01 + 30 = 01-31 周六
    const { buildings, floors } = mkWorld([
      { fid: 'E', level: 5, facs: Array.from({ length: 2 }, (_, i) => ({ kind: 'extinguisher', checks: [check(0 + i * 0)] })) },
    ]);
    // 两具都在 01-01 检查 → due 01-31
    const plan = generatePlan(buildings, floors, Y, Q, settings, NOW);
    const b = plan.batches[0];
    expect(weekdayCN('2026-01-31')).toBe('六');
    expect(b.date).toBe('2026-02-02'); // 周一
    expect(b.postponement).toContain('周末');
  });

  it('L15 节假日顺延：02-16(周一) 起按节假日 + 周末跳过', () => {
    // 应检 02-16：最后检查 01-17（+30 = 02-16）
    const { buildings, floors } = mkWorld([
      { fid: 'F', level: 6, facs: [{ kind: 'extinguisher', checks: [check(16)] }] },
    ]);
    const holidays = new Set(['2026-02-16', '2026-02-17']);
    const plan = generatePlan(buildings, floors, Y, Q, { ...settings, holidays }, NOW);
    expect(plan.batches[0].date).toBe('2026-02-18'); // 周三
    expect(plan.batches[0].postponement).toContain('节假日');
  });

  it('L16 单层 12 项 > 上限 10：独占一人一天不拆层，标注「增援或加班」', () => {
    const { buildings, floors } = mkWorld([
      { fid: 'A', level: 1, facs: Array.from({ length: 12 }, () => ({ kind: 'extinguisher' as const })) },
    ]);
    const plan = generatePlan(buildings, floors, Y, Q, settings, NOW);
    expect(plan.batches).toHaveLength(1);
    expect(plan.batches[0].items).toHaveLength(12);
    expect(plan.batches[0].postponement).toContain('整层须同批不可拆');
  });

  it('L17 空检查人列表直接报错', () => {
    const { buildings, floors } = mkWorld([{ fid: 'A', level: 1, facs: [{ kind: 'extinguisher' }] }]);
    expect(() => generatePlan(buildings, floors, Y, Q, { inspectorIds: [], dailyCap: 10, holidays: new Set() }, NOW)).toThrow();
  });

  it('L18 批次按日期、检查人顺序排序；工具按设施类型并集', () => {
    const { buildings, floors } = mkWorld([
      { fid: 'A', level: 1, facs: [{ kind: 'extinguisher' }, { kind: 'hydrant' }] },
    ]);
    const plan = generatePlan(buildings, floors, Y, Q, settings, NOW);
    const dates = plan.batches.map((b) => b.date);
    expect(dates).toEqual([...dates].sort());
    expect(toolsForKinds(['extinguisher', 'hydrant'])).toContain('压力表');
    expect(toolsForKinds(['extinguisher', 'hydrant'])).toContain('消火栓扳手');
  });
});

describe('自动划掉与一键顺延', () => {
  function planWithTwoFloors() {
    const world = mkWorld([
      { fid: 'A', level: 1, facs: Array.from({ length: 10 }, () => ({ kind: 'extinguisher' as const })) },
      { fid: 'B', level: 2, facs: Array.from({ length: 6 }, () => ({ kind: 'extinguisher' as const })) },
    ]);
    const settings = { inspectorIds: INSP, dailyCap: 10, holidays: new Set<string>() };
    const plan = generatePlan(world.buildings, world.floors, Y, Q, settings, NOW);
    return { world, plan };
  }
  it('L19 批次日期当天及之后有检查记录 → 完成并自动划掉；之前的记录不算', () => {
    const { world, plan } = planWithTwoFloors();
    const batchA = plan.batches.find((b) => b.floorIds.includes('A'))!;
    expect(batchProgress(batchA, world.floors, NOW).completed).toBe(false);

    // 给 A 层前 9 具在批次当天补检查
    const aFacs = world.floors.A.facilities.slice(0, 9);
    for (const f of aFacs) f.checks.push({ date: batchA.date, status: 'ok' });
    let p = batchProgress(batchA, world.floors, NOW);
    expect(p.completed).toBe(false);
    expect(p.checked).toBe(9);

    // 最后一具在次日检查（>= 批次日期，算完成）
    world.floors.A.facilities[9].checks.push({ date: addDays(batchA.date, 1), status: 'ok' });
    p = batchProgress(batchA, world.floors, NOW);
    expect(p.completed).toBe(true);
    expect(p.checked).toBe(10);

    // 批次日之前的旧记录不应当成完成（构造一个新批次验证）
    const { world: w2, plan: p2 } = planWithTwoFloors();
    const b2 = p2.batches.find((x) => x.floorIds.includes('B'))!;
    w2.floors.B.facilities[0].checks.push({ date: addDays(b2.date, -1), status: 'ok' });
    expect(batchProgress(b2, w2.floors, NOW).checked).toBe(0);
  });

  it('L20 一键顺延：未查完设施成组挪到下一工作日，优先沿用原检查人，已完成设施留原批', () => {
    const { world, plan } = planWithTwoFloors();
    const batchA = plan.batches.find((b) => b.floorIds.includes('A'))!; // 01-01, 10 项
    const batchB = plan.batches.find((b) => b.floorIds.includes('B'))!; // 01-01 另一人, 6 项

    // A 层完成 7 项（当天检查），B 全未做
    for (const f of world.floors.A.facilities.slice(0, 7)) f.checks.push({ date: batchA.date, status: 'ok' });

    const nextDay = nextWorkingDay(addDays(batchA.date, 1), new Set()); // 01-02
    const isDone = (it: { facilityId: string; floorId: string }, bd: string) =>
      world.floors[it.floorId].facilities.find((f) => f.id === it.facilityId)!.checks.some((c) => c.date >= bd);

    const newBatches = carryOverBatches(plan, [batchA.id], isDone, NOW);

    // 源批保留：只剩已完成的 7 项（自动划掉留痕）
    const src = newBatches.find((b) => b.id === batchA.id)!;
    expect(src.items).toHaveLength(7);
    expect(src.floorIds).toEqual(['A']);

    // 新批次：3 项、次日、原检查人、A 层整层
    const moved = newBatches.filter((b) => b.id !== batchA.id && b.id !== batchB.id);
    expect(moved).toHaveLength(1);
    expect(moved[0].date).toBe(nextDay);
    expect(moved[0].inspectorId).toBe(batchA.inspectorId);
    expect(moved[0].floorIds).toEqual(['A']);
    expect(moved[0].items).toHaveLength(3);
    expect(moved[0].carriedOver).toBe(true);
    expect(moved[0].postponement).toContain('原批次未查完');

    // B 不受影响
    const bStill = newBatches.find((b) => b.id === batchB.id)!;
    expect(bStill.items).toHaveLength(6);
  });

  it('L21 顺延遇到容量不足会继续顺延（原检查人次日已满则换人）', () => {
    // A、B 各 10 项占满 01-01；C 6 项在 01-02 给了其中一人。顺延 A 的 10 项时：
    // 原检查人 01-02 有 C 的 6 项（+10 超 10 上限）→ 换给当天空闲的另一人；
    // 若两人次日都占着，则继续往后顺延。
    const world = mkWorld([
      { fid: 'A', level: 1, facs: Array.from({ length: 10 }, () => ({ kind: 'extinguisher' as const })) },
      { fid: 'B', level: 2, facs: Array.from({ length: 10 }, () => ({ kind: 'extinguisher' as const })) },
      { fid: 'C', level: 3, facs: Array.from({ length: 6 }, () => ({ kind: 'extinguisher' as const })) },
    ]);
    const settings = { inspectorIds: INSP, dailyCap: 10, holidays: new Set<string>() };
    const plan = generatePlan(world.buildings, world.floors, Y, Q, settings, NOW);
    const batchA = plan.batches.find((b) => b.floorIds.includes('A'))!;
    const batchC = plan.batches.find((b) => b.floorIds.includes('C'))!;
    expect(batchC.date).toBe('2026-01-02');
    const isDone = () => false; // 全未做
    const next = carryOverBatches(plan, [batchA.id], isDone, NOW);
    const moved = next.find((b) => b.floorIds.includes('A') && b.id !== batchA.id)!;
    expect(moved.items).toHaveLength(10);
    expect(moved.date).toBe('2026-01-02'); // 次日即有另一人空闲
    expect(moved.inspectorId).not.toBe(batchA.inspectorId); // 原检查人次日有 C，换人
    expect(moved.postponement).toContain('原批次未查完');
  });
});

describe('dispatchText（贴群派工清单）', () => {
  const resolveFloor = (fid: string) => ({ buildingName: '一号楼', label: fid === 'A' ? '1F' : '2F' });
  const resolveInspector = (id: string) => (id === 'i-zhang' ? '张工' : '李工');

  it('L24 端到端：排程 → 部分检查自动划掉 → 一键顺延 → 两视图派工文本', () => {
    // 3 个楼层：A/B 各 10 项占满季首日，C 4 项顺延到次日
    const world = mkWorld([
      { fid: 'A', level: 1, facs: Array.from({ length: 10 }, () => ({ kind: 'extinguisher' as const })) },
      { fid: 'B', level: 2, facs: Array.from({ length: 10 }, () => ({ kind: 'extinguisher' as const })) },
      { fid: 'C', level: 3, facs: Array.from({ length: 4 }, () => ({ kind: 'hydrant' as const })) },
    ]);
    const settings = { inspectorIds: INSP, dailyCap: 10, holidays: new Set<string>() };
    const plan0 = generatePlan(world.buildings, world.floors, Y, Q, settings, NOW);
    expect(plan0.batches).toHaveLength(3);

    // A 批全部完成、B 批完成一半、C 未做（在各批次当天登记检查）
    const byFloor = new Map(plan0.batches.map((b) => [b.floorIds[0], b]));
    for (const f of world.floors.A.facilities) f.checks.push({ date: byFloor.get('A')!.date, status: 'ok' });
    for (const f of world.floors.B.facilities.slice(0, 5)) f.checks.push({ date: byFloor.get('B')!.date, status: 'ok' });

    // 自动划掉：A 完成；B 5/10 未完成；C 0/4
    expect(batchProgress(byFloor.get('A')!, world.floors, NOW).completed).toBe(true);
    expect(batchProgress(byFloor.get('B')!, world.floors, NOW).checked).toBe(5);
    expect(batchProgress(byFloor.get('C')!, world.floors, NOW).completed).toBe(false);

    // 一键顺延全部批次（A 全完成应原样保留，B 部分搬走，C 全搬走）
    const isDone = (it: { facilityId: string; floorId: string }, bd: string) =>
      world.floors[it.floorId].facilities.find((f) => f.id === it.facilityId)!.checks.some((c) => c.date >= bd);
    const plan: typeof plan0 = { ...plan0, batches: carryOverBatches(plan0, plan0.batches.map((b) => b.id), isDone, NOW) };

    // A 仍在且 10 项；B 源批剩 5 项 + 新批 5 项；C 消失（全未做）→ 新批 4 项
    const aBatches = plan.batches.filter((b) => b.floorIds.includes('A'));
    expect(aBatches).toHaveLength(1);
    expect(aBatches[0].items).toHaveLength(10);
    const bSrc = plan.batches.find((b) => b.id === byFloor.get('B')!.id)!;
    expect(bSrc.items).toHaveLength(5);
    const bMoved = plan.batches.filter((b) => b.floorIds.includes('B') && b.id !== bSrc.id);
    expect(bMoved[0].items).toHaveLength(5);
    expect(bMoved[0].postponement).toContain('原批次未查完');
    const cMoved = plan.batches.filter((b) => b.floorIds.includes('C'));
    expect(cMoved).toHaveLength(1);
    expect(cMoved[0].items).toHaveLength(4);

    // 派工文本（按日期/按人）都包含顺延批次与工具
    const doneIds = new Set(aBatches.map((b) => b.id));
    const byDate = dispatchText(plan, resolveFloor, resolveInspector, { mode: 'date', now: NOW });
    const byPerson = dispatchText(plan, resolveFloor, resolveInspector, { mode: 'person', now: NOW });
    expect(byDate).toContain('消火栓扳手');
    expect(byPerson).toContain('批）');
    // 只看待办时已完成的 A 批不出现楼层明细
    const pending = dispatchText(plan, resolveFloor, resolveInspector, { mode: 'date', onlyPending: true, completedIds: doneIds, now: NOW });
    expect(pending).not.toContain('一号楼1F');
  });

  it('L22 按日期视图：日期分组、检查人、楼层、数量、工具、顺延说明都在', () => {
    const world = mkWorld([
      { fid: 'A', level: 1, facs: [{ kind: 'extinguisher' }, { kind: 'hydrant' }] },
      { fid: 'B', level: 2, facs: [{ kind: 'exit_sign' }] },
    ]);
    const plan = generatePlan(world.buildings, world.floors, Y, Q, { inspectorIds: INSP, dailyCap: 1, holidays: new Set() }, NOW);
    // dailyCap=1：三层? 不，两层共 3 项 → 必出现顺延
    const txt = dispatchText(plan, resolveFloor, resolveInspector, { mode: 'date', now: NOW });
    expect(txt).toContain('季度消防设施检查派工');
    expect(txt).toContain('张工');
    expect(txt).toContain('一号楼1F');
    expect(txt).toContain('消火栓扳手'); // 工具并集
    expect(txt).toContain('顺延');
    expect(txt).toContain('上限 1 项/人·天');
  });

  it('L23 按人视图按检查人分组；只看待办时已完成批次被过滤', () => {
    const world = mkWorld([
      { fid: 'A', level: 1, facs: Array.from({ length: 2 }, () => ({ kind: 'extinguisher' as const })) },
    ]);
    const plan = generatePlan(world.buildings, world.floors, Y, Q, { inspectorIds: INSP, dailyCap: 10, holidays: new Set() }, NOW);
    const byPerson = dispatchText(plan, resolveFloor, resolveInspector, { mode: 'person', now: NOW });
    expect(byPerson).toMatch(/张工（\d+ 批）/);

    // 全部完成后 onlyPending 输出「暂无待派工」
    for (const f of world.floors.A.facilities) f.checks.push({ date: plan.batches[0].date, status: 'ok' });
    const doneIds = new Set(plan.batches.map((b) => b.id)); // 模拟 UI 计算
    const pendingTxt = dispatchText(plan, resolveFloor, resolveInspector, {
      mode: 'person',
      onlyPending: true,
      completedIds: doneIds,
      now: NOW,
    });
    expect(pendingTxt).toContain('暂无待派工');
  });
});
