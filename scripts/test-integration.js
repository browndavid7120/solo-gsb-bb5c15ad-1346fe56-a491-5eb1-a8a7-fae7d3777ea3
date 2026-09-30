'use strict';

/*
 * 基于 pg-mem 的端到端业务流程测试（不依赖真实 PostgreSQL）：
 *   node scripts/test-integration.js
 * 覆盖：登记额度、提交/批准、重叠拒绝、超限按年超额量、并发批准不超配、
 *       实测替代估算、重叠实测拒绝、迟到实测转待复核与复核重新校验。
 */

process.env.SEED_DEMO = 'false';
process.env.PGHOST = 'memory';

const http = require('http');
const { newDb } = require('pg-mem');
const dbModule = require('../src/db');

// ---- 用 pg-mem 替换 pg 连接池 ----
const mem = newDb({ autoCreateForeignKeyIndices: true });
const { Pool: MemPool } = mem.adapters.createPg();
const fakePool = new MemPool();

// db.js 的 withTransaction 使用 pool.connect() 取得 client；其余处使用 pool.query。
dbModule.pool.connect = (...args) => fakePool.connect(...args);
dbModule.pool.query = (...args) => fakePool.query(...args);

const { createApp } = require('../src/app');
const { initializeDatabase } = require('../src/init');
const config = require('../src/config');

let server;
let base;
const cookies = new Map();
let assertCount = 0;

function assert(cond, msg) {
  assertCount++;
  if (!cond) throw new Error('断言失败: ' + msg);
}

function call(method, urlPath, body, role) {
  const cookie = role ? cookies.get(role) : null;
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      `${base}${urlPath}`,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
          ...(cookie ? { Cookie: `lqsession=${cookie}` } : {}),
        },
      },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          if (role && res.headers['set-cookie']) {
            const m = res.headers['set-cookie'][0].match(/lqsession=([a-f0-9]+)/);
            if (m) cookies.set(role, m[1]);
          }
          let json = null;
          try {
            json = JSON.parse(chunks);
          } catch (_) {
            /* ignore */
          }
          resolve({ status: res.statusCode, body: json });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  await initializeDatabase();

  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;

  await runFlow();
  await runAdjustmentFlow();

  server.close();
  console.log(`\n集成测试全部通过（${assertCount} 条断言）`);
  process.exit(0);
}

