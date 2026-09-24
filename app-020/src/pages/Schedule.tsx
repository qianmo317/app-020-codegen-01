import { Fragment, useEffect, useMemo, useState } from 'react';
import type { Inspector, ScheduleBatch } from '../model';
import { FACILITY_LABELS, type FacilityKind } from '../model';
import {
  addInspector,
  carryBatch,
  deleteBatch,
  deleteInspector,
  deletePlan,
  generatePlan,
  updateBatch,
  updateInspector,
  updatePlanSettings,
  useStore,
} from '../store/store';
import { floorLabel } from '../store/id';
import { Link } from '../router';
import {
  batchProgress,
  currentQuarter,
  dueOccurrences,
  floorLevelLabel,
  nextDueDate,
  quarterLabel,
  quarterMonths,
  quarterRange,
  renderDispatch,
  weekdayCn,
  type DispatchGrouping,
} from '../lib/schedule';
import { download } from './Facilities';

type ViewMode = 'date' | 'inspector';

/** 列出当前季度前后各 4 个季度，供切换 */
function quarterChoices(center: string): string[] {
  const [y, q] = center.split('-Q').map(Number);
  const out: string[] = [];
  for (let i = -4; i <= 4; i++) {
    const idx = q - 1 + i;
    const yy = y + Math.floor(idx / 4);
    const qq = ((idx % 4) + 4) % 4 + 1;
    out.push(`${yy}-Q${qq}`);
  }
  return out;
}

