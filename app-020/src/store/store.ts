import { useSyncExternalStore } from 'react';
import type {
  Building,
  BuildingKind,
  CheckRecord,
  Facility,
  FacilityKind,
  Floor,
  Inspector,
  Pt,
  QuarterPlan,
  Room,
  RoomUsage,
  RuleSet,
  ScheduleBatch,
  ValidationResult,
} from '../model';
import { DEFAULT_RULES } from '../rules/defaults';
import { nextCode, uid } from './id';
import { polyAreaM2 } from '../lib/geometry';
import { batchProgress, carryOverBatch, generateBatches } from '../lib/schedule';

const STORAGE_KEY = 'fem.v1';

export type PlanSettings = {
  /** 每人每天可查设施件数上限 */
  cap: number;
  /** 法定节假日（YYYY-MM-DD），周末默认休息 */
  holidays: string[];
};

const DEFAULT_SETTINGS: PlanSettings = { cap: 30, holidays: [] };

export type AppState = {
  buildings: Building[];
  floors: Record<string, Floor>;
  rules: Record<BuildingKind, RuleSet>;
  /** 「您在此」标记（打印版疏散图），按楼层存 */
  marks: Record<string, Pt>;
  /** 季度检查派工：巡检员、派工设置、按季度存的计划 */
  inspectors: Inspector[];
  planSettings: PlanSettings;
  plans: Record<string, QuarterPlan>;
};

function defaultInspectors(): Inspector[] {
  return [
    { id: uid(), name: '巡检员甲', active: true },
    { id: uid(), name: '巡检员乙', active: true },
  ];
}

function loadState(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<AppState>;
      // 缺失的节用默认值补齐（如旧版本数据没有 rules/marks/计划），而不是整体丢弃用户数据
      if (s && Array.isArray(s.buildings) && s.floors) {
        return {
          buildings: s.buildings,
          floors: s.floors,
          rules: { ...structuredClone(DEFAULT_RULES), ...(s.rules ?? {}) },
          marks: s.marks ?? {},
          inspectors: Array.isArray(s.inspectors) ? s.inspectors : defaultInspectors(),
          planSettings: { ...DEFAULT_SETTINGS, ...(s.planSettings ?? {}) },
          plans: s.plans ?? {},
        };
      }
    }
  } catch {
    /* 损坏则重新开始 */
  }
  return {
    buildings: [],
    floors: {},
    rules: structuredClone(DEFAULT_RULES),
    marks: {},
    inspectors: defaultInspectors(),
    planSettings: { ...DEFAULT_SETTINGS },
    plans: {},
  };
}

let state: AppState = loadState();
const listeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function persist() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* 存储满时忽略（照片/底图在 IndexedDB，不受影响） */
    }
  }, 200);
}

function setState(patch: (s: AppState) => void) {
  patch(state);
  // 浅拷贝各容器：保证各选择器拿到新引用
  state = {
    buildings: [...state.buildings],
    floors: { ...state.floors },
    rules: { ...state.rules },
    marks: { ...state.marks },
    inspectors: [...state.inspectors],
    planSettings: { ...state.planSettings, holidays: [...state.planSettings.holidays] },
    plans: { ...state.plans },
  };
  persist();
  listeners.forEach((l) => l());
}

export function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function getState(): AppState {
  return state;
}

export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state),
  );
}

/** 修改楼层并替换其引用 —— 保证 useStore(s => s.floors[id]) 的订阅者能感知更新 */
function updateFloor(floorId: string, mut: (f: Floor) => void) {
  setState((s) => {
    const f = s.floors[floorId];
    if (!f) return;
    mut(f);
    s.floors[floorId] = { ...f };
  });
}

// ---------- 建筑 ----------

export function addBuilding(name: string, kind: BuildingKind): string {
  const id = uid();
  const b: Building = { id, name, kind, floors: [], createdAt: new Date().toISOString() };
  setState((s) => s.buildings.push(b));
  return id;
}

export function updateBuilding(id: string, patch: Partial<Pick<Building, 'name' | 'kind'>>) {
  setState((s) => {
    const i = s.buildings.findIndex((x) => x.id === id);
    if (i >= 0) s.buildings[i] = { ...s.buildings[i], ...patch };
  });
}

export function deleteBuilding(id: string) {
  setState((s) => {
    const b = s.buildings.find((x) => x.id === id);
    if (!b) return;
    for (const fid of b.floors) delete s.floors[fid];
    s.buildings = s.buildings.filter((x) => x.id !== id);
  });
}

