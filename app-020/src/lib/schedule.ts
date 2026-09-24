/**
 * 季度检查排程引擎（纯函数，无 DOM/Store 依赖，便于单测）
 *
 * 规则：
 * - 各类设施按自身周期推算应检日：灭火器/消火栓 30 天、指示灯/应急照明 90 天、
 *   安全出口/喷淋 180 天（取 CHECK_INTERVAL_DAYS）；
 * - 同一楼层本季度要查的设施必须整层进同一批；
 * - 一批 = 一名检查人 × 一个工作日；每人每天有数量上限，放不下就顺延到下一个工作日，
 *   并在批次上记明顺延原因（周末/节假日、日容量排满、整层超限不可拆）。
 */
import type {
  Building,
  CheckRecord,
  Facility,
  FacilityKind,
  Floor,
  PlanBatch,
  PlanItem,
  QuarterPlan,
} from '../model';
import { CHECK_INTERVAL_DAYS } from '../rules/defaults';
import { uid, floorLabel } from '../store/id';
import {
  addDays,
  diffDays,
  isWeekend,
  nextWorkingDay,
  quarterRange,
  todayStr,
  weekdayCN,
  type DateStr,
} from './date';

/** 各类设施下点检查要带的工具（批次工具 = 所含设施类型工具的并集） */
export const CHECK_TOOLS: Record<FacilityKind, string> = {
  extinguisher: '压力表、称重器具',
  hydrant: '消火栓扳手、试水接头',
  exit_sign: '试电笔、照度计',
  emergency_light: '试电笔、照度计',
  exit: '卷尺、对讲机',
  sprinkler: '试水阀、压力表',
};

export function toolsForKinds(kinds: Iterable<FacilityKind>): string {
  const set = new Set<string>();
  for (const k of kinds) for (const t of CHECK_TOOLS[k].split('、')) set.add(t);
  return [...set].join('、');
}

export type SchedSettings = {
  inspectorIds: string[];
  dailyCap: number;
  holidays: ReadonlySet<string>;
};

/** 一个楼层单元：同层设施整层同批 */
export type SchedUnit = {
  floorId: string;
  buildingId: string;
  buildingName: string;
  level: number;
  items: PlanItem[];
  /** 排程目标日（= 层内最早应检日，且不早于季度首日） */
  target: DateStr;
  /** 层内最早的原始应检日（可能早于季度首日，表示季初已逾期） */
  anchorDue: DateStr;
};

function latestCheck(checks: CheckRecord[]): CheckRecord | null {
  return checks.reduce<CheckRecord | null>((m, c) => (m && m.date > c.date ? m : c), null);
}

/**
 * 单个设施在本季度的应检项；本季度不到期返回 null。
 * 月度设施若在季初已逾期，取季内第一个到期日；季内无后续到期则按季初即应检处理。
 */
export function facilityQuarterItem(
  facility: { id: string; kind: FacilityKind; code: string; checks: CheckRecord[] },
  floor: { id: string; buildingId: string },
  year: number,
  quarter: number,
  now: number,
): PlanItem | null {
  const interval = CHECK_INTERVAL_DAYS[facility.kind];
  const { start, end } = quarterRange(year, quarter);
  const last = latestCheck(facility.checks);

  let due: DateStr;
  if (last) {
    due = addDays(last.date, interval);
  } else {
    // 从未检查过：季初即应检（尽快补检）
    return {
      facilityId: facility.id,
      kind: facility.kind,
      code: facility.code,
      floorId: floor.id,
      buildingId: floor.buildingId,
      dueDate: start,
      basedOnCheck: null,
    };
  }
  if (due > end) return null; // 本季度不到期
  // 逾期于季初：若周期内季中还有到期日，取季内第一个；否则保留季初逾期锚点
  while (due < start && addDays(due, interval) <= end) {
    due = addDays(due, interval);
  }
  return {
    facilityId: facility.id,
    kind: facility.kind,
    code: facility.code,
    floorId: floor.id,
    buildingId: floor.buildingId,
    dueDate: due,
    basedOnCheck: last.date,
  };
}

