'use strict';

const express = require('express');
const { query, withExhibitTransaction } = require('../db');
const { requireRole, requireAuth } = require('../auth');
const { recordAudit } = require('../audit');
const { ValidationError, ConflictError, AuthError } = require('../validation');
const { normalizeScheduleInput } = require('../plan-input');
const {
  lockExhibit,
  getPlan,
  isPlanNotStarted,
  getPendingAdjustmentForPlan,
  listAdjustments,
  serializeAdjustment,
  evaluateAdjustment,
  adjustmentWindows,
} = require('../service');
const { doseByYear, yearMapToObject } = require('../dosing');
const { exhibitDetail } = require('./exhibits');

/**
 * 调整申请路由分两部分：
 *  - planScopedRouter 挂在 /api/plans/:id/adjustments
 *      POST /  布展员为已批准且未开始的计划提交调整申请（同一计划同时仅一份待审）
 *      GET  /  某计划的调整申请列表
 *  - rootRouter 挂在 /api/adjustments
 *      GET  /            全部调整申请（可按展品/计划/状态过滤）
 *      GET  /:id         调整申请详情
 *      POST /:id/approve  保管员批准（展品行锁事务内重新核对，原子更新计划）
 *      POST /:id/reject   保管员驳回（不改变计划）
 *      POST /:id/withdraw 布展员撤回自己的待审申请
 */
const planScopedRouter = express.Router({ mergeParams: true });
const rootRouter = express.Router();
rootRouter.use(requireAuth);

function adjNote(body) {
  return body && typeof body.note === 'string' ? body.note.slice(0, 1000) : null;
}

// 提交调整申请（仅布展员）
planScopedRouter.post('/', requireRole('installer'), async (req, res, next) => {
  try {
    const planId = Number(req.params.id);
    if (!Number.isInteger(planId)) throw new ValidationError('计划 ID 无效');
    const input = normalizeScheduleInput(req.body || {}, { withTitle: false });
    const note = adjNote(req.body);

    const prePlan = await getPlan({ query }, planId);
    const adjustment = await withExhibitTransaction(prePlan.exhibit_id, async (client) => {
      await lockExhibit(client, prePlan.exhibit_id);
      const plan = await getPlan(client, planId);

      if (plan.status !== 'approved') {
        throw new ValidationError('只有已批准且尚未开始的计划可以提交调整申请');
      }
      if (!isPlanNotStarted(plan)) {
        throw new ValidationError('计划已经开始，不能再提交调整申请');
      }
      const existing = await getPendingAdjustmentForPlan(client, planId);
      if (existing) {
        throw new ConflictError(
          `该计划已有待审调整申请 #${existing.id}，请先撤回或等待审核，不能重复提交`,
          { existingAdjustmentId: existing.id }
        );
      }

      const inserted = await client.query(
        `INSERT INTO plan_adjustments
           (plan_id, exhibit_id, new_start_date, new_end_date,
            new_light_periods, new_estimated_lux, note, created_by)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8) RETURNING *`,
        [
          planId,
          plan.exhibit_id,
          input.startDate,
          input.endDate,
          JSON.stringify(input.periodSpecs),
          input.estimatedLux,
          note,
          req.sessionUser.userId,
        ]
      );
      const row = inserted.rows[0];
      // 待审期间原计划继续占用额度：仅记录申请，不改动 plans
      const proposedYearly = yearMapToObject(
        doseByYear(adjustmentWindows(row), Number(row.new_estimated_lux))
      );
      await recordAudit(client, req.sessionUser, 'plan.adjustment.submit',
        'plan_adjustment', row.id, {
          planId,
          exhibitId: plan.exhibit_id,
          original: {
            startDate: plan.start_date,
            endDate: plan.end_date,
            periods: plan.light_periods,
            estimatedLux: Number(plan.estimated_lux),
          },
          proposed: {
            startDate: input.startDate,
            endDate: input.endDate,
            periods: input.periodSpecs,
            estimatedLux: input.estimatedLux,
            estimatedYearly: proposedYearly,
          },
          note,
        });
      return row;
    });
    res.status(201).json({ adjustment: serializeAdjustment(adjustment, { withProposed: true }) });
  } catch (err) {
    // 并发下部分唯一索引兜底：同一计划同时只允许一份待审
    if (err && err.code === '23505') {
      return next(new ConflictError('该计划已有待审调整申请，不能重复提交（请先撤回或等待审核）', {
        existingPending: true,
      }));
    }
    next(err);
  }
});

// 某计划的调整申请列表
planScopedRouter.get('/', async (req, res, next) => {
  try {
    const planId = Number(req.params.id);
    if (!Number.isInteger(planId)) throw new ValidationError('计划 ID 无效');
    const rows = await listAdjustments({ query }, { planId });
    res.json({ adjustments: rows.map((a) => serializeAdjustment(a)) });
  } catch (err) {
    next(err);
  }
});