/** 墙上日期 n 天后的 'YYYY-MM-DD'（UTC 日历日，固定偏移在现有测试中同样按 UTC 取日）。 */
function futureYmd(daysAhead) {
  const d = new Date(Date.now() + daysAhead * 86400000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

async function runAdjustmentFlow() {
  // 第二个布展员账号：验证“只能撤回自己的申请”
  let r = await call('POST', '/api/users', {
    username: 'installer2', displayName: '布展员二', role: 'installer', password: 'setup123',
  }, 'c');
  assert(r.status === 201, '创建第二个布展员');
  r = await call('POST', '/api/auth/login',
    { username: 'installer2', password: 'setup123' }, 'i2');
  assert(r.status === 200, '布展员二登录');

  r = await call('POST', '/api/exhibits',
    { name: '调整测试展品', accessionNo: 'ADJ-1' }, 'c');
  assert(r.status === 201, '登记调整测试展品');
  const exhibitId = r.body.exhibit.id;

  const d1 = futureYmd(60);
  const y1 = Number(d1.slice(0, 4));
  const y2 = y1 + 1;
  const y3 = y1 + 2;
  await call('POST', `/api/exhibits/${exhibitId}/limits`, { year: y1, limitLxh: 5000 }, 'c');
  await call('POST', `/api/exhibits/${exhibitId}/limits`, { year: y2, limitLxh: 5000 }, 'c');
  await call('POST', `/api/exhibits/${exhibitId}/limits`, { year: y3, limitLxh: 5000 }, 'c');

  // 基准计划：d1 单日 09:00-17:00 100lx = 800
  r = await call('POST', '/api/plans', {
    exhibitId, title: '可调整计划', startDate: d1, endDate: d1,
    periods: ['09:00-17:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 201, '提交基准计划');
  const plan = r.body.plan.id;
  await call('POST', `/api/plans/${plan}/approve`, {}, 'c');

  // ---- 越权 / 无效输入 / 重复申请明确拒绝 ----
  r = await call('POST', `/api/plans/${plan}/adjustments`, {
    startDate: d1, endDate: d1, periods: ['09:00-12:00'], estimatedLux: 100,
  }, 'c');
  assert(r.status === 403, '保管员不能提交调整申请（越权拒绝）');

  r = await call('POST', `/api/plans/${plan}/adjustments`, {
    startDate: d1, endDate: d1, periods: ['09:00-09:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 400, '零时长时段调整被拒');

  r = await call('POST', `/api/plans/${plan}/adjustments`, {
    startDate: d1, endDate: d1, periods: ['09:00-12:00'], estimatedLux: -5,
  }, 'i');
  assert(r.status === 400, '非正照度调整被拒');

  // 待批准计划不能调整
  r = await call('POST', '/api/plans', {
    exhibitId, title: '待批计划', startDate: futureYmd(90), endDate: futureYmd(90),
    periods: ['09:00-10:00'], estimatedLux: 100,
  }, 'i');
  const submittedPlan = r.body.plan.id;
  r = await call('POST', `/api/plans/${submittedPlan}/adjustments`, {
    startDate: futureYmd(90), endDate: futureYmd(90),
    periods: ['09:00-11:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 400, '未批准计划调整被拒');

  // 提交第一份调整：缩短为 09:00-12:00（400 lx·h）
  r = await call('POST', `/api/plans/${plan}/adjustments`, {
    startDate: d1, endDate: d1, periods: ['09:00-12:00'], estimatedLux: 100,
    note: '缩短开灯',
  }, 'i');
  assert(r.status === 201, '提交调整申请');
  const adj = r.body.adjustment.id;
  assert(r.body.adjustment.status === 'pending', '新申请为待审');
  assert(r.body.adjustment.proposed.estimatedYearly[String(y1)] === 300,
    '拟改按年剂量 300（09:00-12:00 × 100lx）');

  // 待审期间原计划继续占用额度（used 仍为 800）
  r = await call('GET', `/api/exhibits/${exhibitId}`, null, 'c');
  assert(r.body.years[String(y1)].used === 800,
    `待审期间原计划继续占用 800，实际 ${r.body.years[String(y1)].used}`);
  // 详情含调整申请与原值/拟改值
  const adjInDetail = r.body.adjustments.find((a) => a.id === adj);
  assert(adjInDetail && adjInDetail.original.periods[0] === '09:00-17:00'
    && adjInDetail.proposed.periods[0] === '09:00-12:00',
    '展品详情展示调整申请原值与拟改值');
  // 计划列表标记待审
  r = await call('GET', `/api/plans?exhibitId=${exhibitId}`, null, 'i');
  const planRowNow = r.body.plans.find((p) => p.id === plan);
  assert(planRowNow.pending_adjustment_id === adj && planRowNow.can_adjust === true,
    '计划列表带待审调整标记与可调整标记');
  // 计划详情含 pendingAdjustment
  r = await call('GET', `/api/plans/${plan}`, null, 'i');
  assert(r.body.pendingAdjustment && r.body.pendingAdjustment.id === adj,
    '计划详情含待审调整申请');

  // 重复申请被拒
  r = await call('POST', `/api/plans/${plan}/adjustments`, {
    startDate: d1, endDate: d1, periods: ['09:00-13:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 409 && r.body.details.existingAdjustmentId === adj,
    '同一计划重复待审申请被拒并指明既有申请');

  // 他人不能撤回；保管员不能走撤回接口
  r = await call('POST', `/api/adjustments/${adj}/withdraw`, {}, 'i2');
  assert(r.status === 403, '非申请人撤回被拒');
  r = await call('POST', `/api/adjustments/${adj}/withdraw`, {}, 'c');
  assert(r.status === 403, '保管员不能调用撤回接口');

  // 保管员驳回：计划不改变，可重新提交
  r = await call('POST', `/api/adjustments/${adj}/reject`, { note: '先不改' }, 'i');
  assert(r.status === 403, '布展员不能驳回调整');
  r = await call('POST', `/api/adjustments/${adj}/reject`, { note: '先不改' }, 'c');
  assert(r.status === 200, '保管员驳回调整');
  r = await call('GET', `/api/plans/${plan}`, null, 'i');
  assert(r.body.plan.light_periods[0] === '09:00-17:00' && r.body.pendingAdjustment === null,
    '驳回不改变计划且不再有待审申请');

  // 撤回流程：再提交 → 撤回 → 可重提
  r = await call('POST', `/api/plans/${plan}/adjustments`, {
    startDate: d1, endDate: d1, periods: ['09:00-11:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 201, '驳回后可重新提交');
  const adj2 = r.body.adjustment.id;
  r = await call('POST', `/api/adjustments/${adj2}/withdraw`, {}, 'i');
  assert(r.status === 200, '申请人撤回待审申请');
  r = await call('POST', `/api/plans/${plan}/adjustments`, {
    startDate: d1, endDate: d1, periods: ['09:00-11:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 201, '撤回后可重新提交');
  const adj3 = r.body.adjustment.id;

  // ---- 批准核对：与同展品其他已批准计划开灯窗重叠 ----
  // 另一条计划：同日 18:00-20:00（与原 09-17 不重叠）
  r = await call('POST', '/api/plans', {
    exhibitId, title: '夜场', startDate: d1, endDate: d1,
    periods: ['18:00-20:00'], estimatedLux: 100,
  }, 'i');
  const nightPlan = r.body.plan.id;
  r = await call('POST', `/api/plans/${nightPlan}/approve`, {}, 'c');
  assert(r.status === 200, '夜场计划批准');
  // 拟改为 09:00-20:00（11h）：与夜场 18-20 重叠
  r = await call('POST', `/api/plans/${plan}/adjustments`, {
    startDate: d1, endDate: d1, periods: ['09:00-12:00'], estimatedLux: 100,
  }, 'i');
  // adj3 已占待审，先预期 409（验证仍是唯一待审）；改走 adj3 的批准：先把 adj3 当作短窗批准成功路径用，
  // 重叠场景使用单独申请：撤回 adj3 再提交长窗
  assert(r.status === 409, '存在待审时不能再提');
  await call('POST', `/api/adjustments/${adj3}/withdraw`, {}, 'i');
  r = await call('POST', `/api/plans/${plan}/adjustments`, {
    startDate: d1, endDate: d1, periods: ['09:00-20:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 201, '提交与夜场冲突的调整');
  const adjOverlap = r.body.adjustment.id;
  r = await call('POST', `/api/adjustments/${adjOverlap}/approve`, {}, 'c');
  assert(r.status === 409, '重叠调整批准被拒');
  assert(r.body.details.overlappingPlan && r.body.details.overlappingPlan.id === nightPlan,
    '冲突错误指明冲突计划');
  // 核对失败后申请保持待审
  r = await call('GET', `/api/adjustments/${adjOverlap}`, null, 'i');
  assert(r.body.adjustment.status === 'pending', '核对失败申请保持待审');
  // 计划原值未变
  r = await call('GET', `/api/plans/${plan}`, null, 'i');
  assert(r.body.plan.light_periods[0] === '09:00-17:00', '核对失败不改变计划');

  // ---- 未作废实测落在新窗口外（draft 也算）----
  await call('POST', `/api/adjustments/${adjOverlap}/withdraw`, {}, 'i');
  // 实测录在原窗口 16:00-17:00，拟改 09-12 无法覆盖
  r = await call('POST', '/api/measurements', {
    planId: plan, startDate: d1, startTime: '16:00', endDate: d1, endTime: '17:00',
    actualLux: 100,
  }, 'c');
  assert(r.status === 201, '录入原窗口内实测草稿');
  const draftMeas = r.body.measurement.id;
  r = await call('POST', `/api/plans/${plan}/adjustments`, {
    startDate: d1, endDate: d1, periods: ['09:00-12:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 201, '提交缩短调整（待批准核对时才检查实测）');
  const adjMeas = r.body.adjustment.id;
  r = await call('POST', `/api/adjustments/${adjMeas}/approve`, {}, 'c');
  assert(r.status === 409, '新窗口不覆盖未作废实测，批准被拒');
  assert(r.body.details.outsideMeasurements.some((m) => m.id === draftMeas),
    '错误指明越窗实测');
  assert(r.body.adjustment === undefined, '计划详情类字段不出现在错误响应');

  // 删除草稿实测后，同样的缩短调整还会因超额被拒（见下）；先测已确认实测被新窗覆盖时的额度替换
  await call('DELETE', `/api/measurements/${draftMeas}`, null, 'c');

  // ---- 超额：已确认实测 16-17 按 100lx=100，缩短到 09-12 残余 300，合计 400 不超；
  //      改成极低上限触发超额明细 ----
  r = await call('POST', '/api/measurements', {
    planId: plan, startDate: d1, startTime: '09:00', endDate: d1, endTime: '10:00',
    actualLux: 100,
  }, 'c');
  const measOk = r.body.measurement.id;
  await call('POST', `/api/measurements/${measOk}/confirm`, {}, 'c');
  // 当前 y1 占用：100(实测) + 700(plan 残余) + 200(夜场) = 1000
  r = await call('GET', `/api/exhibits/${exhibitId}`, null, 'c');
  assert(r.body.years[String(y1)].used === 1000, `调整前 y1 used=1000，实际 ${r.body.years[String(y1)].used}`);

  // 拟改 09:00-12:00：被实测覆盖 09-10，残余 10-12 = 200；used 变为 100+200+200=500（不超 5000）
  // 先制造超额：把 y1 上限降到 400 => 500 > 400
  await call('POST', `/api/exhibits/${exhibitId}/limits`, { year: y1, limitLxh: 400 }, 'c');
  r = await call('POST', `/api/adjustments/${adjMeas}/approve`, {}, 'c');
  assert(r.status === 409, '超额调整批准被拒');
  const of = r.body.details.overflows[0];
  assert(of && of.year === y1 && of.excess === 100 && of.projected === 500
    && of.addedByThisPlan === 200,
    `超额明细正确（projected=500, added=200, excess=100），实际=${JSON.stringify(r.body.details.overflows)}`);

  // 恢复上限，批准通过：原子更新计划，估算按新窗口残余替换
  await call('POST', `/api/exhibits/${exhibitId}/limits`, { year: y1, limitLxh: 5000 }, 'c');
  r = await call('POST', `/api/adjustments/${adjMeas}/approve`, {}, 'c');
  assert(r.status === 200, '调整批准通过');
  assert(r.body.years[String(y1)].used === 500,
    `通过后按新窗口残余替换：used=500，实际 ${r.body.years[String(y1)].used}`);
  r = await call('GET', `/api/plans/${plan}`, null, 'i');
  assert(r.body.plan.light_periods[0] === '09:00-12:00'
    && Number(r.body.plan.estimated_lux) === 100,
    '计划已原子更新为新窗口');
  assert(r.body.pendingAdjustment === null, '通过后无待审申请');
  r = await call('GET', `/api/adjustments/${adjMeas}`, null, 'i');
  assert(r.body.adjustment.status === 'approved', '调整申请状态为已通过');

  // ---- 已开始的计划不能调整 ----
  r = await call('POST', '/api/plans', {
    exhibitId, title: '未来计划2', startDate: futureYmd(120), endDate: futureYmd(120),
    periods: ['09:00-17:00'], estimatedLux: 100,
  }, 'i');
  const futurePlan2 = r.body.plan.id;
  await call('POST', `/api/plans/${futurePlan2}/approve`, {}, 'c');
  r = await call('POST', `/api/plans/${futurePlan2}/adjustments`, {
    startDate: futureYmd(121), endDate: futureYmd(121),
    periods: ['09:00-12:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 201, '未开始计划可提交调整');
  // 待复核计划不能调整：构造一个（用迟到实测超额）较复杂，这里直接用驳回态计划不可调已覆盖；
  // 已开始场景通过把展期调到过去不可行（计划本身已批准在未来），以 canAdjust 标记核对
  r = await call('GET', `/api/plans/${futurePlan2}`, null, 'i');
  assert(r.body.canAdjust === true && r.body.notStarted === true, '未来计划标记可调整');

  // 已开始（展期在过去）的已批准计划不能调整
  r = await call('GET', `/api/plans?exhibitId=${exhibitId}`, null, 'i');
  // 本展品计划都在未来；用 runFlow 中已开始的 plan1（跨流程共享数据库）
  r = await call('GET', '/api/plans', null, 'i');
  const startedApproved = r.body.plans.find((p) => p.status === 'approved' && !p.not_started);
  assert(startedApproved, '存在一条已开始的已批准计划（来自主流程）');
  r = await call('POST', `/api/plans/${startedApproved.id}/adjustments`, {
    startDate: '2026-03-05', endDate: '2026-03-05',
    periods: ['09:00-12:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 400, '已开始的已批准计划调整被拒');
  r = await call('GET', `/api/plans/${startedApproved.id}`, null, 'i');
  assert(r.body.canAdjust === false && r.body.notStarted === false,
    '已开始计划标记为不可调整');
  // 已驳回计划不能调整
  const rejectedPlan = await call('POST', '/api/plans', {
    exhibitId, title: '将被驳回', startDate: '2026-07-01', endDate: '2026-07-01',
    periods: ['09:00-10:00'], estimatedLux: 100,
  }, 'i');
  await call('POST', `/api/plans/${rejectedPlan.body.plan.id}/reject`, {}, 'c');
  r = await call('POST', `/api/plans/${rejectedPlan.body.plan.id}/adjustments`, {
    startDate: '2026-07-02', endDate: '2026-07-02',
    periods: ['09:00-12:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 400, '已驳回计划不能调整');

  // 调整列表接口可用
  r = await call('GET', '/api/adjustments?status=pending', null, 'i');
  assert(r.status === 200 && r.body.adjustments.some((a) => a.id),
    '待审调整列表接口可用');
  r = await call('GET', `/api/plans/${plan}/adjustments`, null, 'i');
  assert(r.status === 200 && r.body.adjustments.length >= 2,
    '某计划的调整历史可查');

  // 操作流水记录了调整事件
  r = await call('GET', '/api/audit?limit=1000', null, 'c');
  const actions = new Set(r.body.events.map((e) => e.action));
  for (const a of ['plan.adjustment.submit', 'plan.adjustment.approve',
    'plan.adjustment.reject', 'plan.adjustment.withdraw']) {
    assert(actions.has(a), `流水包含 ${a}`);
  }
}

async function runFlow() {
  // ---- 登录 / 角色 ----
  let r = await call('POST', '/api/auth/login',
    { username: config.seed.conservatorUsername, password: config.seed.conservatorPassword }, 'c');
  assert(r.status === 200, '保管员登录');
  r = await call('POST', '/api/auth/login',
    { username: config.seed.installerUsername, password: config.seed.installerPassword }, 'i');
  assert(r.status === 200, '布展员登录');

  r = await call('POST', '/api/exhibits', { name: 'X' }, 'i');
  assert(r.status === 403, '布展员不能登记展品');

  // ---- 登记展品与额度 ----
  r = await call('POST', '/api/exhibits',
    { name: '宋拓本', accessionNo: 'A-1', medium: '纸本' }, 'c');
  assert(r.status === 201, '登记展品');
  const exhibitId = r.body.exhibit.id;

  r = await call('POST', `/api/exhibits/${exhibitId}/limits`, { year: 2026, limitLxh: 1600 }, 'c');
  assert(r.status === 200, '登记 2026 上限 1600');

  // ---- 输入校验 ----
  r = await call('POST', '/api/plans', {
    exhibitId, title: '坏计划', startDate: '2026-03-01', endDate: '2026-03-01',
    periods: ['09:00-17:00'], estimatedLux: 0,
  }, 'i');
  assert(r.status === 400 && /正数/.test(r.body.error), '非正照度报错');

  r = await call('POST', '/api/plans', {
    exhibitId, title: '坏时段', startDate: '2026-03-01', endDate: '2026-03-02',
    periods: ['09:00-09:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 400, '零时长时段报错');

  r = await call('POST', '/api/plans', {
    exhibitId, title: '坏日期', startDate: '2026-02-30', endDate: '2026-03-02',
    periods: ['09:00-10:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 400, '非法日期报错');

  // ---- 计划1：3/1-3/2 每天 09-17，100lx = 1600 ----
  r = await call('POST', '/api/plans', {
    exhibitId, title: '三月展', startDate: '2026-03-01', endDate: '2026-03-02',
    periods: ['09:00-17:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 201, '提交计划1');
  const plan1 = r.body.plan.id;

  r = await call('GET', `/api/plans/${plan1}`, null, 'i');
  assert(r.body.estimatedYearly['2026'] === 1600, '按年拆分 2026=1600');

  r = await call('POST', `/api/plans/${plan1}/approve`, {}, 'i');
  assert(r.status === 403, '布展员不能批准');

  r = await call('POST', `/api/plans/${plan1}/approve`, {}, 'c');
  assert(r.status === 200, '保管员批准计划1');

  // ---- 夜场：同日但不重叠；额度不足 ----
  r = await call('POST', '/api/plans', {
    exhibitId, title: '夜场（不重叠）', startDate: '2026-03-01', endDate: '2026-03-01',
    periods: ['18:00-22:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 201, '非重叠时段可提交');
  const plan2 = r.body.plan.id;
  r = await call('POST', `/api/plans/${plan2}/approve`, {}, 'c');
  assert(r.status === 409 && r.body.details.overflows[0].year === 2026,
    '夜场批准因 2026 超限被拒');
  const ov = r.body.details.overflows[0];
  assert(ov.excess === 400 && ov.limit === 1600 && ov.projected === 2000,
    `超额量 400 正确，实际=${JSON.stringify(ov)}`);

  // ---- 时间重叠计划：提交即被拒 ----
  r = await call('POST', '/api/plans', {
    exhibitId, title: '撞车计划', startDate: '2026-03-02', endDate: '2026-03-02',
    periods: ['10:00-11:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 409, '重叠计划提交即被拒');

  // 提额到 3000 后夜场可批（1600+400=2000）
  await call('POST', `/api/exhibits/${exhibitId}/limits`, { year: 2026, limitLxh: 3000 }, 'c');
  r = await call('POST', `/api/plans/${plan2}/approve`, {}, 'c');
  assert(r.status === 200, '提额后夜场批准成功');

  // ---- 实测：3/1 实测 150lx 替代当天 100lx 估算 ----
  r = await call('POST', '/api/measurements', {
    planId: plan1, startDate: '2026-03-01', startTime: '09:00',
    endDate: '2026-03-01', endTime: '17:00', actualLux: 150,
  }, 'c');
  assert(r.status === 201, '录入实测草稿');
  const meas1 = r.body.measurement.id;

  r = await call('POST', '/api/measurements', {
    planId: plan1, startDate: '2026-03-01', startTime: '17:30',
    endDate: '2026-03-01', endTime: '18:30', actualLux: 100,
  }, 'c');
  assert(r.status === 400, '计划开灯窗外的实测被拒绝');

  r = await call('POST', '/api/measurements', {
    planId: plan1, startDate: '2026-03-01', startTime: '10:00',
    endDate: '2026-03-01', endTime: '11:00', actualLux: 100,
  }, 'c');
  assert(r.status === 409, '重叠实测被拒绝');

  r = await call('POST', `/api/measurements/${meas1}/confirm`, {}, 'c');
  assert(r.status === 200, '确认实测（不超限）');
  // 1200(实测) + 800(plan1 次日残余) + 400(夜场) = 2400
  assert(r.body.years['2026'].used === 2400,
    `实测替代估算后 2026 已用应为 2400，实际 ${r.body.years['2026'].used}`);
  assert(r.body.years['2026'].remaining === 600, '剩余 600');

  // ---- 迟到实测导致超限 + 转待复核 ----
  // 另一年份（约 400 天后）的已批准计划，用于验证“别的年份超额不会牵连它”
  const future = new Date(Date.now() + 400 * 86400000);
  const fy = future.getUTCFullYear();
  const fm = String(future.getUTCMonth() + 1).padStart(2, '0');
  const fd = String(future.getUTCDate()).padStart(2, '0');
  const futureYmd = `${fy}-${fm}-${fd}`;
  await call('POST', `/api/exhibits/${exhibitId}/limits`, { year: fy, limitLxh: 2000 }, 'c');

  r = await call('POST', '/api/plans', {
    exhibitId, title: '未来展（另一年份）', startDate: futureYmd, endDate: futureYmd,
    periods: ['09:00-17:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 201, '提交另一年份未来计划');
  const futurePlan = r.body.plan.id;
  r = await call('POST', `/api/plans/${futurePlan}/approve`, {}, 'c');
  assert(r.status === 200, '另一年份未来计划批准');

  // 2026 年内、确定尚未开始的计划（必须在迟到实测确认前批准）
  const in30 = new Date(Date.now() + 30 * 86400000);
  let pendingPlan = null;
  if (in30.getUTCFullYear() === 2026) {
    const m2 = String(in30.getUTCMonth() + 1).padStart(2, '0');
    const d2 = String(in30.getUTCDate()).padStart(2, '0');
    const ymd2 = `2026-${m2}-${d2}`;
    const cr = await call('POST', '/api/plans', {
      exhibitId, title: '2026未开始计划', startDate: ymd2, endDate: ymd2,
      periods: ['09:00-17:00'], estimatedLux: 50, // 8h*50 = 400
    }, 'i');
    assert(cr.status === 201, '提交 2026 未开始计划');
    pendingPlan = cr.body.plan.id;
    // 当前 used=2400，+400=2800 ≤ 3000
    const ar = await call('POST', `/api/plans/${pendingPlan}/approve`, {}, 'c');
    assert(ar.status === 200, `2026 未开始计划批准（实际 ${ar.status} ${JSON.stringify(ar.body)}）`);
  }

  // 迟到实测：plan1 第二天 3/2 实测 500lx => 4000 替代 800
  // 2026 used = 1200 + 4000 + 400(夜场) [+ 400 待复核计划] = 6000，超额 3000
  r = await call('POST', '/api/measurements', {
    planId: plan1, startDate: '2026-03-02', startTime: '09:00',
    endDate: '2026-03-02', endTime: '17:00', actualLux: 500,
  }, 'c');
  assert(r.status === 201, '录入迟到实测草稿');
  const meas2 = r.body.measurement.id;
  r = await call('POST', `/api/measurements/${meas2}/confirm`, {}, 'c');
  assert(r.status === 409, '迟到实测确认后超限返回 409');
  const of2026 = r.body.overflows.find((o) => o.year === 2026);
  assert(of2026 && of2026.excess === 3000 && of2026.projected === 6000,
    `2026 超额 3000、合计 6000，实际=${JSON.stringify(r.body.overflows)}`);
  // 另一年份的计划不受牵连
  assert(!r.body.flaggedPlans.some((p) => p.id === futurePlan),
    '另一年份的计划不因 2026 超额而转待复核');
  // 已开始（3 月）的 plan1/plan2 不转待复核
  assert(!r.body.flaggedPlans.some((p) => p.id === plan1 || p.id === plan2),
    '已开始的计划不转待复核');
  if (pendingPlan) {
    assert(r.body.flaggedPlans.some((p) => p.id === pendingPlan),
      '2026 年未开始计划转为待复核');
  }

  // 与已确认实测重叠的录入被拒绝
  const mr = await call('POST', '/api/measurements', {
    planId: plan1, startDate: '2026-03-02', startTime: '09:00',
    endDate: '2026-03-02', endTime: '10:00', actualLux: 600,
  }, 'c');
  assert(mr.status === 409, '与已确认实测重叠的录入被拒绝');

  // 超限未解除时，待复核计划复核仍被拒（原审批与测量记录保留）
  if (pendingPlan) {
    const rr = await call('POST', `/api/plans/${pendingPlan}/approve`, {}, 'c');
    assert(rr.status === 409, '超限状态下复核通过仍被拒绝');
  }

  // 超限状态下，新的计划批准必然 409
  r = await call('POST', '/api/plans', {
    exhibitId, title: '超额后的新计划', startDate: '2026-06-01', endDate: '2026-06-01',
    periods: ['09:00-10:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 201, '提交新计划');
  const blockedPlan = r.body.plan.id;
  r = await call('POST', `/api/plans/${blockedPlan}/approve`, {}, 'c');
  assert(r.status === 409, '超限状态下新计划批准被拒');

  // 已确认实测不可删除
  r = await call('DELETE', `/api/measurements/${meas2}`, null, 'c');
  assert(r.status === 400, '已确认实测不可删除（保留测量记录）');

  // 提额解除 2026 超限：待复核计划复核通过，新计划也可批
  await call('POST', `/api/exhibits/${exhibitId}/limits`, { year: 2026, limitLxh: 100000 }, 'c');
  if (pendingPlan) {
    const rr = await call('POST', `/api/plans/${pendingPlan}/approve`, {}, 'c');
    assert(rr.status === 200, '提额后待复核计划复核通过');
  }
  r = await call('POST', `/api/plans/${blockedPlan}/approve`, {}, 'c');
  assert(r.status === 200, '提额后新计划可批准');

  // ---- 跨年拆分：未登记年份额度 ----
  r = await call('POST', '/api/plans', {
    exhibitId, title: '跨年展', startDate: '2027-12-31', endDate: '2028-01-01',
    periods: ['09:00-17:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 201, '跨年计划可提交');
  const crossPlan = r.body.plan.id;
  r = await call('GET', `/api/plans/${crossPlan}`, null, 'i');
  assert(r.body.estimatedYearly['2027'] === 800 && r.body.estimatedYearly['2028'] === 800,
    '跨年剂量按自然年拆分');
  r = await call('POST', `/api/plans/${crossPlan}/approve`, {}, 'c');
  assert(r.status === 409, '跨年计划批准被拒');
  // fy 年（约一年后，通常是 2027）可能已登记额度；2028 一定未登记，错误必须指出缺失年份
  assert(/2028/.test(r.body.error), `错误指出 2028 年未登记额度，实际：${r.body.error}`);

  // ---- 并发批准不超配（额度恰好只够一个）----
  // 2027 已被 futurePlan 占用 800（上限 2000），提到 4000 以容纳跨年计划的 800
  if (fy === 2027) {
    await call('POST', `/api/exhibits/${exhibitId}/limits`, { year: 2027, limitLxh: 4000 }, 'c');
  } else {
    await call('POST', `/api/exhibits/${exhibitId}/limits`, { year: 2027, limitLxh: 800 }, 'c');
  }
  await call('POST', `/api/exhibits/${exhibitId}/limits`, { year: 2028, limitLxh: 900 }, 'c');
  r = await call('POST', `/api/plans/${crossPlan}/approve`, {}, 'c');
  assert(r.status === 200, `跨年计划批准：2027/2028 各占 800（实际 ${r.status} ${r.body && r.body.error}）`);

  const pairIds = [];
  for (let i = 0; i < 2; i++) {
    const cr = await call('POST', '/api/plans', {
      exhibitId, title: `并发二选一-${i}`, startDate: '2028-03-01', endDate: '2028-03-01',
      periods: ['09:00-10:00'], // 两计划开灯时刻相同 => 互斥
      estimatedLux: 100,
    }, 'i');
    pairIds.push(cr.body.plan.id);
  }
  const rs = await Promise.all(pairIds.map((id) => call('POST', `/api/plans/${id}/approve`, {}, 'c')));
  const oks = rs.filter((x) => x.status === 200).length;
  const rejects = rs.filter((x) => x.status === 409).length;
  assert(oks === 1 && rejects === 1,
    `并发批准相同开灯时段：恰好一个成功（ok=${oks}, reject=${rejects}），不发生超配`);

  // 纯额度并发：2028 剩余 0；提额 +100，两条互不重叠的 100 分钟计划并发批准，只能过一个
  await call('POST', `/api/exhibits/${exhibitId}/limits`, { year: 2028, limitLxh: 1000 }, 'c');
  const quotaIds = [];
  for (let i = 0; i < 2; i++) {
    const cr = await call('POST', '/api/plans', {
      exhibitId, title: `并发额度-${i}`, startDate: '2028-04-01', endDate: '2028-04-01',
      periods: [`0${6 + i}:00-0${7 + i}:00`], // 06-07 / 07-08，时间相接不重叠，各 100 lx·h
      estimatedLux: 100,
    }, 'i');
    assert(cr.status === 201, `并发额度计划 ${i} 创建成功（${cr.status} ${cr.body && cr.body.error}）`);
    quotaIds.push(cr.body.plan.id);
  }
  const qr = await Promise.all(quotaIds.map((qid) => call('POST', `/api/plans/${qid}/approve`, {}, 'c')));
  const qok = qr.filter((x) => x.status === 200).length;
  const qrej = qr.filter((x) => x.status === 409).length;
  assert(qok === 1 && qrej === 1,
    `额度仅够一个的并发批准：恰好一个成功（ok=${qok}, reject=${qrej}），不超配`);
  assert(qr.some((x) => x.status === 409 && x.body.details && x.body.details.overflows),
    '被拒响应包含按年超额明细');

  // ---- 操作流水存在 ----
  r = await call('GET', '/api/audit?limit=1000', null, 'c');
  assert(r.status === 200 && r.body.events.some((e) => e.action === 'plan.approve'),
    '操作流水记录了审批事件');
}

main().catch((err) => {
  console.error('集成测试失败:', err);
  process.exit(1);
});
