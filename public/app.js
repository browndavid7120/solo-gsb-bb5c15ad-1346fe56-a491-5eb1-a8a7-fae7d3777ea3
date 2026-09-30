'use strict';

const state = {
  user: null,
  tab: 'exhibits',
  exhibits: [],
  detail: null,
  plans: [],
  measurements: [],
  users: [],
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ---------- API ----------
async function api(method, url, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    /* 非 JSON */
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `请求失败 (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data || {};
}

// ---------- 通用渲染辅助 ----------
function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
const fmtN = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 3 }));
const STATUS_TEXT = {
  submitted: '待批准', approved: '已批准', rejected: '已驳回',
  cancelled: '已取消', pending_review: '待复核',
  draft: '待确认', confirmed: '已确认', annulled: '已作废',
  pending: '待审', withdrawn: '已撤回',
};
const ADJ_STATUS_TEXT = {
  pending: '待审', approved: '已通过', rejected: '已驳回', withdrawn: '已撤回',
};
function badge(status) {
  return `<span class="badge ${esc(status)}">${STATUS_TEXT[status] || esc(status)}</span>`;
}
function yearlyText(yearly) {
  const entries = Object.entries(yearly || {});
  if (!entries.length) return '无剂量';
  return entries.map(([y, d]) => `${y}年：${fmtN(d)} lx·h`).join('，');
}
function flash(kind, message, extrasHtml) {
  const el = $('#global-message');
  el.innerHTML = `<div class="flash ${kind}">${esc(message)}${extrasHtml || ''}</div>`;
  if (kind === 'success') setTimeout(() => { el.innerHTML = ''; }, 4000);
}
function clearFlash() { $('#global-message').innerHTML = ''; }

// ---------- 登录 / 会话 ----------
async function boot() {
  const { user } = await api('GET', '/api/auth/me');
  if (user) {
    state.user = user;
    showApp();
  } else {
    showLogin();
  }
}
function showLogin() {
  $('#login-view').classList.remove('hidden');
  $('#app-view').classList.add('hidden');
}
function showApp() {
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  applyRoleVisibility();
  $('#user-info').textContent = `${state.user.displayName}（${state.user.role === 'conservator' ? '保管员' : '布展员'}）`;
  switchTab(state.user.role === 'installer' ? 'plans' : 'exhibits');
}
function applyRoleVisibility() {
  const isConservator = state.user.role === 'conservator';
  $$('.conservator-only').forEach((el) => el.classList.toggle('hidden', !isConservator));
  $$('.installer-only').forEach((el) => el.classList.toggle('hidden', isConservator));
  // 调整表单默认收起，点“调整…”才展开
  $('#adjustment-form').classList.add('hidden');
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  const fd = new FormData(e.target);
  try {
    const { user } = await api('POST', '/api/auth/login', {
      username: fd.get('username'),
      password: fd.get('password'),
    });
    state.user = user;
    showApp();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});
$('#logout-btn').addEventListener('click', async () => {
  await api('POST', '/api/auth/logout').catch(() => {});
  state.user = null;
  location.reload();
});

// ---------- Tabs ----------
$$('.tab').forEach((btn) => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
async function switchTab(tab) {
  state.tab = tab;
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.tab-panel').forEach((p) => p.classList.add('hidden'));
  $(`#tab-${tab}`).classList.remove('hidden');
  clearFlash();
  if (tab === 'exhibits') await loadExhibits();
  if (tab === 'plans') await loadPlans();
  if (tab === 'measurements') await loadMeasurementsTab();
  if (tab === 'users') await loadUsers();
  if (tab === 'audit') await loadAudit();
}

// ---------- 展品与额度 ----------
async function loadExhibits() {
  const { exhibits } = await api('GET', '/api/exhibits');
  state.exhibits = exhibits;
  const list = $('#exhibit-list');
  if (!exhibits.length) {
    list.innerHTML = '<p class="muted">暂无展品。保管员可点击右上角“登记展品”。</p>';
  } else {
    list.innerHTML = exhibits.map((e) => {
      const years = Object.values(e.years || {});
      const chips = years.map((y) => {
        const cls = y.over ? 'over' : y.remaining !== null && y.remaining < y.limit * 0.1 ? 'warn' : '';
        return `<div class="chip ${cls}"><span>${y.year} 年剩余</span>
          <span class="mono">${y.limit === null ? '未设上限' : `${fmtN(y.remaining)} / ${fmtN(y.limit)} lx·h`}</span></div>`;
      }).join('');
      return `<div class="card exhibit-card" data-id="${e.id}">
        <h3>${esc(e.name)}</h3>
        <div class="acc">${esc(e.accession_no || '—')}${e.medium ? ' · ' + esc(e.medium) : ''}</div>
        <div class="year-chips">${chips || '<span class="muted small">尚未登记年度额度</span>'}</div>
      </div>`;
    }).join('');
    $$('.exhibit-card').forEach((card) =>
      card.addEventListener('click', () => openDetail(Number(card.dataset.id)))
    );
  }
  if (state.detail) $('#exhibit-detail').classList.add('hidden');
}

$('#new-exhibit-btn').addEventListener('click', async () => {
  const name = prompt('展品名称');
  if (!name) return;
  const accessionNo = prompt('藏品编号（可留空）') || null;
  const medium = prompt('材质（可留空）') || null;
  try {
    await api('POST', '/api/exhibits', { name: name.trim(), accessionNo, medium });
    await loadExhibits();
    flash('success', '展品已登记');
  } catch (err) { flash('error', err.message); }
});

async function openDetail(id) {
  const detail = await api('GET', `/api/exhibits/${id}`);
  state.detail = detail;
  $('#exhibit-list').classList.add('hidden');
  $('#new-exhibit-btn').classList.add('hidden');
  $('#exhibit-detail').classList.remove('hidden');
  renderDetail();
}
$('#close-detail').addEventListener('click', () => {
  state.detail = null;
  $('#exhibit-detail').classList.add('hidden');
  $('#exhibit-list').classList.remove('hidden');
  $('#new-exhibit-btn').classList.remove('hidden');
});

function renderDetail() {
  const d = state.detail;
  $('#detail-title').textContent = d.exhibit.name;
  $('#detail-meta').textContent =
    `编号：${d.exhibit.accession_no || '—'}　材质：${d.exhibit.medium || '—'}${d.exhibit.note ? '　备注：' + d.exhibit.note : ''}`;

  const years = Object.values(d.years);
  $('#year-tbody').innerHTML = years.length ? years.map((y) => `<tr class="${y.over ? 'over-row' : ''}">
      <td>${y.year}</td>
      <td class="mono">${y.limit === null ? '未登记' : fmtN(y.limit)}</td>
      <td class="mono">${fmtN(y.used)}</td>
      <td class="mono">${y.remaining === null ? '—' : fmtN(y.remaining)}</td>
      <td>${y.limit === null ? '<span class="muted">无法核算</span>'
        : y.over ? `<b style="color:#b42318">超限 ${fmtN(y.used - y.limit)}</b>` : '正常'}</td>
    </tr>`).join('') : '<tr><td colspan="5" class="muted">暂无数据</td></tr>';

  $('#sources-list').innerHTML = (d.sources || []).map((s) => {
    if (s.kind === 'measurement') {
      return `<div class="source-item measurement">
        实测 #${s.id}（计划 #${s.planId}）：${esc(s.start)} ~ ${esc(s.end)}，${s.lux} lx
        <div class="source-doses">已确认实测剂量：${yearlyText(s.yearly)}</div></div>`;
    }
    return `<div class="source-item plan ${s.status}">
      估算残余 · 计划 #${s.id}「${esc(s.title)}」${badge(s.status)}
      ：${esc(s.startDate)} ~ ${esc(s.endDate)}，每日 ${(s.periods || []).map(esc).join('、')}，${s.lux} lx
      <div class="source-doses">占用额度：${yearlyText(s.yearly)}（已扣除被实测覆盖部分）</div></div>`;
  }).join('') || '<p class="muted">暂无占用</p>';

  $('#detail-plan-tbody').innerHTML = d.plans.map(planRow).join('') ||
    '<tr><td colspan="7" class="muted">暂无计划</td></tr>';
  $('#detail-meas-tbody').innerHTML = d.measurements.map(measRow).join('') ||
    '<tr><td colspan="7" class="muted">暂无实测</td></tr>';

  $('#detail-adjustments').innerHTML = (d.adjustments || []).length
    ? `<table class="data"><thead><tr>
        <th>#</th><th>计划</th><th>原值 → 拟改值</th><th>拟改按年剂量</th><th>状态</th><th>申请人/审核</th><th>操作</th>
       </tr></thead><tbody>${d.adjustments.map(adjustmentRow).join('')}</tbody></table>`
    : '<p class="muted">暂无调整申请。</p>';

  $$('.plan-action').forEach((btn) => btn.addEventListener('click', () => planAction(btn)));
  $$('.meas-action').forEach((btn) => btn.addEventListener('click', () => measAction(btn)));
  $$('.adj-action').forEach((btn) => btn.addEventListener('click', () => adjustmentAction(btn)));
}

function planRow(p) {
  return `<tr>
    <td>${p.id}</td>
    <td>${esc(p.title)}</td>
    <td>${p.start_date} ~ ${p.end_date}</td>
    <td>${(p.light_periods || []).map(esc).join('<br>')}</td>
    <td class="mono">${fmtN(p.estimated_lux)}</td>
    <td>${badge(p.status)}${p.review_reason ? `<div class="small muted">${esc(p.review_reason)}</div>` : ''}
        ${p.pending_adjustment_id ? `<div class="small" style="color:#9a6700">有调整申请 #${p.pending_adjustment_id} 待审</div>` : ''}</td>
    <td>${planActionButtons(p)}</td>
  </tr>`;
}
function planActionButtons(p) {
  const isCustodian = state.user.role === 'conservator';
  const btns = [];
  if (isCustodian && (p.status === 'submitted' || p.status === 'pending_review')) {
    btns.push(`<button class="primary small-btn plan-action" data-action="approve" data-id="${p.id}">${p.status === 'pending_review' ? '复核通过' : '批准'}</button>`);
  }
  if (isCustodian && p.status === 'submitted') {
    btns.push(`<button class="small-btn plan-action" data-action="reject" data-id="${p.id}">驳回</button>`);
  }
  if (['submitted', 'approved', 'pending_review'].includes(p.status)) {
    btns.push(`<button class="danger small-btn plan-action" data-action="cancel" data-id="${p.id}">取消</button>`);
  }
  // 调整：已批准未开始可提交/查看；保管员可直接处理待审申请
  if (p.can_adjust && !p.pending_adjustment_id && !isCustodian) {
    btns.push(`<button class="small-btn adj-action" data-action="new" data-id="${p.id}">调整…</button>`);
  }
  if (p.pending_adjustment_id) {
    btns.push(`<button class="link small-btn adj-action" data-action="view-pending" data-id="${p.pending_adjustment_id}">查看调整</button>`);
  }
  return btns.join(' ') || '<span class="muted">—</span>';
}
function measRow(m) {
  const plan = (state.detail.plans || []).find((p) => p.id === m.planId);
  return `<tr>
    <td>${m.id}</td>
    <td>#${m.planId} ${esc(plan ? plan.title : '')}</td>
    <td>${esc(m.start)}</td><td>${esc(m.end)}</td>
    <td class="mono">${fmtN(m.actualLux)}</td>
    <td>${badge(m.status)}</td>
    <td>${m.status === 'draft' && state.user.role === 'conservator'
      ? `<button class="primary small-btn meas-action" data-action="confirm" data-id="${m.id}">确认</button>
         <button class="danger small-btn meas-action" data-action="delete" data-id="${m.id}">删除</button>`
      : '<span class="muted">—</span>'}</td>
  </tr>`;
}

$('#limit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    const detail = await api('POST', `/api/exhibits/${state.detail.exhibit.id}/limits`, {
      year: Number(fd.get('year')),
      limitLxh: Number(fd.get('limitLxh')),
    });
    state.detail = detail;
    renderDetail();
    flash('success', '年度上限已保存');
  } catch (err) { flash('error', err.message); }
});

async function planAction(btn) {
  const id = btn.dataset.id;
  const action = btn.dataset.action;
  try {
    if (action === 'approve') {
      // 批准成功返回展品详情
      const detail = await api('POST', `/api/plans/${id}/approve`);
      state.detail = detail;
      renderDetail();
      flash('success', `计划 #${id} 已批准`);
      return;
    }
    if (action === 'reject') {
      const reason = prompt('驳回原因（可留空）') || '';
      await api('POST', `/api/plans/${id}/reject`, { reason });
    }
    if (action === 'cancel') {
      if (!confirm(`确认取消计划 #${id}？`)) return;
      const reason = prompt('取消原因（可留空）') || '';
      await api('POST', `/api/plans/${id}/cancel`, { reason });
    }
    await refreshAfterChange();
    flash('success', '操作完成');
  } catch (err) {
    if (err.status === 409 && err.data && err.data.details && err.data.details.overflows) {
      const ofs = err.data.details.overflows;
      const html = '<ul>' + ofs.map((o) =>
        `<li>${o.year} 年：上限 ${fmtN(o.limit)}，当前已用 ${fmtN(o.usedBefore)}，本计划新增 ${fmtN(o.addedByThisPlan)}，合计 ${fmtN(o.projected)}，<b>超额 ${fmtN(o.excess)} lx·h</b></li>`
      ).join('') + '</ul>';
      flash('error', `计划 #${id} 未批准：存在超限年份`, html);
      await refreshAfterChange();
    } else {
      flash('error', err.message);
    }
  }
}

