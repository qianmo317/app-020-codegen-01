/**
 * 季度派工计划验收用例：
 * - 各设施周期算应检日（月/季/半年）
 * - 同楼层同月设施必须同批；月检类季内逐月分批
 * - 工作日历（周末/节假日）、人均日上限超限顺延与原因
 * - 整批超上限不可拆、已查完自动划掉、未查完一键挪下一批
 * - 派工清单文本（按日期/按人）
 */
import { describe, it, expect } from 'vitest';
import type { Building, Facility, FacilityKind, Floor, Inspector, Room } from '../src/model';
import {
  addDaysStr,
  batchProgress,
  carryOverBatch,
  currentQuarter,
  dueOccurrences,
  firstWorkdayOnOrAfter,
  generateBatches,
  isWorkday,
  nextDueDate,
  nextWorkday,
  prevWorkdayOnOrBefore,
  quarterRange,
  renderDispatch,
  toolsFor,
} from '../src/lib/schedule';

const Q = '2026-Q3'; // 2026-07-01(周三) ~ 2026-09-30(周三)
const RANGE = quarterRange(Q);
let seq = 0;

function check(date: string, status: 'ok' = 'ok') {
  return { date, status };
}

function fac(kind: FacilityKind, checks: Facility['checks'] = [], code?: string): Facility {
  return {
    id: `f${seq++}`,
    kind,
    x: 0,
    y: 0,
    code: code ?? `${kind}-${seq}`,
    checks,
  };
}

function floor(level: number, facilities: Facility[]): Floor {
  return {
    id: `floor-${level}-${seq++}`,
    buildingId: 'b1',
    level,
    scaleMmPerUnit: 1,
    rooms: [] as Room[],
    facilities,
    exits: [],
    version: 0,
  };
}

function building(name: string, floorIds: string[]): Building {
  return { id: 'b1', name, kind: 'office', floors: floorIds, createdAt: '' };
}

function inspector(name: string): Inspector {
  return { id: `ins-${name}`, name, active: true };
}

function run(opts: {
  floors: Floor[];
  inspectors?: Inspector[];
  cap?: number;
  holidays?: string[];
  buildingName?: string;
  skipMonths?: Map<string, ReadonlySet<string>>;
}) {
  const fls = opts.floors;
  const floorsMap = Object.fromEntries(fls.map((f) => [f.id, f]));
  const b = building(opts.buildingName ?? '测试楼', fls.map((f) => f.id));
  return generateBatches({
    quarter: Q,
    buildings: [b],
    floors: floorsMap,
    inspectors: opts.inspectors ?? [inspector('甲')],
    cap: opts.cap ?? 30,
    holidays: opts.holidays ?? [],
    skipMonths: opts.skipMonths,
    now: new Date('2026-07-01T00:00:00').getTime(),
  });
}

describe('季度范围与工作日历', () => {
  it('Q1 quarterRange：季度首日与末日（含月末）', () => {
    expect(quarterRange('2026-Q1')).toEqual({ start: '2026-01-01', end: '2026-03-31' });
    expect(quarterRange('2026-Q4')).toEqual({ start: '2026-10-01', end: '2026-12-31' });
    expect(RANGE).toEqual({ start: '2026-07-01', end: '2026-09-30' });
  });

  it('currentQuarter 格式 YYYY-Qn', () => {
    expect(currentQuarter(new Date('2026-08-15').getTime())).toBe('2026-Q3');
    expect(currentQuarter(new Date('2026-01-01').getTime())).toBe('2026-Q1');
  });

  it('周末跳过：2026-07-04(周六) 的下一工作日是 07-06(周一)', () => {
    expect(isWorkday('2026-07-04', [])).toBe(false);
    expect(isWorkday('2026-07-06', [])).toBe(true);
    expect(nextWorkday('2026-07-03', [])).toBe('2026-07-06');
    expect(firstWorkdayOnOrAfter('2026-07-04', [])).toBe('2026-07-06');
  });

  it('节假日跳过（调休上班不在支持范围内，仅按周末+节假日）', () => {
    const holidays = ['2026-10-01', '2026-10-02'];
    expect(isWorkday('2026-10-01', holidays)).toBe(false);
    expect(firstWorkdayOnOrAfter('2026-10-01', holidays)).toBe('2026-10-05'); // 周五、周末跳过
    expect(prevWorkdayOnOrBefore('2026-10-01', holidays)).toBe('2026-09-30');
  });
});

