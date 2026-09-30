'use strict';

const {
  ValidationError,
  assertDate,
  positiveNumber,
  nonEmptyString,
  parsePeriods,
} = require('./validation');

/**
 * 规范化“展期 + 每日开灯时段 + 预计照度”类输入（创建计划、提交调整共用）。
 * 返回 { startDate, endDate, periodSpecs, periods, estimatedLux }（可选 title）。
 */
function normalizeScheduleInput(body, { withTitle = false } = {}) {
  const out = {};
  if (withTitle) out.title = nonEmptyString(body.title, '计划名称', 200);
  const startDate = assertDate(body.startDate, '开始日期');
  const endDate = assertDate(body.endDate, '结束日期');
  if (endDate < startDate) throw new ValidationError('结束日期不能早于开始日期');
  const rawPeriods = body.periods;
  if (!Array.isArray(rawPeriods) || rawPeriods.some((p) => typeof p !== 'string')) {
    throw new ValidationError('每日开灯时段必须是字符串数组，如 ["09:00-12:00"]');
  }
  const periods = parsePeriods(rawPeriods);
  // 规范为 HH:MM-HH:MM（允许输入 HH:MM:00）
  const periodSpecs = periods.map((p) => {
    const endMin = (p.startMin + p.durationMin) % 1440;
    const fmt = (min) =>
      `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
    return `${fmt(p.startMin)}-${fmt(endMin)}`;
  });
  const estimatedLux = positiveNumber(body.estimatedLux, '预计照度（lx）', { max: 1000000 });

  // 展期最长约 5 年，防止误填导致的巨型计算
  const spanMs =
    Date.UTC(
      Number(endDate.slice(0, 4)),
      Number(endDate.slice(5, 7)) - 1,
      Number(endDate.slice(8, 10))
    ) -
    Date.UTC(
      Number(startDate.slice(0, 4)),
      Number(startDate.slice(5, 7)) - 1,
      Number(startDate.slice(8, 10))
    );
  if (spanMs / 86400000 + 1 > 1860) throw new ValidationError('展期跨度不能超过约 5 年');

  return { ...out, startDate, endDate, periodSpecs, periods, estimatedLux };
}

module.exports = { normalizeScheduleInput };