async function measAction(btn) {
  const id = btn.dataset.id;
  const action = btn.dataset.action;
  try {
    if (action === 'delete') {
      if (!confirm(`删除待确认实测 #${id}？`)) return;
      await api('DELETE', `/api/measurements/${id}`);
    } else if (action === 'confirm') {
      try {
        const detail = await api('POST', `/api/measurements/${id}/confirm`);
        state.detail = detail;
        renderDetail();
        flash('success', `实测 #${id} 已确认，估算已被实测替代`);
        return;
      } catch (err) {
        if (err.status === 409 && err.data && err.data.overflows) {
          const html = '<ul>' + err.data.overflows.map((o) =>
            `<li>${o.year} 年：上限 ${fmtN(o.limit)}，确认后合计 ${fmtN(o.projected)}，<b>超额 ${fmtN(o.excess)} lx·h</b></li>`
          ).join('') + '</ul>'
            + (err.data.flaggedPlans && err.data.flaggedPlans.length
              ? '<div>已转为待复核的计划：' + err.data.flaggedPlans.map((p) => `#${p.id}《${esc(p.title)}》`).join('、') + '</div>'
              : '');
          if (err.data.detail) {
            state.detail = err.data.detail;
            renderDetail();
          }
          flash('warn', `实测 #${id} 已确认，但造成超限`, html);
          return;
        }
        throw err;
      }
    }
    await refreshAfterChange();
  } catch (err) {
    flash('error', err.message);
  }
}