// ---------- 楼层 ----------

export function addFloor(buildingId: string, level: number): string {
  const id = uid();
  const floor: Floor = {
    id,
    buildingId,
    level,
    scaleMmPerUnit: 1,
    rooms: [],
    facilities: [],
    exits: [],
    version: 0,
  };
  setState((s) => {
    s.floors[id] = floor;
    const bi = s.buildings.findIndex((x) => x.id === buildingId);
    if (bi >= 0) s.buildings[bi] = { ...s.buildings[bi], floors: [...s.buildings[bi].floors, id] };
  });
  return id;
}

export function deleteFloor(floorId: string) {
  setState((s) => {
    const f = s.floors[floorId];
    if (!f) return;
    const bi = s.buildings.findIndex((x) => x.id === f.buildingId);
    if (bi >= 0) {
      s.buildings[bi] = { ...s.buildings[bi], floors: s.buildings[bi].floors.filter((x) => x !== floorId) };
    }
    delete s.floors[floorId];
    delete s.marks[floorId];
  });
}

// ---------- 房间 ----------

export function addRoom(floorId: string, polygon: Pt[], name: string, usage: RoomUsage): string {
  const id = uid();
  updateFloor(floorId, (f) => {
    f.version++;
    f.rooms.push({ id, polygon, name, usage, areaM2: polyAreaM2(polygon) });
  });
  return id;
}

export function updateRoom(floorId: string, roomId: string, patch: Partial<Pick<Room, 'name' | 'usage' | 'occupants'>>) {
  updateFloor(floorId, (f) => {
    const r = f.rooms.find((x) => x.id === roomId);
    if (r) {
      Object.assign(r, patch);
      f.version++;
    }
  });
}

export function deleteRoom(floorId: string, roomId: string) {
  updateFloor(floorId, (f) => {
    f.version++;
    f.rooms = f.rooms.filter((x) => x.id !== roomId);
  });
}

/** 拖动整体平移房间多边形（保留 id、人数等属性与数组顺序） */
export function moveRoom(floorId: string, roomId: string, dx: number, dy: number) {
  updateFloor(floorId, (f) => {
    const r = f.rooms.find((x) => x.id === roomId);
    if (!r) return;
    r.polygon = r.polygon.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    f.version++;
  });
}

// ---------- 设施 ----------

export function addFacility(floorId: string, kind: FacilityKind, x: number, y: number): string {
  const id = uid();
  updateFloor(floorId, (f) => {
    const fac: Facility = { id, kind, x, y, code: nextCode(f, kind), checks: [] };
    if (kind === 'extinguisher') fac.spec = { extType: 'dry_powder', weightKg: 4 };
    f.version++;
    f.facilities.push(fac);
    if (kind === 'exit') f.exits.push(id);
  });
  return id;
}

export function moveFacility(floorId: string, facilityId: string, x: number, y: number) {
  updateFloor(floorId, (f) => {
    const fac = f.facilities.find((x2) => x2.id === facilityId);
    if (fac) {
      fac.x = x;
      fac.y = y;
      f.version++;
    }
  });
}

export function updateFacility(floorId: string, facilityId: string, patch: Partial<Pick<Facility, 'spec'>>) {
  updateFloor(floorId, (f) => {
    const fac = f.facilities.find((x) => x.id === facilityId);
    if (fac && patch.spec) {
      fac.spec = patch.spec;
      f.version++;
    }
  });
}

export function deleteFacility(floorId: string, facilityId: string) {
  updateFloor(floorId, (f) => {
    f.version++;
    f.facilities = f.facilities.filter((x) => x.id !== facilityId);
    f.exits = f.exits.filter((x) => x !== facilityId);
  });
}

export function addCheck(floorId: string, facilityId: string, check: CheckRecord) {
  updateFloor(floorId, (f) => {
    const fac = f.facilities.find((x) => x.id === facilityId);
    if (fac) {
      fac.checks.push(check);
      f.version++;
    }
  });
}

export function deleteCheck(floorId: string, facilityId: string, index: number) {
  updateFloor(floorId, (f) => {
    const fac = f.facilities.find((x) => x.id === facilityId);
    if (fac) {
      fac.checks.splice(index, 1);
      f.version++;
    }
  });
}

// ---------- 底图 / 标记 / 校验结果 ----------

