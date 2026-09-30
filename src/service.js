'use strict';

const { ValidationError, ConflictError, parsePeriods } = require('./validation');
const {
  buildWindows,
  doseByYear,
  subtractIntervals,
  yearMapToObject,
  addYearDose,
  intersects,
  containsInterval,
  anyIntersect,
  round3,
  wallToTs,
  tsToWallString,
  yearOfTs,
} = require('./dosing');

const ACTIVE_PLAN_STATUSES = ['approved', 'pending_review'];
/** 规范化 DATE 值：真实 pg 经类型解析返回 'YYYY-MM-DD'；个别驱动（如内存测试）可能给 Date。 */
function dateYmd(v) {
  if (typeof v === 'string') return v.slice(0, 10);
  if (v instanceof Date) {
    return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(
      v.getUTCDate()
    ).padStart(2, '0')}`;
  }
  return v;
}

/** 读取展品（可加行锁，事务内批准/确认时使用）。 */
async function lockExhibit(client, exhibitId) {
  const { rows } = await client.query('SELECT * FROM exhibits WHERE id = $1 FOR UPDATE', [exhibitId]);
  if (rows.length === 0) throw new ValidationError('展品不存在');
  return rows[0];
}

async function getPlan(client, planId) {
  const { rows } = await client.query('SELECT * FROM plans WHERE id = $1', [planId]);
  if (rows.length === 0) throw new ValidationError('计划不存在');
  return rows[0];
}

/** 取该展品占用额度的计划（已批准、待复核）。excludePlanId 用于把待批计划自身排除。 */
async function getOccupyingPlans(client, exhibitId, excludePlanId = null) {
  // 状态为模块内固定白名单，直接内联到 SQL（避免不同驱动对 ANY($) 数组绑定的差异）
  const statusList = ACTIVE_PLAN_STATUSES.map((s) => `'${s}'`).join(',');
  const { rows } = await client.query(
    `SELECT * FROM plans
      WHERE exhibit_id = $1 AND status IN (${statusList})
        AND ($2::bigint IS NULL OR id <> $2)
      ORDER BY id`,
    [exhibitId, excludePlanId]
  );
  return rows;
}

async function getActiveMeasurements(client, exhibitId) {
  const { rows } = await client.query(
    `SELECT m.*, p.status AS plan_status
       FROM measurements m JOIN plans p ON p.id = m.plan_id
      WHERE m.exhibit_id = $1 AND m.status = 'confirmed'
      ORDER BY m.start_ts`,
    [exhibitId]
  );
  return rows;
}

function planWindows(plan) {
  return buildWindows(dateYmd(plan.start_date), dateYmd(plan.end_date), parsePeriods(plan.light_periods));
}

/**
 * 计划在扣除已确认实测覆盖后的估算剂量（按年）。
 * measWindows: computeOccupancy 中构造的实测区间数组。
 */
function planResidueYearly(plan, measWindows) {
  const windows = planWindows(plan);
  const coverers = measWindows.filter((mw) => windows.some((w) => intersects(w, mw)));
  const remaining = subtractIntervals(windows, coverers);
  return yearMapToObject(doseByYear(remaining, Number(plan.estimated_lux)));
}

/** 区间重叠的已确认实测（同一展品，排除作废），含端点比较。 */
async function findOverlappingMeasurement(client, exhibitId, startMs, endMs, excludeId = null) {
  const { rows } = await client.query(
    `SELECT id, start_ts, end_ts FROM measurements
      WHERE exhibit_id = $1 AND status <> 'annulled'
        AND ($4::bigint IS NULL OR id <> $4)
        AND start_ts < $3 AND end_ts > $2
      ORDER BY id
      LIMIT 1`,
    [exhibitId, new Date(startMs), new Date(endMs), excludeId]
  );
  return rows[0] || null;
}

/**
 * 计算一件展品的年度额度占用。
 * 口径：
 *   used[year] = Σ 已确认实测剂量（按时窗自然年拆分）
 *              + Σ 已批准/待复核计划“未被已确认实测覆盖部分”的估算剂量
 * 同一计划窗口先被该展品全部已确认实测（通常即本计划的实测）扣除，再按其照度估算，
 * 因此实测确认后该时段自动以实测替代估算。
 */
async function computeOccupancy(client, exhibitId, { excludePlanId = null, extraMeasurement = null } = {}) {
  const plans = await getOccupyingPlans(client, exhibitId, excludePlanId);
  const measurements = await getActiveMeasurements(client, exhibitId);
  const limitRows = await client.query(
    'SELECT year, limit_lxh FROM annual_limits WHERE exhibit_id = $1',
    [exhibitId]
  );
  const limits = {};
  for (const r of limitRows.rows) limits[String(r.year)] = Number(r.limit_lxh);

  const measWindows = measurements.map((m) => ({
    id: m.id,
    planId: m.plan_id,
    start: new Date(m.start_ts).getTime(),
    end: new Date(m.end_ts).getTime(),
    lux: Number(m.actual_lux),
  }));
  // 预演一条尚未确认（或刚录入）的实测，用于超额预判
  if (extraMeasurement) {
    measWindows.push({
      id: extraMeasurement.id || -1,
      planId: extraMeasurement.planId,
      start: extraMeasurement.start,
      end: extraMeasurement.end,
      lux: extraMeasurement.lux,
      draft: true,
    });
  }

  const used = {};
  const sources = [];

  // 1) 实测部分
  for (const mw of measWindows) {
    const yearly = yearMapToObject(doseByYear([{ start: mw.start, end: mw.end }], mw.lux));
    addYearDose(used, yearly);
    sources.push({
      kind: 'measurement',
      id: mw.id,
      planId: mw.planId,
      start: tsToWallString(mw.start),
      end: tsToWallString(mw.end),
      lux: mw.lux,
      yearly,
    });
  }

  // 2) 计划的估算残余
  for (const plan of plans) {
    const yearly = planResidueYearly(plan, measWindows);
    addYearDose(used, yearly);
    sources.push({
      kind: 'plan',
      id: plan.id,
      title: plan.title,
      status: plan.status,
      startDate: plan.start_date,
      endDate: plan.end_date,
      periods: plan.light_periods,
      lux: Number(plan.estimated_lux),
      yearly,
    });
  }

  const years = {};
  const allYears = new Set([
    ...Object.keys(limits),
    ...Object.keys(used),
  ].map(Number));
  for (const year of [...allYears].sort((a, b) => a - b)) {
    const key = String(year);
    const usedVal = round3(used[key] || 0);
    const limitVal = limits[key] !== undefined ? round3(limits[key]) : null;
    years[key] = {
      year,
      limit: limitVal,
      used: usedVal,
      remaining: limitVal === null ? null : round3(limitVal - usedVal),
      over: limitVal === null ? false : usedVal - limitVal > 0.005,
    };
  }

  return { limits, used, years, sources, plans, measurements };
}

/** 检查新增/复核的年度剂量并入当前占用后是否超限，返回超额明细数组。 */
function buildOverflows(currentUsed, limits, addedYearly) {
  const overflows = [];
  for (const [yearStr, add] of Object.entries(addedYearly)) {
    const limit = limits[yearStr];
    if (limit === undefined || limit === null) {
      throw new ConflictError(`${yearStr} 年尚未登记年度额度，无法批准`, {
        missingLimit: yearStr,
      });
    }
    const projected = round3((currentUsed[yearStr] || 0) + add);
    if (projected - limit > 0.005) {
      overflows.push({
        year: Number(yearStr),
        limit: round3(limit),
        usedBefore: round3(currentUsed[yearStr] || 0),
        addedByThisPlan: round3(add),
        projected,
        excess: round3(projected - limit),
      });
    }
  }
  return overflows;
}

/** 计划时间窗是否与同展品另一占用计划相交。 */
function planOverlaps(targetWindows, otherPlan) {
  return anyIntersect(targetWindows, planWindows(otherPlan));
}

/**
 * 校验实测时段：
 *  - 必须落在所属已批准/待复核计划的开灯窗内
 *  - 不得与同展品任何未作废实测重叠
 * 返回 { start, end, windows }（毫秒）
 */
async function validateMeasurementWindow(client, plan, startYmd, startMinute, endYmd, endMinute, excludeMeasId = null) {
  if (!ACTIVE_PLAN_STATUSES.includes(plan.status)) {
    throw new ValidationError('只有已批准（或待复核）计划才能登记实测');
  }
  const start = wallToTs(startYmd, startMinute);
  const end = wallToTs(endYmd, endMinute);
  if (!(end > start)) throw new ValidationError('实测时段结束必须晚于开始');

  const windows = planWindows(plan);
  const seg = { start, end };
  if (!windows.some((w) => containsInterval(w, seg))) {
    throw new ValidationError(
      `实测时段 ${tsToWallString(start)} ~ ${tsToWallString(end)} 不在该计划的开灯时段内`
    );
  }
  const overlap = await findOverlappingMeasurement(client, plan.exhibit_id, start, end, excludeMeasId);
  if (overlap) {
    throw new ConflictError(
      `与已登记实测 #${overlap.id}（${tsToWallString(new Date(overlap.start_ts).getTime())} ~ ` +
        `${tsToWallString(new Date(overlap.end_ts).getTime())}）时间重叠，已拒绝`,
      { overlappingMeasurementId: overlap.id }
    );
  }
  return { start, end, windows };
}