async function refreshAfterChange() {
  if (state.tab === 'exhibits' && state.detail) {
    state.detail = await api('GET', `/api/exhibits/${state.detail.exhibit.id}`);
    renderDetail();
  } else if (state.tab === 'exhibits') {
    await loadExhibits();
  } else if (state.tab === 'plans') {
    await loadPlans();
  } else if (state.tab === 'measurements') {
    await loadMeasurementsTab();
  }
}

// ---------- 布展计划 ----------
async function loadPlans() {
  await populateExhibitSelects();
  const { plans } = await api('GET', '/api/plans');
  state.plans = plans;
  $('#plan-list').innerHTML = plans.length
    ? `<table class="data"><thead><tr>
        <th>#</th><th>展品</th><th>名称</th><th>展期</th><th>每日开灯</th><th>预计照度</th>
        <th>按年预计剂量</th><th>状态</th><th>操作</th></tr></thead><tbody>
      ${plans.map(planListRow).join('')}</tbody></table>`
    : '<p class="muted">暂无计划。</p>';
  $$('.plan-action').forEach((btn) => btn.addEventListener('click', () => planAction(btn)));
  $$('.adj-action').forEach((btn) => btn.addEventListener('click', () => adjustmentAction(btn)));
}
function planListRow(p) {
  return `<tr>
    <td>${p.id}</td>
    <td>${esc(p.exhibit_name)}</td>
    <td>${esc(p.title)}</td>
    <td>${p.start_date}<br>~ ${p.end_date}</td>
    <td>${(p.light_periods || []).map(esc).join('<br>')}</td>
    <td class="mono">${fmtN(p.estimated_lux)} lx</td>
    <td><button class="link small-btn plan-action" data-action="view" data-id="${p.id}">查看拆分</button></td>
    <td>${badge(p.status)}${p.review_reason ? `<div class="small muted">${esc(p.review_reason)}</div>` : ''}
        ${p.pending_adjustment_id ? `<div class="small" style="color:#9a6700">调整申请 #${p.pending_adjustment_id} 待审</div>` : ''}</td>
    <td>${planActionButtons(p)}</td>
  </tr>`;
}

async function populateExhibitSelects() {
  if (!state.exhibits.length) {
    state.exhibits = (await api('GET', '/api/exhibits')).exhibits;
  }
  const opts = state.exhibits.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join('');
  $('#plan-exhibit-select').innerHTML = opts || '<option value="">（请先登记展品）</option>';

  // 实测计划下拉：仅已批准/待复核
  const activePlans = [];
  for (const e of state.exhibits) {
    const detail = await api('GET', `/api/exhibits/${e.id}`);
    for (const p of detail.plans) {
      if (['approved', 'pending_review'].includes(p.status)) activePlans.push({ e, p });
    }
  }
  $('#meas-plan-select').innerHTML = activePlans.length
    ? activePlans.map(({ e, p }) =>
        `<option value="${p.id}">#${p.id} ${esc(e.name)} / ${esc(p.title)}（${p.start_date}~${p.end_date}）</option>`).join('')
    : '<option value="">暂无已批准计划</option>';
}