export function setUnderlay(floorId: string, underlay: Floor['underlay']) {
  updateFloor(floorId, (f) => {
    f.underlay = underlay;
  });
}

export function setMark(floorId: string, pt: Pt) {
  setState((s) => {
    s.marks[floorId] = { ...pt };
  });
}

export function setLastValidation(floorId: string, result: ValidationResult) {
  updateFloor(floorId, (f) => {
    f.lastValidation = result;
  });
}

// ---------- 规则 ----------

export function updateRules(kind: BuildingKind, patch: Partial<Omit<RuleSet, 'buildingKind' | 'version'>>) {
  setState((s) => {
    const r = s.rules[kind];
    s.rules[kind] = { ...r, ...patch, version: r.version + 1 };
  });
}

export function resetRules(kind: BuildingKind) {
  setState((s) => {
    s.rules[kind] = structuredClone(DEFAULT_RULES[kind]);
  });
  persist();
}

// ---------- 季度检查派工计划 ----------

export function addInspector(name: string): string {
  const id = uid();
  setState((s) => s.inspectors.push({ id, name, active: true }));
  return id;
}

export function updateInspector(id: string, patch: Partial<Pick<Inspector, 'name' | 'active'>>) {
  setState((s) => {
    const i = s.inspectors.findIndex((x) => x.id === id);
    if (i >= 0) s.inspectors[i] = { ...s.inspectors[i], ...patch };
  });
}

export function deleteInspector(id: string) {
  setState((s) => {
    s.inspectors = s.inspectors.filter((x) => x.id !== id);
    // 已派给该巡检员的批次解除指派（不删批，便于重新指派）
    for (const [q, plan] of Object.entries(s.plans)) {
      let changed = false;
      for (const b of plan.batches) {
        if (b.inspectorId === id) {
          b.inspectorId = null;
          changed = true;
        }
      }
      if (changed) s.plans[q] = { ...plan, batches: [...plan.batches] };
    }
  });
}

export function updatePlanSettings(patch: Partial<PlanSettings>) {
  setState((s) => {
    s.planSettings = { ...s.planSettings, ...patch };
  });
}

/** 删除某季度的派工计划（重新排产前彻底重来） */
export function deletePlan(quarter: string) {
  setState((s) => {
    delete s.plans[quarter];
  });
}

/**
 * 生成（或重新生成）某季度派工批次。
 * 已查完的批、以及一键顺延后留痕的原批保留；其覆盖的「楼层×月份」不再重排。
 * 未完成的批（含未完成的顺延承接批）丢弃重排，避免过期/重复派工。
 */
export function generatePlan(quarter: string): number {
  let count = 0;
  setState((s) => {
    const old = s.plans[quarter]?.batches ?? [];
    const retained = old.filter((b) => b.carried || batchProgress(b, s.floors).completed);
    // 按楼层汇总保留批覆盖的应检月份（真实应检月 + 计划月都收：逾期补检批的应检月在季前，
    // 归组时按真实应检月跳过；计划月保证同季的月检续批不回填）
    const skipMonths = new Map<string, Set<string>>();
    for (const b of retained) {
      let set = skipMonths.get(b.floorId);
      if (!set) {
        set = new Set();
        skipMonths.set(b.floorId, set);
      }
      set.add(b.dueDate.slice(0, 7));
      set.add(b.monthKey);
    }
    const fresh = generateBatches({
      quarter,
      buildings: s.buildings,
      floors: s.floors,
      inspectors: s.inspectors,
      cap: s.planSettings.cap,
      holidays: s.planSettings.holidays,
      skipMonths,
    });
    const batches = [...retained, ...fresh].sort((a, b) =>
      a.date.localeCompare(b.date) || a.buildingName.localeCompare(b.buildingName, 'zh-Hans-CN') || a.level - b.level,
    );
    s.plans[quarter] = { quarter, batches, generatedAt: new Date().toISOString() };
    count = batches.length;
  });
  return count;
}

/** 手动改派工日 / 巡检员 / 携带物 */
export function updateBatch(quarter: string, batchId: string, patch: Partial<Pick<ScheduleBatch, 'date' | 'inspectorId' | 'tools'>>) {
  setState((s) => {
    const plan = s.plans[quarter];
    if (!plan) return;
    const i = plan.batches.findIndex((b) => b.id === batchId);
    if (i < 0) return;
    s.plans[quarter] = { ...plan, batches: plan.batches.map((b) => (b.id === batchId ? { ...b, ...patch } : b)) };
  });
}

