import { useSyncExternalStore } from 'react';
import type {
  Building,
  BuildingKind,
  CheckRecord,
  Facility,
  FacilityKind,
  Floor,
  PlanItem,
  Pt,
  QuarterPlan,
  Room,
  RoomUsage,
  RuleSet,
  ValidationResult,
} from '../model';
import { DEFAULT_RULES } from '../rules/defaults';
import { nextCode, uid } from './id';
import { polyAreaM2 } from '../lib/geometry';
import { generatePlan, carryOverBatches, type SchedSettings } from '../lib/schedule';

const STORAGE_KEY = 'fem.v1';

/** 可派工检查人 */
export type Inspector = { id: string; name: string; phone?: string };

/** 季度派工默认参数 */
export type SchedulePrefs = {
  dailyCap: number; // 每人每天检查项数上限
  holidays: string[]; // 额外节假日（周末固定休息），YYYY-MM-DD
};

export type AppState = {
  buildings: Building[];
  floors: Record<string, Floor>;
  rules: Record<BuildingKind, RuleSet>;
  /** 「您在此」标记（打印版疏散图），按楼层存 */
  marks: Record<string, Pt>;
  inspectors: Inspector[];
  schedulePrefs: SchedulePrefs;
  plans: Record<string, QuarterPlan>; // key: `${year}-Q${n}`
};

function defaultState(): AppState {
  return {
    buildings: [],
    floors: {},
    rules: structuredClone(DEFAULT_RULES),
    marks: {},
    inspectors: [],
    schedulePrefs: { dailyCap: 30, holidays: [] },
    plans: {},
  };
}

function loadState(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<AppState>;
      // 缺失的节用默认值补齐（如旧版本数据没有 rules/marks/plans），而不是整体丢弃用户数据
      if (s && Array.isArray(s.buildings) && s.floors) {
        return {
          ...defaultState(),
          buildings: s.buildings,
          floors: s.floors,
          rules: { ...structuredClone(DEFAULT_RULES), ...(s.rules ?? {}) },
          marks: s.marks ?? {},
          inspectors: s.inspectors ?? [],
          schedulePrefs: { ...defaultState().schedulePrefs, ...(s.schedulePrefs ?? {}) },
          plans: s.plans ?? {},
        };
      }
    }
  } catch {
    /* 损坏则重新开始 */
  }
  return defaultState();
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
    schedulePrefs: { ...state.schedulePrefs, holidays: [...state.schedulePrefs.holidays] },
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

// ---------- 检查人 ----------

export function addInspector(name: string, phone?: string): string {
  const id = uid();
  setState((s) => s.inspectors.push({ id, name, phone: phone?.trim() || undefined }));
  return id;
}

export function updateInspector(id: string, patch: Partial<Pick<Inspector, 'name' | 'phone'>>) {
  setState((s) => {
    const i = s.inspectors.findIndex((x) => x.id === id);
    if (i >= 0) s.inspectors[i] = { ...s.inspectors[i], ...patch };
  });
}

export function deleteInspector(id: string) {
  setState((s) => {
    s.inspectors = s.inspectors.filter((x) => x.id !== id);
    for (const p of Object.values(s.plans)) {
      p.inspectorIds = p.inspectorIds.filter((x) => x !== id);
      // 已生成批次里的派工引用保留，UI 会显示「（已停用）」
    }
  });
}

// ---------- 派工偏好 ----------

export function updateSchedulePrefs(patch: Partial<SchedulePrefs>) {
  setState((s) => {
    s.schedulePrefs = { ...s.schedulePrefs, ...patch };
  });
}

// ---------- 季度计划 ----------

function schedSettings(s: AppState, inspectorIds: string[]): SchedSettings {
  return {
    inspectorIds,
    dailyCap: s.schedulePrefs.dailyCap,
    holidays: new Set(s.schedulePrefs.holidays),
  };
}

/** 生成（或重新生成）某季度计划；inspectorIds 为本季度参与派工的检查人 */
export function buildQuarterPlan(year: number, quarter: number, inspectorIds: string[]): QuarterPlan {
  let plan: QuarterPlan = null as unknown as QuarterPlan;
  setState((s) => {
    plan = generatePlan(
      s.buildings,
      s.floors,
      year,
      quarter,
      schedSettings(s, inspectorIds),
      Date.now(),
    );
    s.plans[plan.id] = plan;
  });
  return plan;
}

export function deletePlan(year: number, quarter: number) {
  const id = `${year}-Q${quarter}`;
  setState((s) => {
    delete s.plans[id];
  });
}

/** 改派：把某批次改派给另一名检查人，仅做引用替换（不重新排日期） */
export function reassignBatch(planIdStr: string, batchId: string, inspectorId: string) {
  setState((s) => {
    const p = s.plans[planIdStr];
    if (!p) return;
    const b = p.batches.find((x) => x.id === batchId);
    if (b) b.inspectorId = inspectorId;
    s.plans[planIdStr] = { ...p, batches: [...p.batches] };
  });
}

/**
 * 一键顺延：把一批（或所有已到期未完成的批次）中未查完的设施挪到下一工作日。
 * 已查完的设施视为自动完成，留原批（UI 自动划掉显示）。
 */
export function carryOver(
  planIdStr: string,
  batchIds: string[] | '__all_pending__',
): void {
  setState((s) => {
    const p = s.plans[planIdStr];
    if (!p) return;
    const today = new Date().toISOString().slice(0, 10);
    // 设施在该批次日期当天及之后有检查记录即完成；设施已删除亦视为完成
    const isDone = (it: PlanItem, batchDate: string): boolean => {
      const fac = s.floors[it.floorId]?.facilities.find((f) => f.id === it.facilityId);
      if (!fac) return true;
      return fac.checks.some((c) => c.date >= batchDate);
    };
    let ids: string[];
    if (batchIds === '__all_pending__') {
      ids = p.batches
        .filter((b) => b.date <= today && b.items.some((it) => !isDone(it, b.date)))
        .map((b) => b.id);
    } else {
      ids = batchIds;
    }
    if (!ids.length) return;
    p.batches = carryOverBatches(p, ids, isDone, Date.now());
    s.plans[planIdStr] = { ...p };
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
