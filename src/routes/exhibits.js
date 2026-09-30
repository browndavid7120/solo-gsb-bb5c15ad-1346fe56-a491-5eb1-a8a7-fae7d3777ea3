'use strict';

const express = require('express');
const { query, withTransaction, withExhibitTransaction } = require('../db');
const { requireRole } = require('../auth');
const { recordAudit } = require('../audit');
const { ValidationError, nonEmptyString, positiveNumber } = require('../validation');
const { computeOccupancy, lockExhibit, decoratePlans } = require('../service');
const { tsToWallString } = require('../dosing');

const router = express.Router();

function serializeMeasurement(m) {
  return {
    id: m.id,
    planId: m.plan_id,
    exhibitId: m.exhibit_id,
    start: tsToWallString(new Date(m.start_ts).getTime()),
    end: tsToWallString(new Date(m.end_ts).getTime()),
    actualLux: Number(m.actual_lux),
    status: m.status,
    note: m.note,
    createdAt: m.created_at,
  };
}

async function exhibitDetail(client, exhibitId, { lock = false } = {}) {
  const exhibit = lock ? await lockExhibit(client, exhibitId)
    : (await client.query('SELECT * FROM exhibits WHERE id = $1', [exhibitId])).rows[0];
  if (!exhibit) throw new ValidationError('展品不存在');

  const occupancy = await computeOccupancy(client, exhibitId);
  const plans = (
    await client.query(
      `SELECT p.*, u.display_name AS creator_name, a.display_name AS approver_name
         FROM plans p
         LEFT JOIN users u ON u.id = p.created_by
         LEFT JOIN users a ON a.id = p.approved_by
        WHERE p.exhibit_id = $1 ORDER BY p.id DESC`,
      [exhibitId]
    )
  ).rows;
  // 附加各计划的待审调整申请（含原值/拟改值试算），原有字段保持不变
  await decoratePlans(client, plans, { withPreview: true });
  const measurements = (
    await client.query(
      `SELECT * FROM measurements WHERE exhibit_id = $1 ORDER BY start_ts DESC, id DESC`,
      [exhibitId]
    )
  ).rows.map(serializeMeasurement);

  return {
    exhibit,
    years: occupancy.years,
    sources: occupancy.sources,
    plans,
    measurements,
  };
}

// 展品列表（带每展品年度额度概况）
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM exhibits ORDER BY id');
    const items = [];
    for (const e of rows) {
      const occupancy = await computeOccupancy({ query }, e.id);
      items.push({ ...e, years: occupancy.years });
    }
    res.json({ exhibits: items });
  } catch (err) {
    next(err);
  }
});

// 展品详情：剩余额度、占用来源、计划、实测
router.get('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const detail = await exhibitDetail({ query }, id);
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

// 保管员登记展品
router.post('/', requireRole('conservator'), async (req, res, next) => {
  try {
    const name = nonEmptyString(req.body.name, '展品名称', 200);
    const accessionNo = req.body.accessionNo ? nonEmptyString(req.body.accessionNo, '编号', 100) : null;
    const medium = req.body.medium ? nonEmptyString(req.body.medium, '材质', 200) : null;
    const note = typeof req.body.note === 'string' ? req.body.note.slice(0, 1000) : null;

    const { rows } = await withTransaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO exhibits (name, accession_no, medium, note, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [name, accessionNo, medium, note, req.sessionUser.userId]
      );
      await recordAudit(client, req.sessionUser, 'exhibit.create', 'exhibit', inserted.rows[0].id, { name });
      return inserted;
    });
    res.status(201).json({ exhibit: rows[0] });
  } catch (err) {
    next(err);
  }
});

// 保管员登记/修改某展品某自然年的照度时数上限
router.post('/:id/limits', requireRole('conservator'), async (req, res, next) => {
  try {
    const exhibitId = Number(req.params.id);
    const year = Number(req.body.year);
    if (!Number.isInteger(year) || year < 1900 || year > 2999) {
      throw new ValidationError('年份必须是 1900-2999 之间的整数');
    }
    const limitLxh = positiveNumber(req.body.limitLxh, '年度照度时数上限（lx·h）');

    const detail = await withExhibitTransaction(exhibitId, async (client) => {
      await lockExhibit(client, exhibitId);
      await client.query(
        `INSERT INTO annual_limits (exhibit_id, year, limit_lxh, created_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (exhibit_id, year) DO UPDATE SET limit_lxh = EXCLUDED.limit_lxh`,
        [exhibitId, year, limitLxh, req.sessionUser.userId]
      );
      await recordAudit(client, req.sessionUser, 'limit.upsert', 'exhibit', exhibitId, {
        year,
        limitLxh,
      });
      return exhibitDetail(client, exhibitId, { lock: true });
    });
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

module.exports = { router, exhibitDetail, serializeMeasurement };