/**
 * 迟到实测超额后，找出需要转为“待复核”的计划：
 * 同展品、已批准、在超额年份尚有估算剂量、且计划首个开灯时刻尚未开始。
 */
function plansToFlag(plans, occupancy, overflowYears, nowMs) {
  const planEstimate = new Map();
  for (const src of occupancy.sources.filter((s) => s.kind === 'plan')) {
    planEstimate.set(src.id, src.yearly);
  }
  const flagged = [];
  for (const plan of plans) {
    if (plan.status !== 'approved') continue;
    const yearly = planEstimate.get(plan.id) || {};
    if (!overflowYears.some((y) => (yearly[String(y)] || 0) > 0)) continue;
    const firstStart = Math.min(...planWindows(plan).map((w) => w.start));
    if (firstStart > nowMs) flagged.push({ plan, firstStart });
  }
  return flagged;
}

// ===================== 计划调整申请 =====================

/** 拟改值的开灯时间窗。 */
function adjustmentWindows(adj) {
  return buildWindows(dateYmd(adj.new_start_date), dateYmd(adj.new_end_date),
    parsePeriods(adj.new_light_periods));
}

/** 计划首个开灯时刻（毫秒）。 */
function planFirstStartMs(plan) {
  return Math.min(...planWindows(plan).map((w) => w.start));
}