$('#plan-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const periods = String(fd.get('periods')).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  try {
    await api('POST', '/api/plans', {
      exhibitId: Number(fd.get('exhibitId')),
      title: fd.get('title'),
      startDate: fd.get('startDate'),
      endDate: fd.get('endDate'),
      periods,
      estimatedLux: Number(fd.get('estimatedLux')),
    });
    e.target.reset();
    await loadPlans();
    flash('success', '计划已提交，等待保管员批准');
  } catch (err) { flash('error', err.message); }
});

// ---------- 计划调整申请 ----------
const ADJ_BADGE_CLS = { pending: 'pending_review', approved: 'approved', rejected: 'rejected', withdrawn: 'cancelled' };
function adjBadge(status) {
  return `<span class="badge ${ADJ_BADGE_CLS[status] || ''}">${ADJ_STATUS_TEXT[status] || esc(status)}</span>`;
}

// 原值 → 拟改值对比（变化项高亮）
function adjustmentCompareCell(a) {
  const o = a.original || {};
  const p = a.proposed || {};
  const periodsSame = JSON.stringify(o.periods || []) === JSON.stringify(p.periods || []);
  const row = (label, from, to, changed) =>
    `<div class="${changed ? 'adj-changed' : ''}">${label}：${esc(from)} → <b>${esc(to)}</b></div>`;
  return `<div class="small">
    ${row('展期', `${o.startDate} ~ ${o.endDate}`, `${p.startDate} ~ ${p.endDate}`,
      o.startDate !== p.startDate || o.endDate !== p.endDate)}
    ${row('开灯', (o.periods || []).join('、'), (p.periods || []).join('、'), !periodsSame)}
    ${row('预计照度', `${fmtN(o.estimatedLux)} lx`, `${fmtN(p.estimatedLux)} lx`,
      Number(o.estimatedLux) !== Number(p.estimatedLux))}
  </div>`;
}