describe('按周期算下次应检日与季内时点', () => {
  it('灭火器 30 天：最近检查 +30', () => {
    expect(nextDueDate(fac('extinguisher', [check('2026-06-15')]))).toBe('2026-07-15');
    expect(nextDueDate(fac('extinguisher', []))).toBeNull();
  });

  it('指示灯 90 天、安全出口 180 天', () => {
    expect(nextDueDate(fac('exit_sign', [check('2026-06-01')]))).toBe('2026-08-30');
    expect(nextDueDate(fac('exit', [check('2026-03-01')]))).toBe('2026-08-28');
  });

  it('月检设施季内产生 3 个应检时点（7/15、8/14、9/13）', () => {
    const occ = dueOccurrences(fac('extinguisher', [check('2026-06-15')]), RANGE);
    expect(occ.map((o) => o.due)).toEqual(['2026-07-15', '2026-08-14', '2026-09-13']);
  });

  it('180 天设施本季只有 1 个时点', () => {
    const occ = dueOccurrences(fac('sprinkler', [check('2026-03-01')]), RANGE);
    expect(occ.map((o) => o.due)).toEqual(['2026-08-28']);
  });

  it('已逾期：上次检查 2026-05-01 的灭火器（应检 5/31）→ 季初补检一批', () => {
    const occ = dueOccurrences(fac('extinguisher', [check('2026-05-01')]), RANGE);
    expect(occ[0]).toEqual({ due: '2026-05-31', on: '2026-07-01' });
    expect(occ.length).toBeGreaterThanOrEqual(3);
  });

  it('本季无需检查的设施（下次应检落在季末之后）→ 无时点', () => {
    // 安全出口 2026-05-01 检 → 应检 2026-10-28，Q3 内没有
    expect(dueOccurrences(fac('exit', [check('2026-05-01')]), RANGE)).toEqual([]);
  });

  it('从未检查 → 季初补检', () => {
    expect(dueOccurrences(fac('hydrant', []), RANGE)).toEqual([{ due: RANGE.start, on: RANGE.start }]);
  });

  it('携带工具按设施类型汇总（灭火器→压力表，喷淋→末端试水）', () => {
    expect(toolsFor(['extinguisher', 'sprinkler'])).toEqual(['压力表/称重检查工具', '末端试水装置']);
  });
});

