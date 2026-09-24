/**
 * 工作日 / 季度日期工具 —— 一律以 YYYY-MM-DD 字符串与「本地午夜时间戳」运算，
 * 避免 toISOString() 因 UTC 偏移把日期提前/推后一天。
 */

export type DateStr = string; // YYYY-MM-DD

const DAY_MS = 86400000;
const p2 = (v: number) => String(v).padStart(2, '0');

/** 时间戳 / 日期串 → 本地日期串 */
export function toDateStr(d: Date | number): DateStr {
  const x = typeof d === 'number' ? new Date(d) : d;
  return `${x.getFullYear()}-${p2(x.getMonth() + 1)}-${p2(x.getDate())}`;
}

/** 本地午夜时间戳（同一天内任意时刻归一到 00:00） */
export function dayStart(ds: DateStr): number {
  return new Date(`${ds}T00:00:00`).getTime();
}

/** 今天的日期串 */
export function todayStr(now: number = Date.now()): DateStr {
  return toDateStr(now);
}

/** ds + n 个自然日 */
export function addDays(ds: DateStr, n: number): DateStr {
  return toDateStr(dayStart(ds) + n * DAY_MS);
}

/** b - a（天），b 晚于 a 为正 */
export function diffDays(a: DateStr, b: DateStr): number {
  return Math.round((dayStart(b) - dayStart(a)) / DAY_MS);
}

export function isWeekend(ds: DateStr): boolean {
  const day = new Date(`${ds}T00:00:00`).getDay();
  return day === 0 || day === 6;
}

/** 周几（中文，一…日） */
export function weekdayCN(ds: DateStr): string {
  return ['日', '一', '二', '三', '四', '五', '六'][new Date(`${ds}T00:00:00`).getDay()];
}

/** 下一（或当天为工作日时即当天）工作日：跳过周末与节假日 */
export function nextWorkingDay(ds: DateStr, holidays: ReadonlySet<string>): DateStr {
  let d = ds;
  // 防御性上限：节假日配置异常（把工作日全标成节假日）时不会死循环
  for (let i = 0; i < 366; i++) {
    if (!isWeekend(d) && !holidays.has(d)) return d;
    d = addDays(d, 1);
  }
  return d;
}

/** 季度编号 1~4 */
export function quarterOf(year: number, month1Based: number): number {
  return Math.floor((month1Based - 1) / 3) + 1;
}

/** 某季度起止日期 [start, end]（均含） */
export function quarterRange(year: number, quarter: number): { start: DateStr; end: DateStr } {
  const startMonth = (quarter - 1) * 3 + 1;
  const endMonth = startMonth + 2;
  const endDay = new Date(year, endMonth, 0).getDate(); // endMonth 的下一月第 0 天 = 当月末
  return {
    start: `${year}-${p2(startMonth)}-01`,
    end: `${year}-${p2(endMonth)}-${p2(endDay)}`,
  };
}

/** 时间戳所属季度 */
export function quarterOfDate(now: number): { year: number; quarter: number } {
  const d = new Date(now);
  return { year: d.getFullYear(), quarter: quarterOf(d.getFullYear(), d.getMonth() + 1) };
}

/** 季度中文标签，如「2026 年第三季度」 */
export function quarterLabel(year: number, quarter: number): string {
  return `${year} 年第${['一', '二', '三', '四'][quarter - 1]}季度`;
}

/** 日期串是否落在区间内（含端点） */
export function inRange(ds: DateStr, start: DateStr, end: DateStr): boolean {
  return ds >= start && ds <= end;
}

/** 生成 [start, end] 内全部工作日（跳过周末/节假日），顺序升序 */
export function workingDaysBetween(start: DateStr, end: DateStr, holidays: ReadonlySet<string>): DateStr[] {
  const out: DateStr[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    if (!isWeekend(d) && !holidays.has(d)) out.push(d);
  }
  return out;
}