function adjustmentRow(a) {
  const isCustodian = state.user.role === 'conservator';
  let actions = '<span class="muted">—</span>';
  if (a.status === 'pending') {
    const btns = [];
    if (isCustodian) {
      btns.push(`<button class="primary small-btn adj-action" data-action="approve" data-id="${a.id}">批准调整</button>`);
      btns.push(`<button class="small-btn adj-action" data-action="reject" data-id="${a.id}">驳回</button>`);
    } else if (a.createdBy === state.user.id) {
      btns.push(`<button class="danger small-btn adj-action" data-action="withdraw" data-id="${a.id}">撤回</button>`);
    }
    if (btns.length) actions = btns.join(' ');
  }
  return `<tr>
    <td>${a.id}</td>
    <td>#${a.planId} ${esc(a.planTitle || '')}</td>
    <td>${adjustmentCompareCell(a)}</td>
    <td class="small">${yearlyText(a.proposed && a.proposed.estimatedYearly)}</td>
    <td>${adjBadge(a.status)}${a.reviewNote ? `<div class="small muted">${esc(a.reviewNote)}</div>` : ''}</td>
    <td class="small">${esc(a.creatorName || '—')}<br><span class="muted">${a.reviewerName ? '审核：' + esc(a.reviewerName) : ''}</span></td>
    <td>${actions}</td>
  </tr>`;
}