/** 列出本季度全部应检楼层单元（按楼栋/楼层/应检日排序，同层已归并） */
export function buildQuarterUnits(
  buildings: Building[],
  floors: Record<string, Floor>,
  year: number,
  quarter: number,
  now: number = Date.now(),
): SchedUnit[] {
  const { start } = quarterRange(year, quarter);
  const units = new Map<string, SchedUnit>();
  for (const b of buildings) {
    for (const fid of b.floors) {
      const f = floors[fid];
      if (!f) continue;
      for (const fac of f.facilities as Facility[]) {
        const item = facilityQuarterItem(fac, f, year, quarter, now);
        if (!item) continue;
        let u = units.get(fid);
        if (!u) {
          u = {
            floorId: fid,
            buildingId: b.id,
            buildingName: b.name,
            level: f.level,
            items: [],
            target: start,
            anchorDue: item.dueDate,
          };
          units.set(fid, u);
        }
        u.items.push(item);
        if (item.dueDate < u.anchorDue) u.anchorDue = item.dueDate;
      }
    }
  }
  const out = [...units.values()];
  for (const u of out) {
    // 目标日不早于季度首日；逾期锚点（< start）的单元从季度首个工作日排起
    u.target = u.anchorDue < start ? start : u.anchorDue;
    // 层内设施按类型、编号稳定排序，派工清单里好找
    u.items.sort((a, b2) => a.kind.localeCompare(b2.kind) || a.code.localeCompare(b2.code));
  }
  // 应检日优先，其次楼栋、楼层，保证先到期的先排
  out.sort(
    (a, b2) =>
      a.anchorDue.localeCompare(b2.anchorDue) ||
      a.buildingName.localeCompare(b2.buildingName, 'zh') ||
      a.level - b2.level ||
      a.floorId.localeCompare(b2.floorId),
  );
  return out;
}

// ---------- 排程核心 ----------

type Group = {
  floorIds: string[];
  items: PlanItem[];
  target: DateStr;
  label: string; // 顺延说明中用的楼层名（如 3F）
  /** 优先派给该检查人（顺延沿用原检查人）；不保证成功，容量不足换人 */
  preferredInspectorId?: string;
  notePrefix?: string; // 顺延原因前缀（如「顺延自 10-01（原批次未查完）」）
};

type Placer = {
  batches: Map<string, PlanBatch>;
  occ: Map<string, number>;
  cursor: number;
};

const slotKey = (d: DateStr, inspectorId: string) => `${d}|${inspectorId}`;

function initPlacer(existing: PlanBatch[]): Placer {
  const batches = new Map<string, PlanBatch>();
  const occ = new Map<string, number>();
  for (const b of existing) {
    // 拷贝，避免改到入参（store 状态不可变）
    const nb: PlanBatch = { ...b, floorIds: [...b.floorIds], items: [...b.items] };
    batches.set(slotKey(b.date, b.inspectorId), nb);
    occ.set(slotKey(b.date, b.inspectorId), nb.items.length);
  }
  return { batches, occ, cursor: 0 };
}

/**
 * 把若干「不可拆组」放进排班：从各组目标日起逐工作日找最早可行槽位。
 * 容量判定：普通组要求 used + size ≤ cap；单层超限组（size > cap）只能独占一名
 * 当天零负荷的检查人（整层同批不可拆），并在说明里讲清。
 * 返回组 → 落点与顺延说明。
 */
