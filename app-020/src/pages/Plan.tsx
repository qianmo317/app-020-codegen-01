import { useMemo, useState } from 'react';
import type { Floor, PlanBatch } from '../model';
import { FACILITY_LABELS } from '../model';
import {
  buildQuarterUnits,
  batchProgress,
  dispatchText,
  toolsForKinds,
  type SchedUnit,
} from '../lib/schedule';
import {
  quarterLabel,
  quarterOfDate,
  quarterRange,
  todayStr,
  weekdayCN,
} from '../lib/date';
import {
  addInspector,
  buildQuarterPlan,
  carryOver,
  deleteInspector,
  deletePlan,
  reassignBatch,
  updateInspector,
  updateSchedulePrefs,
  useStore,
} from '../store/store';
import { floorLabel } from '../store/id';
import { download } from './Facilities';
import { Link } from '../router';

type ViewMode = 'date' | 'person';

function copyText(text: string, onDone: () => void) {
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch {
      /* 老浏览器/无剪贴板权限时用户可改用下载 */
    }
    document.body.removeChild(ta);
    onDone();
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(onDone, fallback);
  else fallback();
}

export function PlanPage() {
  const buildings = useStore((s) => s.buildings);
  const floors = useStore((s) => s.floors);
  const inspectors = useStore((s) => s.inspectors);
  const prefs = useStore((s) => s.schedulePrefs);
  const plans = useStore((s) => s.plans);

  const currentQ = quarterOfDate(Date.now());
  const [year, setYear] = useState(currentQ.year);
  const [quarter, setQuarter] = useState(currentQ.quarter);
  const [selectedInspectorIds, setSelectedInspectorIds] = useState<string[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>('date');
  const [onlyPending, setOnlyPending] = useState(true);
  const [copied, setCopied] = useState(false);
  const [newName, setNewName] = useState('');
  const [holidayInput, setHolidayInput] = useState('');

  const planId = `${year}-Q${quarter}`;
  const plan = plans[planId];
  const { start, end } = quarterRange(year, quarter);
  const now = Date.now();
  const today = todayStr(now);

  // 未手动调整过勾选时默认全选；勾掉/勾过之后以勾选状态为准（停用的人自动剔除）
  const effectiveSelected = useMemo(
    () =>
      selectedInspectorIds.length
        ? selectedInspectorIds.filter((id) => inspectors.some((x) => x.id === id))
        : inspectors.map((x) => x.id),
    [selectedInspectorIds, inspectors],
  );

  // 本季度应查设施（按楼栋/楼层归并）——计划未生成时也能预览
  const units: SchedUnit[] = useMemo(
    () => buildQuarterUnits(buildings, floors, year, quarter, now),
    [buildings, floors, year, quarter, now],
  );

  const totalItems = units.reduce((s, u) => s + u.items.length, 0);
  const overSized = units.filter((u) => u.items.length > prefs.dailyCap);

  const buildingName = (bid: string) => buildings.find((b) => b.id === bid)?.name ?? '（已删除建筑）';
  const floorOf = (fid: string): Floor | undefined => floors[fid];
  const inspectorName = (id: string) =>
    inspectors.find((x) => x.id === id)?.name ?? `（已停用检查人 ${id.slice(-4)}）`;

  const resolveFloor = (fid: string) => {
    const f = floorOf(fid);
    if (!f) return null;
    return { buildingName: buildingName(f.buildingId), label: floorLabel(f.level) };
  };

  const completedIds = useMemo(() => {
    const set = new Set<string>();
    if (plan) for (const b of plan.batches) if (batchProgress(b, floors, now).completed) set.add(b.id);
    return set;
  }, [plan, floors, now]);

  const visibleBatches: PlanBatch[] = useMemo(() => {
    if (!plan) return [];
    return onlyPending ? plan.batches.filter((b) => !completedIds.has(b.id)) : plan.batches;
  }, [plan, onlyPending, completedIds]);

  // 按日期 / 按人分组
  const groups = useMemo(() => {
    const map = new Map<string, PlanBatch[]>();
    for (const b of visibleBatches) {
      const key = viewMode === 'date' ? b.date : b.inspectorId;
      const list = map.get(key) ?? [];
      list.push(b);
      map.set(key, list);
    }
    return [...map.entries()].sort(([a], [b]) =>
      viewMode === 'date' ? a.localeCompare(b) : inspectorName(a).localeCompare(inspectorName(b), 'zh'),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleBatches, viewMode, inspectors]);

  const stats = useMemo(() => {
    if (!plan) return null;
    let done = 0;
    let checkedItems = 0;
    let total = 0;
    let overdueBatches = 0;
    for (const b of plan.batches) {
      const p = batchProgress(b, floors, now);
      total += p.total;
      checkedItems += p.checked;
      if (p.completed) done++;
      else if (p.overdue) overdueBatches++;
    }
    return { done, totalBatches: plan.batches.length, checkedItems, total, overdueBatches };
  }, [plan, floors, now]);

  const doGenerate = () => {
    if (plan && !confirm('重新生成会覆盖本季度已有批次（含手动改派/顺延结果），确定？')) return;
    try {
      buildQuarterPlan(year, quarter, effectiveSelected);
    } catch (e) {
      alert((e as Error).message);
    }
  };

  const makeDispatch = (mode: ViewMode, pendingOnly: boolean) =>
    plan
      ? dispatchText(
          plan,
          resolveFloor,
          inspectorName,
          { mode, onlyPending: pendingOnly, completedIds, now },
        )
      : '';

  const onCopy = (mode: ViewMode) => {
    copyText(makeDispatch(mode, onlyPending), () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const onExportTxt = (mode: ViewMode) => {
    download(
      `${year}Q${quarter}_消防检查派工清单_${mode === 'date' ? '按日期' : '按人'}.txt`,
      makeDispatch(mode, onlyPending),
      'text/plain',
    );
  };

  const toggleInspector = (id: string) => {
    setSelectedInspectorIds((prev) => {
      const base = prev.length ? prev : inspectors.map((x) => x.id);
      return base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
    });
  };

  const addHoliday = () => {
    const v = holidayInput.trim();
    if (!v) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      alert('日期格式应为 YYYY-MM-DD');
      return;
    }
    if (!prefs.holidays.includes(v)) updateSchedulePrefs({ holidays: [...prefs.holidays, v] });
    setHolidayInput('');
  };

  return (
    <div className="page plan-page">
      <h2>季度检查计划与派工</h2>

      <div className="toolbar">
        <label className="row">
          年份
          <input
            type="number"
            value={year}
            style={{ width: 90 }}
            onChange={(e) => setYear(Number(e.target.value))}
          />
        </label>
        <label className="row">
          季度
          <select value={quarter} onChange={(e) => setQuarter(Number(e.target.value))}>
            {[1, 2, 3, 4].map((q) => (
              <option key={q} value={q}>第{['一', '二', '三', '四'][q - 1]}季度</option>
            ))}
          </select>
        </label>
        <span className="hint">
          {quarterLabel(year, quarter)}（{start} ~ {end}）
        </span>
      </div>

      {/* 检查人配置 */}
      <div className="section">
        <h3>检查人</h3>
        <div className="toolbar">
          <input
            placeholder="姓名"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            style={{ width: 140 }}
          />
          <button
            disabled={!newName.trim()}
            onClick={() => {
              addInspector(newName.trim());
              setNewName('');
            }}
          >
            添加检查人
          </button>
          <label className="row">
            每人每天上限
            <input
              type="number"
              min={1}
              value={prefs.dailyCap}
              style={{ width: 70 }}
              onChange={(e) => updateSchedulePrefs({ dailyCap: Math.max(1, Number(e.target.value) || 1) })}
            />
            项
          </label>
        </div>
        <div className="inspector-chips">
          {inspectors.length === 0 && <span className="hint">还没有检查人，先添加至少一名再生成计划。</span>}
          {inspectors.map((p) => (
            <span
              key={p.id}
              className={`chip ${effectiveSelected.includes(p.id) ? 'on' : ''}`}
              title={p.phone}
            >
              <label className="row" style={{ margin: 0 }}>
                <input
                  type="checkbox"
                  checked={effectiveSelected.includes(p.id)}
                  onChange={() => toggleInspector(p.id)}
                />
                <input
                  value={p.name}
                  style={{ width: 90 }}
                  onChange={(e) => updateInspector(p.id, { name: e.target.value })}
                />
              </label>
              <button className="ghost" title="停用" onClick={() => confirm(`停用检查人「${p.name}」？已有批次保留其派工记录`) && deleteInspector(p.id)}>×</button>
            </span>
          ))}
        </div>
        <div className="toolbar">
          <span className="hint">额外节假日（周末固定休息）：</span>
          {prefs.holidays.map((h) => (
            <span key={h} className="chip">
              {h}
              <button className="ghost" onClick={() => updateSchedulePrefs({ holidays: prefs.holidays.filter((x) => x !== h) })}>×</button>
            </span>
          ))}
          <input
            placeholder="YYYY-MM-DD"
            value={holidayInput}
            style={{ width: 130 }}
            onChange={(e) => setHolidayInput(e.target.value)}
          />
          <button onClick={addHoliday}>加节假日</button>
        </div>
      </div>

      {/* 本季度应查设施（按楼栋/楼层） */}
      <div className="section">
        <h3>本季度应查设施（按楼栋 / 楼层）</h3>
        <p className="hint">
          周期：灭火器/消火栓 30 天 · 指示灯/应急照明 90 天 · 安全出口/喷淋 180 天；同一楼层的设施会整层排进同一批。共 {totalItems} 项、{units.length} 个楼层单元。
        </p>
        {overSized.length > 0 && (
          <p className="bad">
            ⚠️ {overSized.length} 个楼层单项数量超过 {prefs.dailyCap} 项/人·天上限（{overSized
              .slice(0, 4)
              .map((u) => `${buildingName(u.buildingId)}${floorLabel(u.level)} ${u.items.length}项`)
              .join('、')}
            {overSized.length > 4 ? '…' : ''}）：整层不可拆，将独占一人一天并标注增援。
          </p>
        )}
        <table className="table">
          <thead>
            <tr>
              <th>楼栋</th>
              <th>楼层</th>
              <th>应检项数</th>
              <th>设施构成</th>
              <th>最早应检日</th>
              <th>要带工具</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {units.map((u) => (
              <tr key={u.floorId} className={u.items.length > prefs.dailyCap ? 'overdue-row' : ''}>
                <td>{buildingName(u.buildingId)}</td>
                <td>{floorLabel(u.level)}</td>
                <td>{u.items.length}</td>
                <td className="muted">
                  {[...new Set(u.items.map((i) => i.kind))]
                    .map((k) => FACILITY_LABELS[k])
                    .join('、')}
                </td>
                <td>{u.anchorDue}</td>
                <td className="muted">{toolsForKinds(u.items.map((i) => i.kind))}</td>
                <td><Link className="btn" to={`/floor/${u.floorId}`}>楼层图</Link></td>
              </tr>
            ))}
            {units.length === 0 && (
              <tr><td colSpan={7} className="hint">本季度没有到期的设施。</td></tr>
            )}
          </tbody>
        </table>
        <div className="toolbar">
          <button className="on" onClick={doGenerate} disabled={!units.length || !effectiveSelected.length}>
            {plan ? '重新生成季度批次' : '生成本季度批次'}
          </button>
          {plan && (
            <button
              className="danger"
              onClick={() => confirm('删除本季度计划？设施台账不受影响。') && deletePlan(year, quarter)}
            >
              删除计划
            </button>
          )}
          {!effectiveSelected.length && <span className="bad">请至少勾选一名检查人</span>}
        </div>
      </div>

      {/* 批次计划 */}
      {plan && (
        <div className="section">
          <div className="toolbar" style={{ justifyContent: 'space-between' }}>
            <h3 style={{ margin: 0 }}>批次计划</h3>
            <div className="toolbar" style={{ margin: 0 }}>
              <div className="ruletabs" style={{ margin: 0 }}>
                <button className={viewMode === 'date' ? 'on' : ''} onClick={() => setViewMode('date')}>按日期</button>
                <button className={viewMode === 'person' ? 'on' : ''} onClick={() => setViewMode('person')}>按人</button>
              </div>
              <label className="row">
                <input type="checkbox" checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} />
                隐藏已查完
              </label>
            </div>
          </div>

          {stats && (
            <p className="hint">
              共 {stats.totalBatches} 批：已查完 {stats.done} 批（{stats.checkedItems}/{stats.total} 项自动划掉），
              {stats.overdueBatches > 0 ? <span className="bad"> 已到期未完成 {stats.overdueBatches} 批</span> : ' 无逾期批次'}。
              判定口径：批次日期当天及之后有检查记录的设施视为已查。
            </p>
          )}

          <div className="toolbar">
            <button onClick={() => carryOver(planId, '__all_pending__')} disabled={!stats?.overdueBatches}>
              一键顺延全部已到期未完成批次
            </button>
            <button onClick={() => onCopy('date')}>{copied ? '已复制 ✓' : '复制派工清单（按日期）'}</button>
            <button onClick={() => onCopy('person')}>{copied ? '已复制 ✓' : '复制派工清单（按人）'}</button>
            <button onClick={() => onExportTxt('date')}>下载 TXT（按日期）</button>
            <button onClick={() => onExportTxt('person')}>下载 TXT（按人）</button>
          </div>

          {groups.map(([key, list]) => (
            <div key={key} className="batchgroup">
              <div className="batchgroup-head">
                {viewMode === 'date'
                  ? `📅 ${key}（周${weekdayCN(key)}）${key < today ? ' · 已过期' : key === today ? ' · 今天' : ''}`
                  : `👤 ${inspectorName(key)}（${list.length} 批）`}
              </div>
              {list.map((b) => {
                const p = batchProgress(b, floors, now);
                return <BatchCard key={b.id} batch={b} progress={p} planId={planId} />;
              })}
            </div>
          ))}
          {visibleBatches.length === 0 && <p className="hint">{onlyPending ? '没有待完成批次——全部已查完 🎉' : '本季度尚无批次。'}</p>}
        </div>
      )}
    </div>
  );

  function BatchCard({
    batch: b,
    progress: p,
    planId: pid,
  }: {
    batch: PlanBatch;
    progress: ReturnType<typeof batchProgress>;
    planId: string;
  }) {
    const [open, setOpen] = useState(false);
    const kindCounts = new Map<string, number>();
    for (const it of b.items) kindCounts.set(it.kind, (kindCounts.get(it.kind) ?? 0) + 1);
    return (
      <div className={`batchcard ${p.completed ? 'done' : ''} ${p.overdue ? 'overdue' : ''}`}>
        <div className="batchcard-head" onClick={() => setOpen((v) => !v)}>
          <span className="batchtitle">
            {viewMode === 'date' ? `👤 ${inspectorName(b.inspectorId)}` : `📅 ${b.date}（周${weekdayCN(b.date)}）`}
          </span>
          <span className="batchfloors">
            {b.floorIds
              .map((fid) => resolveFloor(fid))
              .filter(Boolean)
              .map((x) => x!.buildingName + x!.label)
              .join('、')}
          </span>
          <span className="badge st-ok">{p.checked}/{p.total} 项</span>
          {p.completed && <span className="badge st-ok">已查完·自动划掉</span>}
          {p.overdue && <span className="badge st-expired">逾期未完成</span>}
          {b.carriedOver && <span className="badge st-low_pressure">已顺延</span>}
          <span className="hint">{open ? '收起 ▲' : '展开 ▼'}</span>
        </div>
        <div className="batchmeta">
          设施：{[...kindCounts.entries()].map(([k, n]) => `${FACILITY_LABELS[k as keyof typeof FACILITY_LABELS]}×${n}`).join('、')}
          {' ｜ '}带：{toolsForKinds(b.items.map((i) => i.kind))}
        </div>
        {b.postponement && <div className="batchnote">⚠️ {b.postponement}</div>}
        {open && (
          <div className="batchdetail">
            <table className="table">
              <tbody>
                {b.items.map((it) => {
                  const fac = floorOf(it.floorId)?.facilities.find((f) => f.id === it.facilityId);
                  const checked = fac ? fac.checks.some((c) => c.date >= b.date) : true;
                  return (
                    <tr key={it.facilityId} className={checked ? 'row-done' : ''}>
                      <td>{FACILITY_LABELS[it.kind]}</td>
                      <td>{it.code}</td>
                      <td>应检 {it.dueDate}</td>
                      <td>{checked ? <span className="good">✓ 已查</span> : <span className="warn">待查</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="toolbar">
              <select value={b.inspectorId} onChange={(e) => reassignBatch(pid, b.id, e.target.value)}>
                {inspectors.map((p2) => (
                  <option key={p2.id} value={p2.id}>{p2.name}</option>
                ))}
              </select>
              <button
                disabled={p.completed}
                onClick={() => {
                  if (confirm('把这批未查完的设施顺延到下一工作日？已查完的会留原批并自动划掉。')) {
                    carryOver(pid, [b.id]);
                  }
                }}
              >
                一键顺延本批
              </button>
              <Link className="btn" to={`/facilities`}>去台账补检查记录</Link>
            </div>
          </div>
        )}
      </div>
    );
  }
}