export function SchedulePage() {
  const buildings = useStore((s) => s.buildings);
  const floors = useStore((s) => s.floors);
  const inspectors = useStore((s) => s.inspectors);
  const settings = useStore((s) => s.planSettings);
  const plans = useStore((s) => s.plans);

  const [quarter, setQuarter] = useState(currentQuarter());
  const [view, setView] = useState<ViewMode>('date');
  const [grouping, setGrouping] = useState<DispatchGrouping>('date');
  const [hideDone, setHideDone] = useState(false);
  const [newInspector, setNewInspector] = useState('');
  const [holidayText, setHolidayText] = useState('');
  const [copied, setCopied] = useState(false);

  // 节假日输入框是「编辑 → 保存」模式：草稿只在已保存的值变化时同步，避免打字被回写覆盖
  const holidayJoined = settings.holidays.join('\n');
  useEffect(() => {
    setHolidayText(holidayJoined);
  }, [holidayJoined]);

  const plan = plans[quarter];
  const range = useMemo(() => quarterRange(quarter), [quarter]);
  const months = useMemo(() => quarterMonths(quarter), [quarter]);

  const enriched = useMemo(() => {
    const batches = plan?.batches ?? [];
    return batches.map((batch) => ({ key: batch.id, batch, prog: batchProgress(batch, floors) }));
  }, [plan, floors]);

  const visible = enriched.filter(({ batch, prog }) => !(hideDone && (prog.completed || batch.carried)));

  const totalCount = enriched.length;
  const doneCount = enriched.filter(({ batch, prog }) => batch.carried || prog.completed).length;
  const pendingCount = totalCount - doneCount;
  const overCapCount = enriched.filter(({ batch, prog }) => batch.overCap && !prog.completed && !batch.carried).length;

  const regenerate = () => {
    const n = generatePlan(quarter);
    alert(`已生成${quarterLabel(quarter)}派工计划，共 ${n} 批（已查完的批保持划掉、不重排）`);
  };

  const copyDispatch = async () => {
    const text = renderDispatch(plan?.batches ?? [], floors, grouping, inspectors);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt('复制以下文本贴到群里：', text);
    }
  };

  const downloadDispatch = () => {
    const text = renderDispatch(plan?.batches ?? [], floors, grouping, inspectors);
    download(`派工清单_${quarter}_${grouping === 'date' ? '按日期' : '按人'}.txt`, text, 'text/plain');
  };

  const saveHolidays = () => {
    const days = Array.from(
      new Set(
        holidayText
          .split(/[\s,，、;；\n]+/)
          .map((s) => s.trim())
          .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s)),
      ),
    ).sort();
    updatePlanSettings({ holidays: days });
    setHolidayText(days.join('\n'));
  };

  return (
    <div className="page schedule-page">
      <h2>季度检查派工计划</h2>
      <p className="hint">
        每类设施按各自周期算下次应检日：灭火器 / 消火栓每月、指示灯 / 应急照明每季、安全出口 / 喷淋每半年；
        同一楼层的设施合在一批检查，每人每天有件数上限，超限整批顺延到下一工作日。
      </p>

      {/* 顶部：季度与设置 */}
      <div className="section">
        <div className="toolbar">
          <label className="row">
            季度
            <select value={quarter} onChange={(e) => setQuarter(e.target.value)}>
              {quarterChoices(currentQuarter()).map((q) => (
                <option key={q} value={q}>{quarterLabel(q)}</option>
              ))}
            </select>
          </label>
          <span className="hint">
            {range.start} ~ {range.end} · 应检月份 {months.join('、')}
          </span>
          <button onClick={regenerate}>{plan ? '按最新检查记录重新排产' : '排产本季度'}</button>
          {plan && (
            <button
              className="ghost danger"
              onClick={() => confirm(`清空${quarterLabel(quarter)}的全部批次？（检查记录保留，可随时重新排产）`) && deletePlan(quarter)}
            >
              清空本季
            </button>
          )}
          <span className="hint">
            共 {totalCount} 批 · 待检 <b className={pendingCount ? 'warn' : 'good'}>{pendingCount}</b> · 已完成 {doneCount}
            {overCapCount > 0 && <> · <b className="bad">{overCapCount} 批超单人上限</b></>}
          </span>
        </div>

        <div className="sched-settings">
          <div className="sched-block">
            <h4>巡检员</h4>
            <div className="stack">
              {inspectors.map((ins) => (
                <label className="row" key={ins.id}>
                  <input
                    type="checkbox"
                    checked={ins.active}
                    onChange={(e) => updateInspector(ins.id, { active: e.target.checked })}
                    title="停用后不再派新批"
                  />
                  <input value={ins.name} onChange={(e) => updateInspector(ins.id, { name: e.target.value })} />
                  <button className="ghost danger" onClick={() => confirm(`删除巡检员「${ins.name}」？其名下批次将变为未指派`) && deleteInspector(ins.id)}>删</button>
                </label>
              ))}
            </div>
            <div className="toolbar">
              <input placeholder="新增巡检员姓名" value={newInspector} onChange={(e) => setNewInspector(e.target.value)} />
              <button
                disabled={!newInspector.trim()}
                onClick={() => {
                  addInspector(newInspector.trim());
                  setNewInspector('');
                }}
              >
                添加
              </button>
            </div>
          </div>

          <div className="sched-block">
            <h4>派工设置</h4>
            <label className="row">
              每人每天最多检查（件）
              <input
                type="number"
                min={1}
                style={{ width: 90 }}
                value={settings.cap}
                onChange={(e) => updatePlanSettings({ cap: Math.max(1, Number(e.target.value) || 1) })}
              />
            </label>
            <h4>法定节假日（周末默认休，无需填）</h4>
            <textarea
              className="holiday-input"
              rows={3}
              placeholder={'2026-10-01\n每行一个或用逗号分隔'}
              value={holidayText}
              onChange={(e) => setHolidayText(e.target.value)}
            />
            <div className="toolbar">
              <button onClick={saveHolidays}>保存节假日</button>
              {settings.holidays.length > 0 && (
                <span className="hint">已设 {settings.holidays.length} 天：{settings.holidays.slice(0, 4).join('、')}{settings.holidays.length > 4 ? ' …' : ''}</span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 本季要查的设施（按楼栋/楼层） */}
      <FacilityOverview quarter={quarter} />

      {/* 视图切换 + 导出派工清单 */}
      <div className="toolbar">
        <button className={view === 'date' ? 'on' : ''} onClick={() => setView('date')}>计划表 · 按日期看</button>
        <button className={view === 'inspector' ? 'on' : ''} onClick={() => setView('inspector')}>计划表 · 按人看</button>
        <label className="row">
          <input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} />
          隐藏已划掉的批
        </label>
        <span style={{ flex: 1 }} />
        <span className="hint">派工清单按</span>
        <select value={grouping} onChange={(e) => setGrouping(e.target.value as DispatchGrouping)}>
          <option value="date">按日期分组</option>
          <option value="inspector">按巡检员分组</option>
        </select>
        <button onClick={copyDispatch}>{copied ? '已复制 ✓' : '复制派工清单到群'}</button>
        <button onClick={downloadDispatch}>下载 TXT</button>
      </div>

      {!plan && (
        <div className="section hint">
          还没有{quarterLabel(quarter)}的计划。确认上面的巡检员、日上限、节假日后，点「排产本季度」自动分批派工。
        </div>
      )}

      {plan && view === 'date' && <DateView entries={visible} quarter={quarter} />}
      {plan && view === 'inspector' && <InspectorView entries={visible} inspectors={inspectors} quarter={quarter} />}
    </div>
  );
}