function placeGroups(
  placer: Placer,
  groups: Group[],
  settings: SchedSettings,
  horizonStart: DateStr,
  horizonDays: number,
): { batch: PlanBatch; date: DateStr; note: string | null }[] {
  const { inspectorIds, dailyCap, holidays } = settings;
  const n = inspectorIds.length;
  const horizon = addDays(horizonStart, horizonDays);
  const results: { batch: PlanBatch; date: DateStr; note: string | null }[] = [];

  for (const g of groups) {
    const size = g.items.length;
    const overSize = size > dailyCap;
    const target = g.target < horizonStart ? horizonStart : g.target;
    const firstWork = nextWorkingDay(target, holidays);
    let d = firstWork;
    let chosenIdx = -1;
    let chosenUsed = 0;

    while (d <= horizon) {
      const feasible = inspectorIds
        .map((id, idx) => ({ id, idx, used: placer.occ.get(slotKey(d, id)) ?? 0 }))
        .filter((s) => (overSize ? s.used === 0 : s.used + size <= dailyCap));
      if (feasible.length) {
        // 优先沿用指定检查人；否则选当日负荷最低者，平局按轮转游标摊派
        const preferred = g.preferredInspectorId
          ? feasible.find((s) => s.id === g.preferredInspectorId)
          : undefined;
        const pool = preferred ? [preferred] : feasible;
        pool.sort(
          (a, b2) =>
            a.used - b2.used ||
            ((a.idx - placer.cursor + n) % n) - ((b2.idx - placer.cursor + n) % n),
        );
        chosenIdx = pool[0].idx;
        chosenUsed = pool[0].used;
        break;
      }
      d = nextWorkingDay(addDays(d, 1), holidays);
    }
    if (chosenIdx < 0) throw new Error('排程失败：可派工工作日区间内找不到容量（请增加检查人或节假日后重排）');

    const inspectorId = inspectorIds[chosenIdx];
    placer.cursor = (chosenIdx + 1) % n;
    const k = slotKey(d, inspectorId);
    placer.occ.set(k, chosenUsed + size);
    let batch = placer.batches.get(k);
    if (!batch) {
      batch = { id: uid(), date: d, inspectorId, floorIds: [], items: [], postponement: null };
      placer.batches.set(k, batch);
    }
    batch.floorIds.push(...g.floorIds.filter((fid) => !batch!.floorIds.includes(fid)));
    batch.items.push(...g.items);

    // 顺延说明
    const parts: string[] = [];
    if (g.notePrefix) parts.push(g.notePrefix);
    if (d > target) {
      if (firstWork > target) {
        parts.push(
          `${g.label}：应检日 ${target}（周${weekdayCN(target)}）为${
            isWeekend(target) ? '周末' : '节假日'
          }，顺移至工作日`,
        );
      }
      if (d > firstWork) {
        parts.push(
          `${g.label}：${firstWork} 起各检查人当日均已排满（上限 ${dailyCap} 项/人·天，同层 ${size} 项须整层同批），顺延至 ${d}（周${weekdayCN(d)}）`,
        );
      }
    }
    if (overSize) {
      parts.push(
        `${g.label}：本层 ${size} 项超过单人单日上限 ${dailyCap} 项，整层须同批不可拆，请安排增援或加班`,
      );
    }
    results.push({ batch, date: d, note: parts.length ? parts.join('；') : null });
  }
  return results;
}

/** 汇总挂到同一批次上的各组顺延说明（去重） */
function attachNotes(batch: PlanBatch, notes: (string | null)[]) {
  const texts = notes.filter((x): x is string => !!x);
  if (!texts.length) return;
  const set = new Set((batch.postponement ? batch.postponement.split('；') : []).concat(texts));
  batch.postponement = [...set].join('；');
}

function sortBatches(batches: PlanBatch[], inspectorIds: string[]): PlanBatch[] {
  const order = new Map(inspectorIds.map((id, i) => [id, i]));
  return [...batches].sort(
    (a, b2) =>
      a.date.localeCompare(b2.date) ||
      (order.get(a.inspectorId) ?? 999) - (order.get(b2.inspectorId) ?? 999),
  );
}

/** 生成季度计划（楼栋/楼层/设施来自当前台账快照） */
export function generatePlan(
  buildings: Building[],
  floors: Record<string, Floor>,
  year: number,
  quarter: number,
  settings: SchedSettings,
  now: number = Date.now(),
): QuarterPlan {
  if (!settings.inspectorIds.length) throw new Error('还没有可派工的检查人，请先在下方添加');
  const { start, end } = quarterRange(year, quarter);
  const units = buildQuarterUnits(buildings, floors, year, quarter, now);
  const placer = initPlacer([]);
  for (const u of units) {
    const r = placeGroups(
      placer,
      [
        {
          floorIds: [u.floorId],
          items: u.items,
          target: u.target,
          label: floorLabel(u.level),
        },
      ],
      settings,
      start,
      // 季度后留 90 天兜底（全员排满/节假日过多时也能排出）
      diffDays(start, end) + 90,
    );
    attachNotes(r[0].batch, [r[0].note]);
  }
  return {
    id: planId(year, quarter),
    year,
    quarter,
    createdAt: new Date(now).toISOString(),
    inspectorIds: [...settings.inspectorIds],
    dailyCap: settings.dailyCap,
    holidays: [...settings.holidays].sort(),
    batches: sortBatches([...placer.batches.values()], settings.inspectorIds),
  };
}

export function planId(year: number, quarter: number): string {
  return `${year}-Q${quarter}`;
}

/**
 * 一键顺延：把指定批次里「未查完」的设施挪到下一工作日的批次。
 * - 同层已完成的设施留在原批（自动划掉），未完成的整层成组搬走；
 * - 优先沿用原检查人；当日容量不足换人或再顺延，原因写清。
 * 返回新的 batches 数组（不可变更新）。
 *
 * @param isDone 设施在该批次日期当天或之后是否已有检查记录（设施已删除视为完成）
 */