/** 计划是否尚未开始（首个开灯时刻在 now 之后）。 */
function isPlanNotStarted(plan, nowMs = Date.now()) {
  return planFirstStartMs(plan) > nowMs;
}

/**
 * 是否允许提交调整：仅“已批准且尚未开始”的计划。
 * 待批准/已驳回/已取消/待复核均不允许（待复核应先由保管员复核）。
 */
function canAdjustPlan(plan, nowMs = Date.now()) {
  return plan.status === 'approved' && isPlanNotStarted(plan, nowMs);
}

/** 读取某计划当前唯一的待审调整申请（无则 null）。 */
async function getPendingAdjustmentForPlan(client, planId) {
  const { rows } = await client.query(
    `SELECT a.*, u.display_name AS creator_name, r.display_name AS reviewer_name
       FROM plan_adjustments a
       LEFT JOIN users u ON u.id = a.created_by
       LEFT JOIN users r ON r.id = a.reviewed_by
      WHERE a.plan_id = $1 AND a.status = 'pending'
      ORDER BY a.id DESC LIMIT 1`,
    [planId]
  );
  return rows[0] || null;
}

/** 查询调整申请列表（可按展品/计划/状态过滤），含计划与人员名称。 */
async function listAdjustments(client, { exhibitId = null, planId = null, status = null } = {}) {
  const conds = [];
  const params = [];
  if (exhibitId !== null && exhibitId !== undefined) {
    params.push(exhibitId);
    conds.push(`a.exhibit_id = $${params.length}`);
  }
  if (planId !== null && planId !== undefined) {
    params.push(planId);
    conds.push(`a.plan_id = $${params.length}`);
  }
  if (status !== null && status !== undefined) {
    params.push(status);
    conds.push(`a.status = $${params.length}`);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const { rows } = await client.query(
    `SELECT a.*, p.title AS plan_title, p.status AS plan_status,
            p.start_date AS plan_start_date, p.end_date AS plan_end_date,
            p.light_periods AS plan_light_periods, p.estimated_lux AS plan_estimated_lux,
            e.name AS exhibit_name,
            u.display_name AS creator_name, r.display_name AS reviewer_name
       FROM plan_adjustments a
       JOIN plans p ON p.id = a.plan_id
       JOIN exhibits e ON e.id = a.exhibit_id
       LEFT JOIN users u ON u.id = a.created_by
       LEFT JOIN users r ON r.id = a.reviewed_by
       ${where}
      ORDER BY a.id DESC`,
    params
  );
  return rows;
}

/** 调整申请序列化（含原值与拟改值对比、按年拟改剂量）。 */
function serializeAdjustment(adj, { withProposed = true } = {}) {
  const proposed = withProposed
    ? {
        startDate: dateYmd(adj.new_start_date),
        endDate: dateYmd(adj.new_end_date),
        periods: adj.new_light_periods,
        estimatedLux: Number(adj.new_estimated_lux),
        estimatedYearly: yearMapToObject(
          doseByYear(adjustmentWindows(adj), Number(adj.new_estimated_lux))
        ),
      }
    : null;
  return {
    id: adj.id,
    planId: adj.plan_id,
    exhibitId: adj.exhibit_id,
    exhibitName: adj.exhibit_name || null,
    planTitle: adj.plan_title || null,
    note: adj.note,
    status: adj.status,
    createdBy: adj.created_by === null ? null : Number(adj.created_by),
    creatorName: adj.creator_name || null,
    reviewedBy: adj.reviewed_by === null ? null : Number(adj.reviewed_by),
    reviewerName: adj.reviewer_name || null,
    reviewedAt: adj.reviewed_at || null,
    reviewNote: adj.review_note || null,
    createdAt: adj.created_at,
    // 原计划值（联表查询时才有，用于页面对比展示）
    original:
      adj.plan_title !== undefined
        ? {
            title: adj.plan_title,
            planStatus: adj.plan_status,
            startDate: dateYmd(adj.plan_start_date),
            endDate: dateYmd(adj.plan_end_date),
            periods: adj.plan_light_periods,
            estimatedLux: Number(adj.plan_estimated_lux),
          }
        : null,
    proposed,
  };
}

/**
 * 调整批准时的重新核对（须在“展品锁事务”内调用）。
 * 规则：
 *  1) 计划仍已批准且尚未开始；
 *  2) 该计划所有未作废（draft/confirmed）实测仍完整落在新开灯窗内；
 *  3) 新窗口不与同展品其他已批准/待复核计划的开灯窗重叠；
 *  4) 以“新窗口未被已确认实测覆盖部分”的估算量替换原计划剩余估算量，
 *     按自然年并入当前占用后任一年不得超过年度上限。
 * 返回 { plan, newWindows, addedYearly }；任一不满足抛 ConflictError（details 携带冲突明细）。
 */
async function evaluateAdjustment(client, plan, adj) {
  const nowMs = Date.now();
  const newWindows = adjustmentWindows(adj);
  const newLux = Number(adj.new_estimated_lux);
  const problems = [];
  const details = {};

  // 1) 计划仍已批准且尚未开始
  if (plan.status !== 'approved' || !isPlanNotStarted(plan, nowMs)) {
    throw new ValidationError(
      `计划当前状态（${plan.status === 'approved' ? '已批准但已开始' : plan.status}），该调整申请不能通过`
    );
  }

  // 2) 该计划所有未作废实测必须仍落在新窗口内
  const { rows: measRows } = await client.query(
    `SELECT id, start_ts, end_ts, status, actual_lux
       FROM measurements
      WHERE plan_id = $1 AND status <> 'annulled'
      ORDER BY id`,
    [plan.id]
  );
  const outside = [];
  for (const m of measRows) {
    const seg = {
      start: new Date(m.start_ts).getTime(),
      end: new Date(m.end_ts).getTime(),
    };
    if (!newWindows.some((w) => containsInterval(w, seg))) {
      outside.push({
        id: m.id,
        status: m.status,
        start: tsToWallString(seg.start),
        end: tsToWallString(seg.end),
      });
    }
  }
  if (outside.length > 0) {
    details.outsideMeasurements = outside;
    problems.push(
      `以下未作废实测不在拟改后的开灯窗内：` +
        outside.map((m) => `实测 #${m.id}（${m.start} ~ ${m.end}，${m.status === 'draft' ? '待确认' : '已确认'}）`).join('；')
    );
  }

  // 3) 与同展品其他已批准/待复核计划的开灯窗重叠
  const others = await getOccupyingPlans(client, plan.exhibit_id, plan.id);
  const clash = others.find((other) => anyIntersect(newWindows, planWindows(other)));
  if (clash) {
    details.overlappingPlan = { id: clash.id, title: clash.title, status: clash.status };
    problems.push(`新窗口与同一展品计划「${clash.title}」(#${clash.id}) 的开灯时间重叠`);
  }

  // 4) 按自然年替换原计划剩余估算量后的额度校验
  //    当前占用已排除本计划（excludePlanId），其中实测已按原窗口归属计量；
  //    本计划新窗口中被已确认实测覆盖的部分不重复计估算。
  const occupancy = await computeOccupancy(client, plan.exhibit_id, { excludePlanId: plan.id });
  const selfConfirmed = measRows
    .filter((m) => m.status === 'confirmed')
    .map((m) => ({ start: new Date(m.start_ts).getTime(), end: new Date(m.end_ts).getTime() }));
  const remainingWindows = subtractIntervals(newWindows, selfConfirmed);
  const addedYearly = yearMapToObject(doseByYear(remainingWindows, newLux));

  // 未登记年度额度
  const missingLimits = Object.keys(addedYearly)
    .map(Number)
    .sort((a, b) => a - b)
    .filter((y) => occupancy.limits[String(y)] === undefined);
  if (missingLimits.length > 0) {
    details.missingLimits = missingLimits;
    problems.push(`${missingLimits.join('、')} 年尚未登记年度额度，无法通过调整`);
  }

  const overflows = buildOverflows(occupancy.used, occupancy.limits, addedYearly);
  if (overflows.length > 0) {
    details.overflows = overflows;
    problems.push(
      overflows
        .map(
          (o) =>
            `${o.year} 年超出年度上限：上限 ${o.limit}，当前已用 ${o.usedBefore}，` +
            `拟改新增 ${o.addedByThisPlan}，合计 ${o.projected}，超额 ${o.excess} lx·h`
        )
        .join('；')
    );
  }

  if (problems.length > 0) {
    throw new ConflictError(`调整申请核对未通过：${problems.join('；')}`, details);
  }

  return { newWindows, addedYearly, selfConfirmed };
}

module.exports = {
  ACTIVE_PLAN_STATUSES,
  lockExhibit,
  getPlan,
  getOccupyingPlans,
  planWindows,
  planResidueYearly,
  findOverlappingMeasurement,
  computeOccupancy,
  buildOverflows,
  planOverlaps,
  validateMeasurementWindow,
  plansToFlag,
  yearOfTs,
  adjustmentWindows,
  planFirstStartMs,
  isPlanNotStarted,
  canAdjustPlan,
  getPendingAdjustmentForPlan,
  listAdjustments,
  serializeAdjustment,
  evaluateAdjustment,
};