export function deleteBatch(quarter: string, batchId: string) {
  setState((s) => {
    const plan = s.plans[quarter];
    if (!plan) return;
    s.plans[quarter] = { ...plan, batches: plan.batches.filter((b) => b.id !== batchId) };
  });
}

/** 一键顺延：未查完的设施挪到下一工作日的承接批；原批部分已查则留痕划掉，全未查则直接替换 */
export function carryBatch(quarter: string, batchId: string) {
  setState((s) => {
    const plan = s.plans[quarter];
    if (!plan) return;
    const idx = plan.batches.findIndex((b) => b.id === batchId);
    if (idx < 0) return;
    const batch = plan.batches[idx];
    const moved = carryOverBatch(batch, s.floors, s.planSettings.holidays);
    if (!moved) return;
    const prog = batchProgress(batch, s.floors);
    const batches = [...plan.batches];
    if (prog.done > 0) {
      batches[idx] = { ...batch, carried: true };
      batches.push(moved);
    } else {
      batches[idx] = moved;
    }
    s.plans[quarter] = { ...plan, batches };
  });
}

// ---------- 示例数据 ----------

const M = 1000;
function rect(x: number, y: number, w: number, h: number): Pt[] {
  return [
    { x: x * M, y: y * M },
    { x: (x + w) * M, y: y * M },
    { x: (x + w) * M, y: (y + h) * M },
    { x: x * M, y: (y + h) * M },
  ];
}

/** 载入示例：41m 走道双出口 + 10 个房间，办公楼规则全过；切换厂房规则后灭火器覆盖不合规 */
export function loadDemo(): string {
  let bid = '';
  setState((s) => {
    const buildingId = uid();
    bid = buildingId;
    const floorId = uid();
    s.buildings.push({
      id: buildingId,
      name: '示例办公楼',
      kind: 'office',
      floors: [floorId],
      createdAt: new Date().toISOString(),
    });
    const rooms: Room[] = [];
    const mk = (name: string, usage: RoomUsage, poly: Pt[], occupants?: number) => {
      rooms.push({ id: uid(), polygon: poly, name, usage, areaM2: polyAreaM2(poly), occupants });
    };
    mk('走道', 'corridor', rect(0, 0, 41, 2));
    const names = ['101', '102', '103', '104', '105'];
    for (let i = 0; i < 5; i++) {
      mk(`${names[i]}室`, i === 2 ? 'storage' : 'office', rect(i * 8, 2, 8, 6), i === 2 ? 2 : 10);
      mk(`${names[i]}B室`, i === 0 ? 'retail' : 'office', rect(i * 8, -5, 8, 5), i === 0 ? 15 : 10);
    }
    const facilities: Facility[] = [];
    const dateStr = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
    const mkF = (kind: FacilityKind, x: number, y: number, code: string, checks: Facility['checks'] = [], spec?: Facility['spec']) => {
      facilities.push({ id: uid(), kind, x: x * M, y: y * M, code, checks, spec });
    };
    mkF('exit', 0.5, 1, '1F-EXIT-01');
    mkF('exit', 40.5, 1, '1F-EXIT-02');
    mkF('extinguisher', 20.5, 1, '1F-EX-01', [{ date: dateStr(20), status: 'ok' }], { extType: 'dry_powder', weightKg: 4 });
    mkF('extinguisher', 4, 5, '1F-EX-02', [{ date: dateStr(45), status: 'ok' }], { extType: 'dry_powder', weightKg: 4 });
    mkF('extinguisher', 36, 5, '1F-EX-03', [], { extType: 'co2', weightKg: 2 });
    mkF('hydrant', 10, 1, '1F-HY-01', [{ date: dateStr(10), status: 'ok' }]);
    mkF('exit_sign', 1, 1.7, '1F-ES-01', [{ date: dateStr(15), status: 'ok' }]);
    mkF('exit_sign', 40, 1.7, '1F-ES-02', [{ date: dateStr(15), status: 'ok' }]);
    mkF('emergency_light', 20.5, 0.4, '1F-EL-01', [{ date: dateStr(15), status: 'ok' }]);
    const exits = facilities.filter((f) => f.kind === 'exit').map((f) => f.id);
    s.floors[floorId] = {
      id: floorId,
      buildingId,
      level: 1,
      scaleMmPerUnit: 1,
      rooms,
      facilities,
      exits,
      version: 0,
    };
  });
  persist();
  return bid;
}