function adjustmentConflictHtml(err) {
  const d = err.data && err.data.details ? err.data.details : {};
  const parts = [];
  if (d.overlappingPlan) {
    parts.push(`<li>冲突计划：#${d.overlappingPlan.id}《${esc(d.overlappingPlan.title)}》（${STATUS_TEXT[d.overlappingPlan.status] || d.overlappingPlan.status}）</li>`);
  }
  if (d.outsideMeasurements && d.outsideMeasurements.length) {
    parts.push('<li>不在新开灯窗内的实测：' + d.outsideMeasurements.map((m) =>
      `#${m.id}（${esc(m.start)} ~ ${esc(m.end)}）`).join('、') + '</li>');
  }
  if (d.missingLimits && d.missingLimits.length) {
    parts.push(`<li>未登记年度额度的年份：${d.missingLimits.join('、')}</li>`);
  }
  if (d.overflows && d.overflows.length) {
    parts.push(...d.overflows.map((o) =>
      `<li>${o.year} 年超额：上限 ${fmtN(o.limit)}，当前已用 ${fmtN(o.usedBefore)}，拟改新增 ${fmtN(o.addedByThisPlan)}，合计 ${fmtN(o.projected)}，<b>超额 ${fmtN(o.excess)} lx·h</b></li>`));
  }
  return parts.length ? '<ul>' + parts.join('') + '</ul>' : '';
}