// 全部调整申请（可按展品/计划/状态过滤）
rootRouter.get('/', async (req, res, next) => {
  try {
    const exhibitId = req.query.exhibitId ? Number(req.query.exhibitId) : null;
    const planId = req.query.planId ? Number(req.query.planId) : null;
    const status = req.query.status ? String(req.query.status) : null;
    if (status && !['pending', 'approved', 'rejected', 'withdrawn'].includes(status)) {
      throw new ValidationError('调整申请状态过滤值无效');
    }
    const rows = await listAdjustments({ query }, { exhibitId, planId, status });
    res.json({ adjustments: rows.map((a) => serializeAdjustment(a)) });
  } catch (err) {
    next(err);
  }
});

async function loadAdjustment(client, id) {
  const { rows } = await client.query('SELECT * FROM plan_adjustments WHERE id = $1', [id]);
  if (rows.length === 0) throw new ValidationError('调整申请不存在');
  return rows[0];
}

// 调整申请详情
rootRouter.get('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw new ValidationError('调整申请 ID 无效');
    const rows = await listAdjustments({ query }, {});
    const adj = rows.find((a) => a.id === id);
    if (!adj) throw new ValidationError('调整申请不存在');
    res.json({ adjustment: serializeAdjustment(adj) });
  } catch (err) {
    next(err);
  }
});

/**
 * 保管员批准调整：在展品锁事务内重新核对全部条件，
 * 通过后原子更新计划（新展期/开灯时段/预计照度）并留审计；
 * 任一核对失败抛 409 并指明冲突计划/实测/超额年份，申请保持待审以便撤回。
 */
rootRouter.post('/:id/approve', requireRole('conservator'), (req, res, next) => {
  (async () => {
    const id = Number(req.params.id);
    const pre = await loadAdjustment({ query }, id);
    const detail = await withExhibitTransaction(pre.exhibit_id, async (client) => {
      await lockExhibit(client, pre.exhibit_id);
      const adj = await loadAdjustment(client, id);
      if (adj.status !== 'pending') {
        throw new ValidationError(`该调整申请当前状态（${adj.status}）不能批准`);
      }
      const plan = await getPlan(client, adj.plan_id);
      // 行锁事务内重新核对：计划仍已批准且未开始、实测落在新窗、计划重叠、年度额度
      const { addedYearly } = await evaluateAdjustment(client, plan, adj);

      // 原子更新计划（保持 approved 状态，原审批记录保留）
      await client.query(
        `UPDATE plans
            SET start_date = $2, end_date = $3, light_periods = $4::jsonb,
                estimated_lux = $5, updated_at = now()
          WHERE id = $1`,
        [
          plan.id,
          adj.new_start_date,
          adj.new_end_date,
          JSON.stringify(adj.new_light_periods),
          adj.new_estimated_lux,
        ]
      );
      await client.query(
        `UPDATE plan_adjustments
            SET status = 'approved', reviewed_by = $2, reviewed_at = now(),
                review_note = $3
          WHERE id = $1`,
        [id, req.sessionUser.userId, adjNote(req.body)]
      );
      await recordAudit(client, req.sessionUser, 'plan.adjustment.approve',
        'plan_adjustment', id, {
          planId: plan.id,
          exhibitId: plan.exhibit_id,
          applied: {
            startDate: adj.new_start_date,
            endDate: adj.new_end_date,
            periods: adj.new_light_periods,
            estimatedLux: Number(adj.new_estimated_lux),
          },
          addedYearly,
        });
      return exhibitDetail(client, plan.exhibit_id, { lock: true });
    });
    res.json(detail);
  })().catch(next);
});

// 保管员驳回：不改变计划
rootRouter.post('/:id/reject', requireRole('conservator'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const pre = await loadAdjustment({ query }, id);
    await withExhibitTransaction(pre.exhibit_id, async (client) => {
      await lockExhibit(client, pre.exhibit_id);
      const adj = await loadAdjustment(client, id);
      if (adj.status !== 'pending') {
        throw new ValidationError(`该调整申请当前状态（${adj.status}）不能驳回`);
      }
      await client.query(
        `UPDATE plan_adjustments
            SET status = 'rejected', reviewed_by = $2, reviewed_at = now(),
                review_note = $3
          WHERE id = $1`,
        [id, req.sessionUser.userId, adjNote(req.body)]
      );
      await recordAudit(client, req.sessionUser, 'plan.adjustment.reject',
        'plan_adjustment', id, { planId: adj.plan_id, exhibitId: adj.exhibit_id });
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// 布展员撤回自己的待审申请
rootRouter.post('/:id/withdraw', requireRole('installer'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const pre = await loadAdjustment({ query }, id);
    await withExhibitTransaction(pre.exhibit_id, async (client) => {
      await lockExhibit(client, pre.exhibit_id);
      const adj = await loadAdjustment(client, id);
      if (adj.status !== 'pending') {
        throw new ValidationError(`该调整申请当前状态（${adj.status}）不能撤回`);
      }
      if (Number(adj.created_by) !== req.sessionUser.userId) {
        throw new AuthError('只能撤回自己提交的调整申请', 403);
      }
      await client.query(
        `UPDATE plan_adjustments SET status = 'withdrawn' WHERE id = $1`,
        [id]
      );
      await recordAudit(client, req.sessionUser, 'plan.adjustment.withdraw',
        'plan_adjustment', id, { planId: adj.plan_id, exhibitId: adj.exhibit_id });
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = { planScopedRouter, rootRouter };
