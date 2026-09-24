/** 日期/工作日工具验收：季度边界、周末与节假日跳过、本地时区不串日 */
import { describe, it, expect } from 'vitest';
import {
  addDays,
  diffDays,
  isWeekend,
  nextWorkingDay,
  quarterOf,
  quarterOfDate,
  quarterRange,
  toDateStr,
  weekdayCN,
  workingDaysBetween,
} from '../src/lib/date';

describe('季度与日期运算', () => {
  it('quarterRange 四个季度的月末正确（含闰年 2 月）', () => {
    expect(quarterRange(2026, 1)).toEqual({ start: '2026-01-01', end: '2026-03-31' });
    expect(quarterRange(2024, 1).end).toBe('2024-03-31'); // 闰年
    expect(quarterRange(2026, 2)).toEqual({ start: '2026-04-01', end: '2026-06-30' });
    expect(quarterRange(2026, 4)).toEqual({ start: '2026-10-01', end: '2026-12-31' });
  });

  it('quarterOf / quarterOfDate 边界月份', () => {
    expect(quarterOf(2026, 1)).toBe(1);
    expect(quarterOf(2026, 3)).toBe(1);
    expect(quarterOf(2026, 4)).toBe(2);
    expect(quarterOf(2026, 12)).toBe(4);
    expect(quarterOfDate(new Date('2026-09-30T23:59:00').getTime())).toEqual({ year: 2026, quarter: 3 });
  });

  it('addDays/diffDays 本地午夜，跨年与夏令时区不串日', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(diffDays('2026-01-01', '2026-01-31')).toBe(30);
    expect(toDateStr(new Date('2026-01-01T00:00:00').getTime())).toBe('2026-01-01');
  });

  it('周末识别：2026-01-03 周六、01-04 周日', () => {
    expect(isWeekend('2026-01-03')).toBe(true);
    expect(isWeekend('2026-01-05')).toBe(false);
    expect(weekdayCN('2026-01-05')).toBe('一');
  });

  it('nextWorkingDay 跳过周末与节假日；工作日当天即返回当天', () => {
    expect(nextWorkingDay('2026-01-02', new Set())).toBe('2026-01-02'); // 周五
    expect(nextWorkingDay('2026-01-03', new Set())).toBe('2026-01-05'); // 周六 → 周一
    expect(nextWorkingDay('2026-02-15', new Set(['2026-02-16']))).toBe('2026-02-17'); // 周日→周一假→周二
  });

  it('workingDaysBetween 剔除周末/节假日', () => {
    const days = workingDaysBetween('2026-01-01', '2026-01-11', new Set());
    expect(days).toEqual(['2026-01-01', '2026-01-02', '2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09']);
  });
});