// 打开“提交调整”表单并以原值预填
function openAdjustmentForm(plan) {
  const form = $('#adjustment-form');
  form.classList.remove('hidden');
  form.planId.value = plan.id;
  form.startDate.value = plan.start_date;
  form.endDate.value = plan.end_date;
  form.estimatedLux.value = plan.estimated_lux;
  form.periods.value = (plan.light_periods || []).join('\n');
  form.note.value = '';
  $('#adjustment-form-plan').textContent = `对计划 #${plan.id}「${plan.title}」`;
  form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
$('#adjustment-form-cancel').addEventListener('click', () => {
  $('#adjustment-form').classList.add('hidden');
});

$('#adjustment-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const fd = new FormData(form);
  const planId = Number(fd.get('planId'));
  const periods = String(fd.get('periods')).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  try {
    await api('POST', `/api/plans/${planId}/adjustments`, {
      startDate: fd.get('startDate'),
      endDate: fd.get('endDate'),
      periods,
      estimatedLux: Number(fd.get('estimatedLux')),
      note: fd.get('note'),
    });
    form.reset();
    form.classList.add('hidden');
    await loadPlans();
    flash('success', `调整申请已提交（计划 #${planId}），等待保管员审核；待审期间原计划继续占用额度`);
  } catch (err) { flash('error', err.message); }
});

async function adjustmentAction(btn) {
  const id = Number(btn.dataset.id);
  const action = btn.dataset.action;
  try {
    if (action === 'new') {
      const plan = state.plans.find((p) => p.id === id)
        || (state.detail && state.detail.plans.find((p) => p.id === id));
      if (!plan) return;
      if (state.tab !== 'plans') {
        await switchTab('plans');
      }
      openAdjustmentForm(plan);
      return;
    }
    if (action === 'view-pending') {
      const { adjustment } = await api('GET', `/api/adjustments/${id}`);
      flash('success',
        `调整申请 #${adjustment.id}（计划 #${adjustment.planId}）：原值 → 拟改值`,
        `<div class="small">${adjustmentCompareCell(adjustment)}
           <div class="source-doses">${yearlyText(adjustment.proposed.estimatedYearly)}</div></div>`);
      return;
    }
    if (action === 'approve') {
      const detail = await api('POST', `/api/adjustments/${id}/approve`);
      if (state.tab === 'exhibits' && state.detail) {
        state.detail = detail;
        renderDetail();
      } else {
        await loadPlans();
      }
      flash('success', `调整申请 #${id} 已通过，计划已原子更新`);
      return;
    }
    if (action === 'reject') {
      const note = prompt('驳回原因（可留空）') || '';
      await api('POST', `/api/adjustments/${id}/reject`, { note });
    } else if (action === 'withdraw') {
      if (!confirm(`确认撤回调整申请 #${id}？撤回后可重新提交。`)) return;
      await api('POST', `/api/adjustments/${id}/withdraw`);
    }
    await refreshAfterChange();
    flash('success', '操作完成');
  } catch (err) {
    if (err.status === 409 && action === 'approve') {
      // 核对失败：申请保持待审以便撤回，指出冲突计划/实测/超额年份
      flash('error', `调整申请 #${id} 核对未通过（申请保持待审，可撤回后重提）：${err.message}`,
        adjustmentConflictHtml(err));
      await refreshAfterChange();
    } else {
      flash('error', err.message);
    }
  }
}

// “查看拆分”按钮：拉计划详情展示按年剂量
document.addEventListener('click', async (e) => {
  const btn = e.target.closest && e.target.closest('button.plan-action[data-action="view"]');
  if (!btn || state.tab !== 'plans') return;
  try {
    const { plan, estimatedYearly } = await api('GET', `/api/plans/${btn.dataset.id}`);
    flash('success',
      `计划 #${plan.id}「${plan.title}」按自然年预计剂量`,
      `<div class="source-doses">${yearlyText(estimatedYearly)}</div>`);
  } catch (err) { flash('error', err.message); }
});