describe('分批与派工', () => {
  it('同楼层同月的灭火器/指示灯/安全出口合为一批，工具合并；楼层不拆', () => {
    const f1 = floor(1, [
      fac('extinguisher', [check('2026-06-15')]), // 7/15、8/14、9/13
      fac('exit_sign', [check('2026-06-01')]), // 8/30
      fac('exit', [check('2026-03-01')]), // 8/28
    ]);
    const batches = run({ floors: [f1] });
    // 指示灯(8/30)与安全出口(8/28)同在 08 月合批（含月检灭火器 8/14）；07、09 月各一批
    expect(batches.length).toBe(3);
    const jul = batches.find((b) => b.monthKey === '2026-07')!;
    const aug = batches.find((b) => b.monthKey === '2026-08')!;
    const sep = batches.find((b) => b.monthKey === '2026-09')!;
    expect(jul.facilityIds).toHaveLength(1);
    expect(aug.facilityIds).toHaveLength(3);
    expect(sep.facilityIds).toHaveLength(1);
    expect(aug.tools).toContain('指示灯外观检查表');
    expect(aug.tools).toContain('安全出口巡查表');
    // 三批都在同一楼层
    expect(new Set(batches.map((b) => b.floorId)).size).toBe(1);
  });

  it('月检设施同一楼层季内产生 3 批（按月），批内设施不跨层', () => {
    const f1 = floor(1, [fac('extinguisher', [check('2026-06-15')]), fac('hydrant', [check('2026-06-15')])]);
    const f2 = floor(2, [fac('extinguisher', [check('2026-06-15')])]);
    const batches = run({ floors: [f1, f2] });
    const months = [...new Set(batches.map((b) => `${b.floorId}|${b.monthKey}`))];
    expect(months).toHaveLength(6); // 2 层 × 3 月
    for (const b of batches) {
      const fl = b.floorId === f1.id ? f1 : f2;
      for (const id of b.facilityIds) expect(fl.facilities.some((x) => x.id === id)).toBe(true);
    }
    // 1 层的每批固定 2 件（灭火器+消火栓不拆）
    for (const b of batches.filter((b) => b.floorId === f1.id)) expect(b.facilityIds).toHaveLength(2);
  });

  it('派工日只排工作日：应检日 7/4(周六) 提前到 7/3(周五)，不算顺延', () => {
    const f1 = floor(1, [fac('extinguisher', [check('2026-06-04')])]); // due 7/4 周六
    const batches = run({ floors: [f1] });
    const b = batches.find((x) => x.monthKey === '2026-07')!;
    expect(b.date).toBe('2026-07-03');
    expect(b.postponeReason).toBeUndefined();
  });

  it('逾期补检：季初 7/1 立即派第一批', () => {
    const f1 = floor(1, [fac('extinguisher', [check('2026-05-01')])]); // due 5/31 已逾期
    const batches = run({ floors: [f1] });
    expect(batches[0].date).toBe('2026-07-01');
    expect(batches[0].dueDate).toBe('2026-05-31');
  });

  it('节假日：应检日的最近工作日被设为假期时，继续提前到上一个工作日', () => {
    // 2026-07-24 检查的灭火器 → 应检 8/23(周日)，最近工作日是 8/21(周五)；
    // 把 8/21 也设为节假日 → 派到 8/20(周四)
    const f2 = floor(2, [fac('extinguisher', [check('2026-07-24')])]);
    const batches = run({ floors: [f2], holidays: ['2026-08-21'] });
    const b = batches.find((x) => x.monthKey === '2026-08')!;
    expect(b.date).toBe('2026-08-20');
  });

  it('人均日上限：同一天排不下就顺延到下一工作日，并写清顺延原因', () => {
    // 2 个楼层，每层 20 件（不同月只取 7 月一批），cap=30，1 个巡检员
    // 第一层 7/15 批 20 件；第二层也 7/15 批 20 件 → 当天只能再装 10 件 → 第二层顺延到 7/16
    const mk = (level: number) =>
      floor(
        level,
        Array.from({ length: 20 }, (_, i) => fac(i % 2 ? 'hydrant' : 'extinguisher', [check('2026-06-15')])),
      );
    const f1 = mk(1);
    const f2 = mk(2);
    const batches = run({ floors: [f1, f2], cap: 30 });
    const jul = batches.filter((b) => b.monthKey === '2026-07');
    expect(jul).toHaveLength(2);
    const [first, second] = jul;
    expect(first.date).toBe('2026-07-15');
    expect(second.date).toBe('2026-07-16');
    expect(second.postponeReason).toContain('人均日上限 30 件/人/天');
    expect(second.postponeReason).toContain('同楼层 20 件必须同批');
    expect(second.postponeReason).toContain('2026-07-16');
  });

  it('两个巡检员可分担同日批次，不触发顺延', () => {
    const mk = (level: number) => floor(level, [fac('extinguisher', [check('2026-06-15')])]);
    const batches = run({ floors: [mk(1), mk(2)], cap: 1, inspectors: [inspector('甲'), inspector('乙')] });
    const jul = batches.filter((b) => b.monthKey === '2026-07');
    expect(jul.map((b) => b.date)).toEqual(['2026-07-15', '2026-07-15']);
    expect(new Set(jul.map((b) => b.inspectorId)).size).toBe(2);
  });

  it('整批数量超过单人上限：不可拆分，整批派给一人并置 overCap 警告', () => {
    const f1 = floor(1, Array.from({ length: 40 }, () => fac('extinguisher', [check('2026-06-15')])));
    const batches = run({ floors: [f1], cap: 30 });
    const b = batches.find((x) => x.monthKey === '2026-07')!;
    expect(b.overCap).toBe(true);
    expect(b.facilityIds).toHaveLength(40);
    expect(b.postponeReason).toContain('超过单人单日上限 30 件');
    expect(b.postponeReason).toContain('不能拆批');
  });

  it('停用的巡检员不参与派工；无巡检员时批次无指派人并提示', () => {
    const f1 = floor(1, [fac('extinguisher', [check('2026-06-15')])]);
    const off: Inspector = { id: 'off', name: '休假', active: false };
    const b1 = run({ floors: [f1], inspectors: [off] })[0];
    expect(b1.inspectorId).toBeNull();
    expect(b1.postponeReason).toContain('暂无可用巡检员');
  });

  it('skipMonths：重新排产时已完成批覆盖的「楼层×应检月」不再重排', () => {
    const f1 = floor(1, [fac('extinguisher', [check('2026-06-15')])]);
    // 7 月这批（应检 7/15）已完成并保留 → 续算的 8/14、9/13 仍要排
    const skip = new Map<string, ReadonlySet<string>>([[f1.id, new Set(['2026-07'])]]);
    const batches = run({ floors: [f1], skipMonths: skip });
    expect(batches.some((b) => b.monthKey === '2026-07')).toBe(false);
    expect(batches.some((b) => b.monthKey === '2026-08')).toBe(true);
    expect(batches.some((b) => b.monthKey === '2026-09')).toBe(true);
  });

  it('skipMonths 按月检续算后的真实应检月跳过（月中完成检查，下一周期落回同计划月的情况）', () => {
    // 7/15 应检的设施在 7/20 才查 → 下次应检 8/19；若原 8 月批已保留（覆盖 08 月），8/19 这次也不重排
    const f1 = floor(1, [fac('extinguisher', [check('2026-06-20')])]); // due 7/20、8/19、9/18
    const skip = new Map<string, ReadonlySet<string>>([
      [f1.id, new Set(['2026-07', '2026-08'])],
    ]);
    const batches = run({ floors: [f1], skipMonths: skip });
    expect(batches.map((b) => b.monthKey)).toEqual(['2026-09']);
  });
});