export function carryOverBatches(
  plan: QuarterPlan,
  batchIds: string[],
  isDone: (item: PlanItem, batchDate: string) => boolean,
  now: number = Date.now(),
): PlanBatch[] {
  const holidays = new Set(plan.holidays);
  const settings: SchedSettings = {
    inspectorIds: plan.inspectorIds,
    dailyCap: plan.dailyCap,
    holidays,
  };
  // 仅保留仍存在的源批次，按日期先后处理（先顺延早的）
  const sources = plan.batches
    .filter((b) => batchIds.includes(b.id))
    .sort((a, b2) => a.date.localeCompare(b2.date));
  if (!sources.length) return plan.batches;

  // 未参与顺延的批次保留；源批次缩成「仅已完成项」后保留（自动划掉留痕），
  // 全部未完成的源批次直接消失
  const kept: PlanBatch[] = plan.batches.filter((b) => !batchIds.includes(b.id));
  for (const src of sources) {
    const doneItems = src.items.filter((it) => isDone(it, src.date));
    if (doneItems.length) {
      const doneFloorIds = [...new Set(doneItems.map((it) => it.floorId))];
      kept.push({
        ...src,
        items: doneItems,
        floorIds: src.floorIds.filter((fid) => doneFloorIds.includes(fid)),
      });
    }
  }
  const placer = initPlacer(kept);

  for (const src of sources) {
    // 未完成项按楼层成组；源批若含多层，各层各自整层搬走
    const byFloor = new Map<string, PlanItem[]>();
    for (const it of src.items) {
      if (isDone(it, src.date)) continue;
      const list = byFloor.get(it.floorId) ?? [];
      list.push(it);
      byFloor.set(it.floorId, list);
    }
    if (!byFloor.size) continue; // 全部已完成，无可顺延
    const target = nextWorkingDay(addDays(src.date, 1), holidays);
    const groups: Group[] = [...byFloor.entries()].map(([floorId, items]) => ({
      floorIds: [floorId],
      items,
      target,
      label: items[0] ? floorLabelOf(items[0]) : floorId,
      preferredInspectorId: src.inspectorId,
      notePrefix: `顺延自 ${src.date}（原批次未查完）`,
    }));
    const rs = placeGroups(placer, groups, settings, target, 180);
    // 同批多组的说明合并挂到落点批次
    const byBatch = new Map<PlanBatch, (string | null)[]>();
    for (const r of rs) {
      const list = byBatch.get(r.batch) ?? [];
      list.push(r.note);
      byBatch.set(r.batch, list);
    }
    for (const [batch, notes] of byBatch) {
      batch.carriedOver = true;
      attachNotes(batch, notes);
    }
  }
  return sortBatches([...placer.batches.values()], plan.inspectorIds);
}

function floorLabelOf(item: PlanItem): string {
  // PlanItem 不带 level，编号前缀即楼层（如 3F-EX-01 / B1-HY-02）
  const m = /^([0-9]+F|B[0-9]+)-/.exec(item.code);
  return m ? m[1] : item.floorId;
}

// ---------- 完成情况（自动划掉） ----------

export type BatchProgress = {
  total: number;
  checked: number;
  /** 全部设施在批次日期当天或之后有检查记录（设施已删除视为无需再查） */
  completed: boolean;
  /** 是否逾期未完成（批次日期已过且未完成） */
  overdue: boolean;
  checkedAt: string | null;
};

export function itemCheckedOn(facility: Facility | undefined, batchDate: string): boolean {
  if (!facility) return true; // 已删除的设施无需再查
  return facility.checks.some((c) => c.date >= batchDate);
}

export function batchProgress(
  batch: PlanBatch,
  floors: Record<string, Floor>,
  now: number = Date.now(),
): BatchProgress {
  let checked = 0;
  let latest: string | null = null;
  for (const it of batch.items) {
    const fac = floors[it.floorId]?.facilities.find((f) => f.id === it.facilityId);
    if (itemCheckedOn(fac, batch.date)) {
      checked++;
      const last = fac ? latestCheck(fac.checks)?.date ?? null : null;
      if (last && (!latest || last > latest)) latest = last;
    }
  }
  const total = batch.items.length;
  const today = todayStr(now);
  return {
    total,
    checked,
    completed: checked === total,
    overdue: checked < total && batch.date < today,
    checkedAt: latest,
  };
}

// ---------- 派工清单文本（贴群） ----------