// ---------- 实测 ----------
async function loadMeasurementsTab() {
  await populateExhibitSelects();
  const { measurements } = await api('GET', '/api/measurements');
  state.measurements = measurements;
  $('#meas-list').innerHTML = measurements.length
    ? `<table class="data"><thead><tr>
        <th>#</th><th>计划</th><th>开始</th><th>结束</th><th>实测照度</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>${measurements.map((m) => `
          <tr>
            <td>${m.id}</td><td>#${m.planId}</td>
            <td>${esc(m.start)}</td><td>${esc(m.end)}</td>
            <td class="mono">${fmtN(m.actualLux)} lx</td>
            <td>${badge(m.status)}</td>
            <td>${m.status === 'draft' && state.user.role === 'conservator'
              ? `<button class="primary small-btn meas-action" data-action="confirm" data-id="${m.id}">确认</button>
                 <button class="danger small-btn meas-action" data-action="delete" data-id="${m.id}">删除</button>`
              : '<span class="muted">—</span>'}</td>
          </tr>`).join('')}</tbody></table>`
    : '<p class="muted">暂无实测记录。</p>';
  $$('.meas-action').forEach((b) => b.addEventListener('click', () => measAction(b)));
}

$('#meas-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await api('POST', '/api/measurements', {
      planId: Number(fd.get('planId')),
      startDate: fd.get('startDate'),
      startTime: fd.get('startTime'),
      endDate: fd.get('endDate') || fd.get('startDate'),
      endTime: fd.get('endTime'),
      actualLux: Number(fd.get('actualLux')),
      note: fd.get('note'),
    });
    e.target.reset();
    await loadMeasurementsTab();
    flash('success', '实测已录入（待确认）');
  } catch (err) { flash('error', err.message); }
});

// ---------- 账号 ----------
async function loadUsers() {
  const { users } = await api('GET', '/api/users');
  state.users = users;
  $('#user-tbody').innerHTML = users.map((u) => `<tr>
    <td>${u.id}</td><td>${esc(u.username)}</td><td>${esc(u.display_name)}</td>
    <td>${u.role === 'conservator' ? '保管员' : '布展员'}</td>
    <td>${u.active ? '启用' : '<span style="color:#b42318">停用</span>'}</td>
    <td>
      <button class="small-btn user-action" data-action="password" data-id="${u.id}">重置密码</button>
      <button class="small-btn user-action" data-action="active" data-id="${u.id}" data-active="${!u.active}">${u.active ? '停用' : '启用'}</button>
    </td></tr>`).join('');
  $$('.user-action').forEach((b) => b.addEventListener('click', async () => {
    try {
      if (b.dataset.action === 'password') {
        const pw = prompt(`为 ${state.users.find((u) => u.id == b.dataset.id).username} 设置新密码（≥6位）`);
        if (!pw) return;
        await api('POST', `/api/users/${b.dataset.id}/reset-password`, { password: pw });
        flash('success', '密码已重置');
      } else {
        await api('POST', `/api/users/${b.dataset.id}/active`, { active: b.dataset.active === 'true' });
        await loadUsers();
      }
    } catch (err) { flash('error', err.message); }
  }));
}
$('#user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await api('POST', '/api/users', {
      username: fd.get('username').trim(),
      displayName: fd.get('displayName') || fd.get('username'),
      role: fd.get('role'),
      password: fd.get('password'),
    });
    e.target.reset();
    await loadUsers();
    flash('success', '账号已创建');
  } catch (err) { flash('error', err.message); }
});

// ---------- 操作流水 ----------
async function loadAudit() {
  const { events } = await api('GET', '/api/audit?limit=300');
  $('#audit-tbody').innerHTML = events.map((ev) => `<tr>
    <td>${ev.id}</td>
    <td class="mono">${new Date(ev.created_at).toLocaleString('zh-CN')}</td>
    <td>${esc(ev.actor_name || '系统')}</td>
    <td>${esc(ev.action)}</td>
    <td>${esc(ev.target_type)}${ev.target_id ? ' #' + ev.target_id : ''}</td>
    <td class="small">${esc(JSON.stringify(ev.detail))}</td>
  </tr>`).join('');
}

boot().catch((err) => {
  document.body.innerHTML = `<pre style="padding:20px;color:#b42318">初始化失败: ${esc(err.message)}</pre>`;
});