describe('完成判定与一键顺延', () => {
  it('全部设施有派工日之后的检查记录 → 已完成；提前检查的不算', () => {
    const a = fac('extinguisher', [check('2026-06-15')]);
    const b = fac('hydrant', [check('2026-06-15')]);
    const f1 = floor(1, [a, b]);
    const batches = run({ floors: [f1] });
    const batch = batches.find((x) => x.monthKey === '2026-07')!;
    const floorsMap = { [f1.id]: f1 };
    expect(batchProgress(batch, floorsMap).completed).toBe(false);

    a.checks.push(check(batch.date)); // 派工当天检查
    expect(batchProgress(batch, floorsMap).completed).toBe(false); // b 还没
    b.checks.push(check(addDaysStr(batch.date, 2))); // 补检
    expect(batchProgress(batch, floorsMap).completed).toBe(true);
  });

  it('派工日之前的检查不计本批完成（防提前登记把批算掉）', () => {
    // 应检 7/16（周四）的批提前到工作日 7/15 派；7/14 的记录早于派工日，不算这批完成
    const a = fac('extinguisher', [check('2026-06-16'), check('2026-07-14')]);
    const f1 = floor(1, [a]);
    // 注意：最近记录是 7/14，故批次依据改为 8/13 一批；这里直接验证规则——应检 8/13 的批派在 8/13，
    // 7/14 的记录不满足「派工日当天或之后」
    const batch = run({ floors: [f1] }).find((x) => x.monthKey === '2026-08')!;
    expect(batch.date).toBe('2026-08-13');
    expect(batchProgress(batch, { [f1.id]: f1 }).completed).toBe(false);
  });

  it('一键顺延：未查完的设施挪到下一工作日的新批', () => {
    const a = fac('extinguisher', [check('2026-06-15')]);
    const b = fac('hydrant', [check('2026-06-15')]);
    const f1 = floor(1, [a, b]);
    const batch = run({ floors: [f1] }).find((x) => x.monthKey === '2026-07')!; // 7/15 周三
    a.checks.push(check(batch.date)); // a 已查、b 未查
    const moved = carryOverBatch(batch, { [f1.id]: f1 }, [])!;
    expect(moved.carryover).toBe(true);
    expect(moved.facilityIds).toEqual([b.id]);
    expect(moved.date).toBe('2026-07-16');
    expect(moved.postponeReason).toContain('1 件未查完');
  });

  it('周五未查完 → 顺延跨过周末到周一', () => {
    const a = fac('extinguisher', [check('2026-06-19')]); // +30 = 7/19 周日 → ideal 7/17 周五
    const f1 = floor(1, [a]);
    const batch = run({ floors: [f1] }).find((x) => x.monthKey === '2026-07')!;
    expect(batch.date).toBe('2026-07-17');
    const moved = carryOverBatch(batch, { [f1.id]: f1 }, [])!;
    expect(moved.date).toBe('2026-07-20'); // 周一
    expect(moved.postponeReason).toContain('跨非工作日');
  });

  it('已全部查完 → carryOverBatch 返回 null', () => {
    const a = fac('extinguisher', [check('2026-06-15')]);
    const f1 = floor(1, [a]);
    const batch = run({ floors: [f1] }).find((x) => x.monthKey === '2026-07')!;
    a.checks.push(check(batch.date));
    expect(carryOverBatch(batch, { [f1.id]: f1 }, [])).toBeNull();
  });
});