export type FloorResolver = (floorId: string) => { buildingName: string; label: string } | null;
export type InspectorResolver = (id: string) => string;

function kindSummary(items: PlanItem[]): string {
  const counts = new Map<string, number>();
  for (const it of items) counts.set(it.kind, (counts.get(it.kind) ?? 0) + 1);
  // 中文类型名
  const names: Record<string, string> = {
    extinguisher: '灭火器',
    hydrant: '消火栓',
    exit_sign: '指示灯',
    emergency_light: '应急照明',
    exit: '安全出口',
    sprinkler: '喷淋',
  };
  return [...counts.entries()].map(([k, n]) => `${names[k] ?? k}×${n}`).join('、');
}

function batchLine(
  batch: PlanBatch,
  resolveFloor: FloorResolver,
): { date: string; inspectorId: string; text: string } {
  // 按楼栋/楼层归并显示
  const floorsText = batch.floorIds
    .map((fid) => resolveFloor(fid))
    .filter((x): x is { buildingName: string; label: string } => !!x)
    .map((x) => `${x.buildingName}${x.label}`)
    .join('、');
  const dueSet = [...new Set(batch.items.map((i) => i.dueDate))].sort();
  const dueText = dueSet.length === 1 ? dueSet[0] : `${dueSet[0]} 起`;
  const lines = [
    `· ${floorsText || '（楼层已删除）'}（${batch.items.length} 项，应检 ${dueText}）`,
    `  设施：${kindSummary(batch.items)}`,
    `  带：${toolsForKinds(batch.items.map((i) => i.kind))}`,
  ];
  if (batch.postponement) lines.push(`  ⚠️ 顺延说明：${batch.postponement}`);
  return { date: batch.date, inspectorId: batch.inspectorId, text: lines.join('\n') };
}

/**
 * 生成可直接贴到工作群的纯文本派工清单。
 * mode='date' 按日期分组；mode='person' 按检查人分组。
 */
export function dispatchText(
  plan: QuarterPlan,
  resolveFloor: FloorResolver,
  resolveInspector: InspectorResolver,
  opts: { mode: 'date' | 'person'; onlyPending?: boolean; completedIds?: ReadonlySet<string>; now?: number } = {
    mode: 'date',
  },
): string {
  const now = opts.now ?? Date.now();
  const today = todayStr(now);
  let batches = plan.batches;
  if (opts.onlyPending) batches = batches.filter((b) => !opts.completedIds?.has(b.id));

  const head: string[] = [];
  head.push(`【${plan.year}年第${['一', '二', '三', '四'][plan.quarter - 1]}季度消防设施检查派工】`);
  head.push(`生成于 ${today} · 上限 ${plan.dailyCap} 项/人·天 · 共 ${batches.length} 批`);
  if (!batches.length) return head.concat(['', '本季度暂无待派工批次。']).join('\n');

  const blocks: string[] = [];
  if (opts.mode === 'date') {
    const byDate = new Map<string, PlanBatch[]>();
    for (const b of batches) {
      const list = byDate.get(b.date) ?? [];
      list.push(b);
      byDate.set(b.date, list);
    }
    for (const [date, list] of [...byDate.entries()].sort((a, b2) => a[0].localeCompare(b2[0]))) {
      blocks.push(`📅 ${date}（周${weekdayCN(date)}）`);
      for (const b of list) {
        blocks.push(`👤 ${resolveInspector(b.inspectorId)}`);
        blocks.push(batchLine(b, resolveFloor).text);
      }
      blocks.push('');
    }
  } else {
    const byPerson = new Map<string, PlanBatch[]>();
    for (const b of batches) {
      const list = byPerson.get(b.inspectorId) ?? [];
      list.push(b);
      byPerson.set(b.inspectorId, list);
    }
    for (const [inspectorId, list] of byPerson) {
      blocks.push(`👤 ${resolveInspector(inspectorId)}（${list.length} 批）`);
      for (const b of list) blocks.push(batchLine(b, resolveFloor).text);
      blocks.push('');
    }
  }
  return head.concat('', blocks).join('\n').trimEnd();
}

/** 计划是否还有未完成且已到期（含今天）的批次 */
export function hasActionablePending(
  plan: QuarterPlan,
  floors: Record<string, Floor>,
  now: number = Date.now(),
): boolean {
  const today = todayStr(now);
  return plan.batches.some(
    (b) => b.date <= today && !batchProgress(b, floors, now).completed,
  );
}