// ---------- 按楼栋/楼层列出本季要查的设施 ----------

const OVERVIEW_KINDS: FacilityKind[] = ['extinguisher', 'hydrant', 'exit_sign', 'emergency_light', 'exit', 'sprinkler'];

function FacilityOverview({ quarter }: { quarter: string }) {
  const buildings = useStore((s) => s.buildings);
  const floors = useStore((s) => s.floors);
  const [openFloor, setOpenFloor] = useState<string | null>(null);
  const range = useMemo(() => quarterRange(quarter), [quarter]);

  const rows = buildings.map((b) => ({
    building: b,
    floors: b.floors
      .map((fid) => floors[fid])
      .filter(Boolean)
      .map((f) => {
        const dueFacs = f.facilities.filter((fac) => dueOccurrences(fac, range).length > 0);
        const counts = new Map<FacilityKind, number>();
        let earliest: string | null = null;
        for (const fac of dueFacs) {
          counts.set(fac.kind, (counts.get(fac.kind) ?? 0) + 1);
          const d = nextDueDate(fac);
          if (d && (!earliest || d < earliest)) earliest = d;
        }
        return { floor: f, dueFacs, counts, earliest };
      })
      .filter((r) => r.dueFacs.length > 0),
  }));

  const totalDue = rows.reduce((s, r) => s + r.floors.reduce((n, fl) => n + fl.dueFacs.length, 0), 0);

  return (
    <div className="section">
      <h3>本季要查的设施（按楼栋 / 楼层）</h3>
      <p className="hint">合计 {totalDue} 个设施在本季有应检时点（月检类在季内可能要查多次）。点楼层展开明细。</p>
          {rows.length === 0 && <p className="hint">还没有楼栋或设施，请先在楼层编辑器中布置。</p>}
          {rows.map(({ building, floors: fls }) =>
            fls.length === 0 ? null : (
              <div key={building.id} className="ov-building">
                <h4>{building.name}</h4>
                <table className="table">
                  <thead>
                    <tr>
                      <th>楼层</th>
                      {OVERVIEW_KINDS.map((k) => (
                        <th key={k}>{FACILITY_LABELS[k]}</th>
                      ))}
                      <th>合计</th>
                      <th>最早应检日</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {fls.map(({ floor, dueFacs, counts, earliest }) => {
                      const open = openFloor === floor.id;
                      return (
                        <Fragment key={floor.id}>
                          <tr>
                            <td>{floorLabel(floor.level)}</td>
                            {OVERVIEW_KINDS.map((k) => (
                              <td key={k}>{counts.get(k) ?? ''}</td>
                            ))}
                            <td><b>{dueFacs.length}</b></td>
                            <td>{earliest ?? <span className="hint">从未检查（季初补检）</span>}</td>
                            <td>
                              <button className="ghost" onClick={() => setOpenFloor(open ? null : floor.id)}>
                                {open ? '收起' : `明细 ${dueFacs.length}`}
                              </button>
                            </td>
                          </tr>
                          {open && (
                            <tr key={`${floor.id}-detail`}>
                              <td colSpan={9}>
                                <div className="ov-detail">
                                  {dueFacs.map((fac) => {
                                    const occ = dueOccurrences(fac, range);
                                    const due = nextDueDate(fac);
                                    return (
                                      <span key={fac.id} className="fac-chip" title={`应检月份：${occ.map((o) => o.on.slice(0, 7)).join('、')}`}>
                                        {fac.code} · {FACILITY_LABELS[fac.kind]}
                                        <em className="hint">{due ?? '未检过'}</em>
                                      </span>
                                    );
                                  })}
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ),
          )}
    </div>
  );
}

// ---------- 批次卡片与视图 ----------

type Entry = { key: string; batch: ScheduleBatch; prog: ReturnType<typeof batchProgress> };

function InspectorSelect({ batch, quarter }: { batch: ScheduleBatch; quarter: string }) {
  const inspectors = useStore((s) => s.inspectors);
  return (
    <select value={batch.inspectorId ?? ''} onChange={(e) => updateBatch(quarter, batch.id, { inspectorId: e.target.value || null })}>
      <option value="">未指派</option>
      {inspectors.map((i) => (
        <option key={i.id} value={i.id}>{i.name}</option>
      ))}
    </select>
  );
}

function BatchCard({ entry, quarter }: { entry: Entry; quarter: string }) {
  const { batch, prog } = entry;
  const done = prog.completed || !!batch.carried;
  const overCap = !!batch.overCap && !prog.completed && !batch.carried;
  const kinds = new Set(prog.items.map((i) => i.kind));

  return (
    <div className={`batch-card ${done ? 'is-done' : ''} ${overCap ? 'is-overcap' : ''}`}>
      <div className="batch-head">
        <b>
          {batch.buildingName} · {floorLevelLabel(batch.level)}
          <span className="tag">{batch.monthKey} 应检</span>
          {batch.carryover && <span className="tag tag-amber">顺延批</span>}
          {batch.carried && <span className="tag tag-muted">已顺延·留痕</span>}
          {prog.completed && <span className="tag tag-green">已查完</span>}
          {overCap && <span className="tag tag-red">超上限</span>}
        </b>
      </div>
      <div className="batch-grid">
        <label className="row">
          日期
          <input type="date" value={batch.date} onChange={(e) => updateBatch(quarter, batch.id, { date: e.target.value })} />
          <span className="hint">{weekdayCn(batch.date)}</span>
        </label>
        <label className="row">
          派给 <InspectorSelect batch={batch} quarter={quarter} />
        </label>
        <label className="row">
          携带
          <input
            value={batch.tools.join('、')}
            onChange={(e) => updateBatch(quarter, batch.id, { tools: e.target.value.split(/[、,，]/).map((s) => s.trim()).filter(Boolean) })}
            style={{ flex: 1 }}
          />
        </label>
        <div className="row">
          进度 <b className={prog.pending ? 'warn' : 'good'}>{prog.done}/{prog.total}</b>
          {batch.dueDate < batch.date && <span className="hint">应检日 {batch.dueDate}</span>}
        </div>
      </div>
      {batch.postponeReason && !done && <p className="postpone-reason">顺延说明：{batch.postponeReason}</p>}
      <div className="batch-facs">
        {[...kinds].map((k) => {
          const items = prog.items.filter((i) => i.kind === k);
          const doneN = items.filter((i) => i.done).length;
          return (
            <span key={k} className="fac-chip" title={items.map((i) => i.code).join('、')}>
              {FACILITY_LABELS[k]} {items.length} 件{doneN ? `（已查 ${doneN}）` : ''}
            </span>
          );
        })}
      </div>
      <div className="batch-foot">
        <Link className="btn" to={`/floor/${batch.floorId}`}>去楼层登记检查</Link>
        {!done && (
          <button
            title="把还没查的设施挪到下一工作日的新批；已查的自动留在原批并划掉"
            onClick={() => carryBatch(quarter, batch.id)}
          >
            未查完 → 挪下一批
          </button>
        )}
        <button className="ghost danger" title="删除这批（重新排产也会重建未完成批）" onClick={() => confirm('删除这批派工？') && deleteBatch(quarter, batch.id)}>删批</button>
      </div>
    </div>
  );
}

function groupEntries(entries: Entry[], keyFn: (b: ScheduleBatch) => string) {
  const map = new Map<string, Entry[]>();
  for (const e of entries) {
    const key = keyFn(e.batch);
    const list = map.get(key) ?? [];
    list.push(e);
    map.set(key, list);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function DateView({ entries, quarter }: { entries: Entry[]; quarter: string }) {
  const groups = groupEntries(entries, (b) => b.date);
  if (!groups.length) return <p className="hint">没有可显示的批次。</p>;
  return (
    <div className="schedule-groups">
      {groups.map(([date, list]) => (
        <section key={date} className="schedule-day">
          <h3>{date} {weekdayCn(date)} <span className="hint">（{list.length} 批）</span></h3>
          <div className="batch-grid-cards">
            {list
              .sort((a, b) => a.batch.buildingName.localeCompare(b.batch.buildingName, 'zh-Hans-CN') || a.batch.level - b.batch.level)
              .map((e) => (
                <BatchCard key={e.key} entry={e} quarter={quarter} />
              ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function InspectorView({ entries, inspectors, quarter }: { entries: Entry[]; inspectors: Inspector[]; quarter: string }) {
  const groups = groupEntries(entries, (b) => b.inspectorId ?? '∅');
  const nameOf = (key: string) => (key === '∅' ? '未指派' : inspectors.find((i) => i.id === key)?.name ?? '已删除');
  if (!groups.length) return <p className="hint">没有可显示的批次。</p>;
  return (
    <div className="schedule-groups">
      {groups.map(([key, list]) => (
        <section key={key} className="schedule-person">
          <h3>{nameOf(key)} <span className="hint">（{list.length} 批 · {list.reduce((s, e) => s + e.prog.total, 0)} 件）</span></h3>
          <table className="table">
            <thead>
              <tr><th>日期</th><th>楼栋/楼层</th><th>进度</th><th>携带</th><th>状态/说明</th><th /></tr>
            </thead>
            <tbody>
              {list
                .sort((a, b) => a.batch.date.localeCompare(b.batch.date) || a.batch.level - b.batch.level)
                .map((e) => {
                  const { batch, prog } = e;
                  const isDone = prog.completed || batch.carried;
                  return (
                    <tr key={e.key} className={isDone ? 'row-done' : ''}>
                      <td>{batch.date}<div className="hint">{weekdayCn(batch.date)}</div></td>
                      <td>{batch.buildingName} {floorLabel(batch.level)}</td>
                      <td>{prog.done}/{prog.total}</td>
                      <td className="tools-cell">{batch.tools.join('、') || '—'}</td>
                      <td>
                        {prog.completed && <span className="badge st-ok">已查完</span>}
                        {batch.carried && <span className="badge">已顺延留痕</span>}
                        {batch.overCap && !isDone && <span className="badge st-expired">超上限</span>}
                        {!isDone && !batch.overCap && prog.pending > 0 && <span className="hint">待检 {prog.pending}</span>}
                        {batch.postponeReason && !isDone && <div className="hint postpone-reason">{batch.postponeReason}</div>}
                      </td>
                      <td>
                        <span className="cardactions">
                          <Link className="btn" to={`/floor/${batch.floorId}`}>登记</Link>
                          {!isDone && (
                            <button title="未查完的设施一键挪到下一工作日" onClick={() => carryBatch(quarter, batch.id)}>挪下一批</button>
                          )}
                        </span>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