describe('派工清单文本（贴群）', () => {
  it('按日期分组：含日期、巡检员、楼栋楼层、件数、携带物、顺延说明；已完成批不出现', () => {
    const a = fac('extinguisher', [check('2026-06-15')]); // 7/15、8/14、9/13
    const b = fac('exit', [check('2026-03-01')]); // 8/28，与灭火器同在 8 月合批，派工日取 8/14
    const f1 = floor(1, [a, b]);
    const ins = inspector('王师傅');
    const batches = run({ floors: [f1], inspectors: [ins], buildingName: 'A 座' });
    const text = renderDispatch(batches, { [f1.id]: f1 }, 'date', [ins]);
    expect(text).toContain('消防设施季度检查派工清单');
    expect(text).toContain('【2026-07-15 周三】');
    expect(text).toContain('王师傅｜A 座 1F｜1 件｜携带：压力表/称重检查工具');
    expect(text).toContain('【2026-08-14 周五】');
    expect(text).toContain('安全出口巡查表');
    // 8 月这批含两个设施（2 件）
    expect(text).toMatch(/2026-08-14[\s\S]*?2 件/);

    // 7 月这批查完后不再出现在清单里（8 月合批不受影响）
    a.checks.push(check('2026-07-15'));
    const text2 = renderDispatch(batches, { [f1.id]: f1 }, 'date', [ins]);
    expect(text2).not.toContain('【2026-07-15');
    expect(text2).toContain('【2026-08-14 周五】');
  });

  it('按巡检员分组', () => {
    const f1 = floor(1, [fac('extinguisher', [check('2026-06-15')])]);
    const f2 = floor(2, [fac('extinguisher', [check('2026-06-15')])]);
    const ins = [inspector('甲'), inspector('乙')];
    const batches = run({ floors: [f1, f2], cap: 1, inspectors: ins });
    const text = renderDispatch(batches, { [f1.id]: f1, [f2.id]: f2 }, 'inspector', ins);
    expect(text).toContain('【甲】');
    expect(text).toContain('【乙】');
  });
});
