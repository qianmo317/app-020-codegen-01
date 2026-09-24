/**
 * 季度检查派工计划（纯逻辑，全部可单测）：
 * - 每类设施按自己的周期算下次应检日：灭火器/消火栓 30 天、指示灯/应急照明 90 天、安全出口/喷淋 180 天
 * - 同一楼层的设施必须在同一批：以「楼层 × 应检月份」归组，月检类季内最多产生 3 批
 * - 派工日只排工作日（跳过周末与法定节假日）；每人每天有量的上限，超了整批顺延到下一工作日并记录原因
 */
import type {
  Facility,
  FacilityKind,
  Floor,
  Inspector,
  ScheduleBatch,
} from '../model';
import { CHECK_INTERVAL_DAYS } from '../rules/defaults';
import { uid } from '../store/id';

const DAY_MS = 86400000;
const p2 = (v: number) => String(v).padStart(2, '0');

// ---------- 日期工具（一律本地时区，YYYY-MM-DD） ----------

export function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

export function parseDate(s: string): Date {
  return new Date(`${s}T00:00:00`);
}

export function addDaysStr(s: string, n: number): string {
  return toDateStr(new Date(parseDate(s).getTime() + n * DAY_MS));
}

export function currentQuarter(now: number = Date.now()): string {
  const d = new Date(now);
  return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`;
}

export function quarterLabel(q: string): string {
  const [year, qn] = q.split('-Q');
  return `${year} 年第 ${qn} 季度`;
}

/** 季度起止日期（含端点），如 2026-Q3 → 2026-07-01 ~ 2026-09-30 */
export function quarterRange(quarter: string): { start: string; end: string } {
  const [yearStr, qStr] = quarter.split('-Q');
  const year = Number(yearStr);
  const qn = Number(qStr);
  const startMonth = (qn - 1) * 3;
  const start = new Date(year, startMonth, 1);
  const end = new Date(year, startMonth + 3, 0); // 下一季度第 0 天 = 本季末
  return { start: toDateStr(start), end: toDateStr(end) };
}

/** 该季度包含的月份键（YYYY-MM），按时间序 */
export function quarterMonths(quarter: string): string[] {
  const { start } = quarterRange(quarter);
  const d = parseDate(start);
  return [0, 1, 2].map((i) => {
    const m = new Date(d.getFullYear(), d.getMonth() + i, 1);
    return `${m.getFullYear()}-${p2(m.getMonth() + 1)}`;
  });
}

// ---------- 工作日历 ----------

export function isWeekend(s: string): boolean {
  const day = parseDate(s).getDay();
  return day === 0 || day === 6;
}

export function isWorkday(s: string, holidays: readonly string[]): boolean {
  return !isWeekend(s) && !holidays.includes(s);
}

/** 从 s（含）起向未来找第一个工作日 */
export function firstWorkdayOnOrAfter(s: string, holidays: readonly string[]): string {
  let d = s;
  let guard = 0;
  while (!isWorkday(d, holidays) && guard++ < 400) d = addDaysStr(d, 1);
  return d;
}

/** 从 s（含）起向过去找第一个工作日 */
export function prevWorkdayOnOrBefore(s: string, holidays: readonly string[]): string {
  let d = s;
  let guard = 0;
  while (!isWorkday(d, holidays) && guard++ < 400) d = addDaysStr(d, -1);
  return d;
}

export function nextWorkday(s: string, holidays: readonly string[]): string {
  return firstWorkdayOnOrAfter(addDaysStr(s, 1), holidays);
}

const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
export function weekdayCn(s: string): string {
  return WEEKDAY_CN[parseDate(s).getDay()];
}

// ---------- 应检日 ----------

/**
 * 下次应检日：最近一次检查日期 + 该类周期；从未检查返回 null（季初即需补检）。
 * 周期来源 CHECK_INTERVAL_DAYS：灭火器/消火栓 30，指示灯/应急照明 90，安全出口/喷淋 180。
 */
export function nextDueDate(facility: Pick<Facility, 'kind' | 'checks'>): string | null {
  const interval = CHECK_INTERVAL_DAYS[facility.kind] ?? 90;
  const sorted = [...facility.checks].map((c) => c.date).sort();
  if (!sorted.length) return null;
  return addDaysStr(sorted[sorted.length - 1], interval);
}

type Occurrence = { due: string; on: string };

/**
 * 设施在本季度内的应检时点（月检类可有多个）：
 * - 已逾期到季初的，本季第一周就要补（on=季度首日，due 保留真实应检日）
 * - 从未检查的，按季初补检处理（due=null 视作季初）
 * - 按周期逐月/逐季递推，落在季末（含）之前的都要排
 */
export function dueOccurrences(
  facility: Pick<Facility, 'kind' | 'checks'>,
  range: { start: string; end: string },
): Occurrence[] {
  const interval = CHECK_INTERVAL_DAYS[facility.kind] ?? 90;
  const first = nextDueDate(facility);
  if (first === null) return [{ due: range.start, on: range.start }];
  const out: Occurrence[] = [];
  let d = first;
  let guard = 0;
  while (d <= range.end && guard++ < 40) {
    out.push({ due: d, on: d < range.start ? range.start : d });
    d = addDaysStr(d, interval);
  }
  return out;
}

// ---------- 工具/携带物 ----------

export const TOOLS_BY_KIND: Record<FacilityKind, string> = {
  extinguisher: '压力表/称重检查工具',
  hydrant: '消火栓测压接头',
  exit_sign: '指示灯外观检查表',
  emergency_light: '应急放电测试工具',
  exit: '安全出口巡查表',
  sprinkler: '末端试水装置',
};

const KIND_ORDER: FacilityKind[] = [
  'extinguisher',
  'hydrant',
  'exit_sign',
  'emergency_light',
  'exit',
  'sprinkler',
];

export function toolsFor(kinds: Iterable<FacilityKind>): string[] {
  const present = new Set<FacilityKind>(kinds);
  return KIND_ORDER.filter((k) => present.has(k)).map((k) => TOOLS_BY_KIND[k]);
}

// ---------- 分组与排批 ----------

type BuildingLike = { id: string; name: string; floors: string[] };

export type ScheduleInput = {
  quarter: string;
  buildings: BuildingLike[];
  floors: Record<string, Floor>;
  inspectors: Inspector[];
  /** 每人每天设施件数上限 */
  cap: number;
  /** 法定节假日（YYYY-MM-DD），周末默认休 */
  holidays: string[];
  /** 重新生成时要跳过的应检月份（已完成批 / 已留痕的顺延原批覆盖的月份），按楼层给月份键集合 */
  skipMonths?: ReadonlyMap<string, ReadonlySet<string>>;
  now?: number;
};

type Group = {
  key: string;
  buildingId: string;
  buildingName: string;
  floorId: string;
  level: number;
  monthKey: string;
  facilityIds: Set<string>;
  kinds: Set<FacilityKind>;
  due: string; // 最早真实应检日（可能早于季度首日）
  on: string; // 计划依据日（季内）
};

const groupKeyOf = (floorId: string, on: string) => `${floorId}|${on.slice(0, 7)}`;

/** 顺延原因文案（date 晚于计划依据日 on 时；due 为真实应检日，可能在季前） */
function postponeText(
  due: string,
  on: string,
  assigned: string,
  cap: number,
  size: number,
  holidays: readonly string[],
): string {
  const overdue = due < on;
  const head = overdue
    ? `应检日 ${due} 已逾期，本季最早补检日 ${on}`
    : `应检日 ${due}（${weekdayCn(due)}）`;
  const firstDay = firstWorkdayOnOrAfter(on, holidays);
  if (firstDay > on && assigned <= firstDay) {
    return `${head}为非工作日，安排至工作日 ${assigned}`;
  }
  const nonWorkdayPrefix =
    firstDay > on
      ? `${head}为非工作日应顺延至 ${firstDay}，但当日起`
      : `${head}起`;
  return `${nonWorkdayPrefix}各巡检员任务均已达人均日上限 ${cap} 件/人/天，且同楼层 ${size} 件必须同批检查、不可拆分，顺延至 ${assigned}`;
}

/**
 * 生成季度批次：
 * 1) 按「楼层 × 应检月份」归组（同楼层绝不拆批）；
 * 2) 组按应检日、楼栋、楼层排序；
 * 3) 从应检日或其之前最近的工作日起，给当日还有余量的巡检员派批；
 *    全员满载就整日顺延，并在 postponeReason 写清原因；
 * 4) 整批超过单人上限时无法拆分，整批压给任务最少的人并置 overCap 警告。
 */
export function generateBatches(input: ScheduleInput): ScheduleBatch[] {
  const range = quarterRange(input.quarter);
  const holidays = input.holidays;
  const skipMonths = input.skipMonths ?? new Map<string, ReadonlySet<string>>();
  const now = new Date(input.now ?? Date.now()).toISOString();

  // ---- 归组（按楼层 × 真实应检日所在月）----
  const groups = new Map<string, Group>();
  for (const b of input.buildings) {
    for (const fid of b.floors) {
      const floor = input.floors[fid];
      if (!floor) continue;
      const skip = skipMonths.get(fid);
      for (const fac of floor.facilities) {
        for (const occ of dueOccurrences(fac, range)) {
          // 已完成批/留痕批覆盖的「应检月份」按楼层跳过：即使月检续算后的时点落回同一月也不重排
          if (skip?.has(occ.due.slice(0, 7))) continue;
          const key = groupKeyOf(fid, occ.on);
          let g = groups.get(key);
          if (!g) {
            g = {
              key,
              buildingId: b.id,
              buildingName: b.name,
              floorId: fid,
              level: floor.level,
              monthKey: occ.on.slice(0, 7),
              facilityIds: new Set(),
              kinds: new Set(),
              due: occ.due,
              on: occ.on,
            };
            groups.set(key, g);
          }
          if (occ.due < g.due) g.due = occ.due;
          if (occ.on < g.on) g.on = occ.on;
          g.facilityIds.add(fac.id);
          g.kinds.add(fac.kind);
        }
      }
    }
  }

  const ordered = [...groups.values()].sort((a, b) => {
    if (a.on !== b.on) return a.on.localeCompare(b.on);
    if (a.buildingName !== b.buildingName) return a.buildingName.localeCompare(b.buildingName, 'zh-Hans-CN');
    if (a.level !== b.level) return a.level - b.level;
    return a.floorId.localeCompare(b.floorId);
  });

  // ---- 派工 ----
  const active = input.inspectors.filter((x) => x.active);
  const cap = Math.max(1, Math.floor(input.cap));
  // inspectorId -> date -> 已派件数
  const load = new Map<string, Map<string, number>>();
  const loadOf = (id: string, d: string) => load.get(id)?.get(d) ?? 0;
  const addLoad = (id: string, d: string, n: number) => {
    let m = load.get(id);
    if (!m) {
      m = new Map();
      load.set(id, m);
    }
    m.set(d, (m.get(d) ?? 0) + n);
  };
  /** 当日还能接整批的巡检员中，取已派量最少者（并列取名单前者，保证结果稳定） */
  const pickInspector = (d: string, size: number): Inspector | null => {
    const fit = active
      .filter((ins) => loadOf(ins.id, d) + size <= cap)
      .sort((a, b2) => loadOf(a.id, d) - loadOf(b2.id, d) || a.id.localeCompare(b2.id));
    return fit[0] ?? null;
  };

  const batches: ScheduleBatch[] = [];
  for (const g of ordered) {
    const size = g.facilityIds.size;
    const ideal = prevWorkdayOnOrBefore(g.on, holidays);
    let date = ideal;
    let inspector: Inspector | null = null;

    if (active.length === 0) {
      // 无可用巡检员：日期照排，提示先加人
    } else if (size > cap) {
      // 整批超上限且同层不可拆：压给 ideal 当天任务最少的人
      inspector = [...active].sort(
        (a, b2) => loadOf(a.id, ideal) - loadOf(b2.id, ideal) || a.id.localeCompare(b2.id),
      )[0];
      addLoad(inspector.id, ideal, size);
    } else {
      let workdays = 0;
      let d = ideal;
      while (workdays < 120) {
        const ins = pickInspector(d, size);
        if (ins) {
          inspector = ins;
          date = d;
          break;
        }
        d = nextWorkday(d, holidays);
        workdays++;
      }
      if (!inspector) {
        // 120 个工作日都排满（极端情况）：不再硬等，整批派给当天最闲的人并警告
        date = d;
        inspector = [...active].sort(
          (a, b2) => loadOf(a.id, d) - loadOf(b2.id, d) || a.id.localeCompare(b2.id),
        )[0];
      }
      addLoad(inspector.id, date, size);
    }

    const kinds = [...g.kinds];
    const batch: ScheduleBatch = {
      id: uid(),
      buildingId: g.buildingId,
      buildingName: g.buildingName,
      floorId: g.floorId,
      level: g.level,
      monthKey: g.monthKey,
      facilityIds: [...g.facilityIds],
      dueDate: g.due,
      date,
      inspectorId: inspector?.id ?? null,
      tools: toolsFor(kinds),
      generatedAt: now,
    };
    if (date > g.on) batch.postponeReason = postponeText(g.due, g.on, date, cap, size, holidays);
    if (active.length === 0) {
      batch.postponeReason = [batch.postponeReason, '暂无可用巡检员，请先在下方添加后重新派工']
        .filter(Boolean)
        .join('；');
    }
    if (inspector && size > cap) {
      batch.overCap = true;
      batch.postponeReason =
        `本层该月共 ${size} 件，超过单人单日上限 ${cap} 件；同楼层设施不能拆批，已整批派给 ${inspector.name}，请增派人手或分上/下午完成`;
    }
    batches.push(batch);
  }
  return batches;
}

// ---------- 完成判定 / 进度 ----------

export type BatchProgress = {
  total: number;
  done: number;
  pending: number;
  completed: boolean;
  items: { id: string; code: string; kind: FacilityKind; done: boolean; lastDate: string | null }[];
};

function resolveFacility(floors: Record<string, Floor>, batch: ScheduleBatch, fid: string): Facility | undefined {
  return floors[batch.floorId]?.facilities.find((f) => f.id === fid);
}

/**
 * 一批是否已查完：批内每个设施都有「派工日当天或之后」的检查记录。
 * （提前检查的不算——那是上一批的；当天/补检后的才算这批完成。）
 */
export function batchProgress(batch: ScheduleBatch, floors: Record<string, Floor>): BatchProgress {
  const items = batch.facilityIds.map((fid) => {
    const fac = resolveFacility(floors, batch, fid);
    const dates = fac ? fac.checks.map((c) => c.date).sort() : [];
    const lastDate = dates.length ? dates[dates.length - 1] : null;
    return {
      id: fid,
      code: fac?.code ?? '(已删除)',
      kind: fac?.kind ?? 'extinguisher',
      lastDate,
      done: !!lastDate && lastDate >= batch.date,
    };
  });
  const done = items.filter((i) => i.done).length;
  return {
    total: items.length,
    done,
    pending: items.length - done,
    completed: items.length > 0 && done === items.length,
    items,
  };
}

/** 一键顺延：把批内未查设施挪到下一工作日的新批（纯函数，store 负责落库） */
export function carryOverBatch(
  batch: ScheduleBatch,
  floors: Record<string, Floor>,
  holidays: readonly string[],
): ScheduleBatch | null {
  const prog = batchProgress(batch, floors);
  if (prog.pending === 0) return null;
  const pendingIds = prog.items.filter((i) => !i.done).map((i) => i.id);
  const floor = floors[batch.floorId];
  const kinds = pendingIds
    .map((id) => floor?.facilities.find((f) => f.id === id)?.kind)
    .filter((k): k is FacilityKind => !!k);
  const newDate = nextWorkday(batch.date, holidays);
  const reason =
    newDate > addDaysStr(batch.date, 1)
      ? `一键顺延：原计划 ${batch.date}（${weekdayCn(batch.date)}）有 ${pendingIds.length} 件未查完，跨非工作日顺延至 ${newDate}`
      : `一键顺延：原计划 ${batch.date} 有 ${pendingIds.length} 件未查完，顺延至下一工作日 ${newDate}`;
  return {
    ...batch,
    id: uid(),
    facilityIds: pendingIds,
    tools: toolsFor(kinds),
    date: newDate,
    postponeReason: reason,
    overCap: !!batch.overCap,
    carryover: true,
    generatedAt: new Date().toISOString(),
  };
}

// ---------- 派工清单文本（贴群） ----------

export type DispatchGrouping = 'date' | 'inspector';

/**
 * 生成可直接贴到工作群的纯文本派工清单。
 * groupBy='date' 按天分组；'inspector' 按人分组。未完成批才需要派工。
 */
export function renderDispatch(
  batches: ScheduleBatch[],
  floors: Record<string, Floor>,
  grouping: DispatchGrouping,
  inspectors: Inspector[],
  title?: string,
): string {
  const pending = batches.filter((b) => !batchProgress(b, floors).completed);
  pending.sort((a, b) =>
    grouping === 'date'
      ? a.date.localeCompare(b.date) || (a.inspectorId ?? '').localeCompare(b.inspectorId ?? '')
      : (a.inspectorId ?? '').localeCompare(b.inspectorId ?? '') || a.date.localeCompare(b.date),
  );
  const insName = (id: string | null) => inspectors.find((i) => i.id === id)?.name ?? '未指派';
  const head = title ?? `消防设施季度检查派工清单（${pending.length} 批）`;
  const lines: string[] = [head, ''];

  if (grouping === 'date') {
    const byDate = new Map<string, ScheduleBatch[]>();
    for (const b of pending) {
      const list = byDate.get(b.date) ?? [];
      list.push(b);
      byDate.set(b.date, list);
    }
    for (const [date, list] of byDate) {
      lines.push(`【${date} ${weekdayCn(date)}】`);
      for (const b of list) {
        const prog = batchProgress(b, floors);
        lines.push(`· ${insName(b.inspectorId)}｜${b.buildingName} ${floorLevelLabel(b.level)}｜${prog.total} 件｜携带：${b.tools.join('、') || '—'}`);
        if (b.postponeReason) lines.push(`  （说明：${b.postponeReason}）`);
      }
      lines.push('');
    }
  } else {
    const byIns = new Map<string, ScheduleBatch[]>();
    for (const b of pending) {
      const key = b.inspectorId ?? '';
      const list = byIns.get(key) ?? [];
      list.push(b);
      byIns.set(key, list);
    }
    for (const [key, list] of byIns) {
      lines.push(`【${insName(key || null)}】`);
      for (const b of list) {
        const prog = batchProgress(b, floors);
        lines.push(`· ${b.date} ${weekdayCn(b.date)}｜${b.buildingName} ${floorLevelLabel(b.level)}｜${prog.total} 件｜携带：${b.tools.join('、') || '—'}`);
        if (b.postponeReason) lines.push(`  （说明：${b.postponeReason}）`);
      }
      lines.push('');
    }
  }
  return lines.join('\n').trimEnd();
}

/** 与 store/id 的 floorLabel 保持一致的展示（此处独立实现避免测试环境耦合） */
export function floorLevelLabel(level: number): string {
  return level >= 1 ? `${level}F` : `B${-level}`;
}
