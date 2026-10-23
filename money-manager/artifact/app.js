"use strict";
// お金の見える化（claude.ai 版）
// データは artifact の db、Gmail は viewer の Gmail コネクタ、AI は sample で動く。
// 集計ロジックは ../app/finance.py、メール解析は ../app/mail_parser.py の移植。

// ================================================================== utilities
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const yen = (n) => (n == null ? "-" : `${Math.round(n).toLocaleString("ja-JP")}円`);
const man = (n) => (Math.abs(n) >= 10000 ? `${(n / 10000).toLocaleString("ja-JP", { maximumFractionDigits: 1 })}万` : `${Math.round(n).toLocaleString("ja-JP")}`);
const pct = (r) => (r == null ? "-" : `${Math.round(r * 100)}%`);
const md = (s) => { const [, m, d] = s.split("-"); return `${+m}/${+d}`; };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/-/g, "").slice(0, 16);

// 日付は「1970-01-01 からの日数」の整数で扱う（タイムゾーンのずれを避ける）
const D = {
  ymd: (y, m, d) => Date.UTC(y, m - 1, d) / 864e5,
  parse: (s) => { const [y, m, d] = String(s).slice(0, 10).split("-").map(Number); return D.ymd(y, m, d); },
  fmt: (n) => new Date(n * 864e5).toISOString().slice(0, 10),
  parts: (n) => { const d = new Date(n * 864e5); return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]; },
  dim: (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(),
  clamp: (y, m, d) => D.ymd(y, m, Math.min(d, D.dim(y, m))),
  addM: (y, m, k) => { const i = y * 12 + (m - 1) + k; return [Math.floor(i / 12), (i % 12) + 1]; },
  today: () => { const t = new Date(); return D.ymd(t.getFullYear(), t.getMonth() + 1, t.getDate()); },
  weekday: (n) => (new Date(n * 864e5).getUTCDay() + 6) % 7,
  ym: (s) => String(s).slice(0, 7),
};

const KIND_LABELS = { bank: "銀行口座", cash: "現金", emoney: "電子マネー", card: "クレジットカード", securities: "証券口座", nisa: "NISA", ideco: "iDeCo", dc: "企業型DC", loan: "ローン", other: "その他資産" };
const REC_LABELS = { subscription: "サブスク", utility: "インフラ", fixed: "固定費", investment: "積立投資" };
const CYCLE_LABELS = { monthly: "毎月", quarterly: "3か月ごと", yearly: "毎年", weekly: "毎週" };
const STATUS_TEXT = { ok: "順調", warning: "ペース早め", buffer: "貯金枠を使用中", over: "予算オーバー", deficit: "赤字構造" };
const VERDICT_TEXT = { buy_ok: "今月の予算で買えます", buy_from_savings: "貯金から出せば買えます", wait: "もう少し待ちましょう" };
const LIQUID = new Set(["bank", "cash", "emoney"]), INVEST = new Set(["securities", "nisa"]), PENSION = new Set(["ideco", "dc"]), LIAB = new Set(["loan"]);

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 2800);
}

function renderMarkdown(text) {
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/(^|\s)_(\S.*?)_(?=\s|$)/g, "$1<em>$2</em>");
  const out = [];
  let list = null;
  for (const raw of String(text).split("\n")) {
    const line = raw.trimEnd();
    const li = line.match(/^\s*(?:[-*・]|\d+\.)\s+(.*)$/);
    if (li) { (list ||= []).push(`<li>${inline(li[1])}</li>`); continue; }
    if (list) { out.push(`<ul>${list.join("")}</ul>`); list = null; }
    let m;
    if ((m = line.match(/^#{1,6}\s+(.*)$/))) out.push(`<h3>${inline(m[1])}</h3>`);
    else if ((m = line.match(/^>\s?(.*)$/))) out.push(`<blockquote>${inline(m[1])}</blockquote>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push(`<ul>${list.join("")}</ul>`);
  return out.join("");
}

function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.type === "file") continue;
    if (el.type === "radio") { if (el.checked) out[el.name] = el.value; continue; }
    if (el.type === "checkbox") { out[el.name] = el.checked; continue; }
    const v = el.value.trim();
    if (el.type === "number" || (el.tagName === "SELECT" && el.name === "priority")) out[el.name] = v === "" ? null : Number(v);
    else out[el.name] = v === "" && el.type === "date" ? null : v;
  }
  return out;
}

// 各フォームの hidden の「id」欄（編集中の項目）
const idField = (form) => form.elements.namedItem("id");

function fillForm(form, data) {
  form.reset();
  for (const el of form.elements) {
    if (!el.name || !(el.name in data)) continue;
    const v = data[el.name];
    if (el.type === "checkbox") el.checked = !!v;
    else if (el.type === "radio") el.checked = el.value === v;
    else el.value = v ?? "";
  }
  form.dispatchEvent(new Event("change"));
  const dlg = form.closest("dialog");
  if (dlg) { if (!dlg.open) dlg.showModal(); } else form.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ================================================================== store
// app/<name> は 1 文書ずつ（{items:[...]} など）、明細は月ごとに tx/<YYYY-MM>
const DEFAULT_SETTINGS = { reimburse_keywords: "定期,テイキ", monthly_income: 0, cycle_start_day: 1, savings_goal: 0, category_budgets: {}, emergency_fund_months: 6,
  gmail_auto: true, gmail_interval_min: 60, gmail_lookback_days: 45, receipts_enabled: true, receipt_account_id: "" };
const APP_DOCS = { settings: () => ({ ...DEFAULT_SETTINGS }), accounts: () => ({ items: [] }), recurring: () => ({ items: [] }),
  wishlist: () => ({ items: [] }), bills: () => ({ items: [] }), mail: () => ({ seen: [], log: [], lastSync: null }), advice: () => ({ log: [] }) };
const S = { tx: {}, loaded: new Set(), db: null };
for (const [k, f] of Object.entries(APP_DOCS)) S[k] = f();

const settings = () => ({ ...DEFAULT_SETTINGS, ...S.settings });
const accounts = () => S.accounts.items.filter((a) => !a.archived);
const recurring = () => S.recurring.items;
const allTx = () => Object.values(S.tx).flat();

const writing = {};
async function save(name) {
  // 1 文書につき同時に 1 書き込み。書き込み中に変わったら終わってからもう一度書く
  if (!S.db) { render(); return; }
  if (writing[name]) { writing[name].dirty = true; return; }
  writing[name] = { dirty: false };
  try {
    do {
      writing[name].dirty = false;
      const body = name.startsWith("tx/") ? { items: S.tx[name.slice(3)] || [] } : S[name];
      await S.db.doc(name.startsWith("tx/") ? name : "app/" + name).set(JSON.parse(JSON.stringify(body)));
    } while (writing[name].dirty);
  } catch (e) {
    toast(e.code === "quota_exceeded" ? "保存容量がいっぱいです。古い明細を削除してください" : `保存できませんでした（${e.code || e.message}）`);
  } finally {
    delete writing[name];
  }
}

function monthsAround(today, back) {
  const [y, m] = D.parts(today);
  const out = [];
  for (let k = -back; k <= 1; k++) { const [yy, mm] = D.addM(y, m, k); out.push(`${yy}-${String(mm).padStart(2, "0")}`); }
  return out;
}

async function ensureMonths(yms) {
  if (!S.db) return;
  await Promise.all([...new Set(yms)].filter((ym) => !S.loaded.has(ym)).map(async (ym) => {
    const snap = await S.db.doc("tx/" + ym).get();
    S.tx[ym] = snap.exists ? [...(snap.data().items || [])] : [];
    S.loaded.add(ym);
  }));
}

function addTx(tx) {
  const ym = D.ym(tx.date);
  (S.tx[ym] ||= []).push({ id: uid(), ...tx });
  S.loaded.add(ym);
  return ym;
}

function findTx(id) {
  for (const [ym, items] of Object.entries(S.tx)) { const i = items.findIndex((t) => t.id === id); if (i >= 0) return [ym, i]; }
  return [null, -1];
}

// ================================================================== finance（finance.py の移植）
function periodBounds(today, startDay = 1) {
  const sd = Math.max(1, Math.min(Number(startDay) || 1, 31));
  const [y, m] = D.parts(today);
  const thisStart = D.clamp(y, m, sd);
  const start = today >= thisStart ? thisStart : D.clamp(...D.addM(y, m, -1), sd);
  const [sy, sm] = D.parts(start);
  return [start, D.clamp(...D.addM(sy, sm, 1), sd)];
}

function previousPeriods(today, sd, n) {
  const out = [];
  let [start] = periodBounds(today, sd);
  for (let i = 0; i < n; i++) { const p = periodBounds(start - 1, sd); out.push(p); start = p[0]; }
  return out;
}

const monthlyEq = (r) => { const a = Number(r.amount) || 0; return r.cycle === "yearly" ? Math.round(a / 12) : r.cycle === "quarterly" ? Math.round(a / 3) : r.cycle === "weekly" ? Math.round((a * 52) / 12) : a; };

function occurrences(r, start, end) {
  const day = Number(r.billing_day) || 1;
  const out = [];
  if (r.cycle === "weekly") {
    for (let d = start + ((((day % 7) - D.weekday(start)) % 7) + 7) % 7; d < end; d += 7) out.push(d);
    return out;
  }
  let [y, m] = D.parts(start);
  while (D.ymd(y, m, 1) < end) {
    const bm = Number(r.billing_month) || 1;
    const hit = r.cycle === "yearly" ? bm === m : r.cycle === "quarterly" ? (((m - bm) % 3) + 3) % 3 === 0 : true;
    if (hit) { const d = D.clamp(y, m, day); if (d >= start && d < end) out.push(d); }
    [y, m] = D.addM(y, m, 1);
  }
  return out;
}

function recurringSummary(rec, today) {
  const active = rec.filter((r) => r.active !== false);
  const byKind = {};
  const upcoming = [];
  for (const r of active) {
    byKind[r.kind] = (byKind[r.kind] || 0) + monthlyEq(r);
    for (const d of occurrences(r, today, today + 31)) upcoming.push({ date: D.fmt(d), name: r.name, amount: Number(r.amount), kind: r.kind, variable: !!r.variable, account_id: r.account_id });
  }
  upcoming.sort((a, b) => a.date.localeCompare(b.date));
  const subs = active.filter((r) => r.kind === "subscription");
  const total = Object.values(byKind).reduce((s, v) => s + v, 0);
  const subMonthly = subs.reduce((s, r) => s + monthlyEq(r), 0);
  return { monthly_by_kind: byKind, monthly_total: total, monthly_spending: total - (byKind.investment || 0), monthly_investment: byKind.investment || 0,
    subscription_count: subs.length, subscription_monthly: subMonthly, subscription_yearly: subMonthly * 12, upcoming };
}

const inRange = (s, a, b) => { const d = D.parse(s); return a <= d && d < b; };
// 立て替えた明細は自分の負担額だけを支出に数える（カードの請求額との照合は元の金額のまま）
// 会社が精算してくれる支払い（通勤定期など）は、店名が設定のキーワードに合えば自動で自分の負担 0 円にする
function isCompanyPaid(t) {
  if (t.type !== "expense" || t.own_share != null) return false;
  const k = kanaKey(t.description);
  return String(settings().reimburse_keywords || "").split(/[,、]/).map((x) => kanaKey(x.trim())).some((x) => x && k.includes(x));
}
const mine = (t) => (t.own_share != null && t.own_share >= 0 && t.own_share < t.amount ? t.own_share : isCompanyPaid(t) ? 0 : t.amount);
// PayPay・楽天キャッシュで受け取った立替の精算は、その分を支出から差し引く（自分の分を毎回計算しなくてよい）。
// 「自分の分」を入力済みの明細の精算（settles にその明細の id）は二重に引かない
const isSettle = (t) => t.type === "transfer" && t.category === "立替の精算" && !t.settles;
const settledIn = (txs, a, b, day) => txs.filter((t) => isSettle(t) && inRange(t.date, a, b) && (day == null || D.parse(t.date) === day)).reduce((s, t) => s + t.amount, 0);
const variableSpending = (txs, a, b) => txs.filter((t) => t.type === "expense" && !t.recurring_id && inRange(t.date, a, b)).reduce((s, t) => s + mine(t), 0) - settledIn(txs, a, b);

function budgetSummary(st, rec, txs, today) {
  const [start, end] = periodBounds(today, st.cycle_start_day);
  const totalDays = end - start, elapsed = today - start + 1, daysLeft = totalDays - elapsed + 1;
  const rs = recurringSummary(rec, today);
  const planned = Number(st.monthly_income) || 0;
  const actualIncome = txs.filter((t) => t.type === "income" && inRange(t.date, start, end)).reduce((s, t) => s + t.amount, 0);
  const income = planned || actualIncome;
  const savingsGoal = Number(st.savings_goal) || 0;
  const variableBudget = income - rs.monthly_spending - rs.monthly_investment - savingsGoal;
  const expenses = txs.filter((t) => t.type === "expense" && inRange(t.date, start, end));
  const reimbursed = settledIn(txs, start, end);
  const spent = expenses.filter((t) => !t.recurring_id).reduce((s, t) => s + mine(t), 0) - reimbursed;
  const todaySpent = expenses.filter((t) => !t.recurring_id && D.parse(t.date) === today).reduce((s, t) => s + mine(t), 0) - settledIn(txs, start, end, today);
  const remaining = variableBudget - spent;
  // 先取り貯金を「いざというときの予備」として使えるお金に含める設定。予算を超えたら貯金枠から減っていく
  const buffer = st.savings_flex ? savingsGoal : 0;
  const remainingAll = remaining + buffer;
  const base = remaining > 0 || !buffer ? remaining : remainingAll;
  const daily = daysLeft > 0 ? Math.floor((base + todaySpent) / daysLeft) : base;
  const expected = totalDays ? (variableBudget * elapsed) / totalDays : 0;
  const pace = expected > 0 ? spent / expected : null;
  const projected = elapsed > 0 ? Math.round((spent / elapsed) * totalDays) : spent;
  const status = variableBudget <= 0 && income > 0 ? "deficit" : remainingAll < 0 ? "over" : remaining < 0 ? "buffer" : pace != null && pace > 1.05 ? "warning" : "ok";
  const byCat = {};
  for (const t of expenses) if (!t.recurring_id) byCat[t.category || "未分類"] = (byCat[t.category || "未分類"] || 0) + mine(t);
  const budgets = st.category_budgets || {};
  const categories = [...new Set([...Object.keys(byCat), ...Object.keys(budgets)])].sort((a, b) => (byCat[b] || 0) - (byCat[a] || 0)).map((cat) => {
    const b = Number(budgets[cat]) || 0, s = byCat[cat] || 0;
    return { category: cat, spent: s, budget: b || null, remaining: b ? b - s : null, ratio: b ? s / b : null, pace_ratio: b ? s / ((b * elapsed) / totalDays) : null };
  });
  const history = previousPeriods(today, st.cycle_start_day, 3).map(([a, b]) => ({ start: D.fmt(a), end: D.fmt(b), variable_spent: variableSpending(txs, a, b) }));
  const withData = history.map((h) => h.variable_spent).filter((v) => v > 0);
  const avg = withData.length ? Math.round(withData.reduce((s, v) => s + v, 0) / withData.length) : null;
  return { period: { start: D.fmt(start), end: D.fmt(end - 1), total_days: totalDays, elapsed_days: elapsed, days_left: daysLeft },
    income, planned_income: planned, actual_income: actualIncome, fixed_monthly: rs.monthly_spending, investment_monthly: rs.monthly_investment,
    savings_goal: savingsGoal, variable_budget: variableBudget, buffer, remaining_all: remainingAll, buffer_left: Math.max(0, Math.min(buffer, remainingAll)), spent, reimbursed, today_spent: todaySpent, remaining, daily_allowance: daily,
    today_remaining: daily - todaySpent, expected_by_now: Math.round(expected), pace_ratio: pace, projected_spent: projected,
    projected_surplus: variableBudget - projected, status, categories, history, avg_variable_spent: avg, recurring: rs };
}

function cardCycles(today, closingDay) {
  const [y, m] = D.parts(today);
  const closeThis = D.clamp(y, m, closingDay);
  const curEnd = today <= closeThis ? closeThis : D.clamp(...D.addM(y, m, 1), closingDay);
  const [cy, cm] = D.parts(curEnd);
  const prevEnd = D.clamp(...D.addM(cy, cm, -1), closingDay);
  const [py, pm] = D.parts(prevEnd);
  const prevPrevEnd = D.clamp(...D.addM(py, pm, -1), closingDay);
  return { current: [prevEnd + 1, curEnd], last: [prevPrevEnd + 1, prevEnd] };
}
const paymentDate = (cycleEnd, payDay) => { const [y, m] = D.parts(cycleEnd); return D.clamp(...D.addM(y, m, 1), payDay); };

function cardStatus(card, txs, today, bills) {
  const closing = Number(card.closing_day) || 31, payDay = Number(card.payment_day) || 27;
  const c = cardCycles(today, closing);
  const mine = txs.filter((t) => t.account_id === card.id && t.type === "expense");
  const total = ([a, b]) => mine.filter((t) => { const d = D.parse(t.date); return a <= d && d <= b; }).reduce((s, t) => s + t.amount, 0);
  const current = total(c.current), closed = total(c.last);
  const closedPay = paymentDate(c.last[1], payDay), currentPay = paymentDate(c.current[1], payDay);
  // 支払日が土日祝でずれるので、直近の締め分の支払日 ±7 日の請求を同じ請求とみなす
  const bill = [...bills].sort((a, b) => a.payment_date.localeCompare(b.payment_date))
    .find((b) => D.parse(b.payment_date) >= today && Math.abs(D.parse(b.payment_date) - closedPay) <= 7);
  let next, unpaid;
  if (bill) { next = { date: bill.payment_date, amount: bill.amount, confirmed: bill.confirmed !== false, source: "email", tracked_amount: closed }; unpaid = bill.amount + current; }
  else if (closedPay >= today) { next = { date: D.fmt(closedPay), amount: closed, confirmed: true, source: "estimate" }; unpaid = closed + current; }
  else { next = { date: D.fmt(currentPay), amount: current, confirmed: false, source: "estimate" }; unpaid = current; }
  const limit = card.card_limit || null;
  return { id: card.id, name: card.name, institution: card.institution || "", closing_day: closing, payment_day: payDay,
    current_cycle: { start: D.fmt(c.current[0]), end: D.fmt(c.current[1]), amount: current }, next_payment: next, unpaid_total: unpaid,
    limit, limit_usage: limit ? unpaid / limit : null, payment_account_id: card.payment_account_id || null };
}

function netWorth(accs, cards) {
  const g = { liquid: 0, invest: 0, pension: 0, other: 0, liability: 0 };
  const investments = [];
  for (const a of accs) {
    if (a.kind === "card") continue;
    const bal = Number(a.balance) || 0;
    const key = LIQUID.has(a.kind) ? "liquid" : INVEST.has(a.kind) ? "invest" : PENSION.has(a.kind) ? "pension" : LIAB.has(a.kind) ? "liability" : "other";
    g[key] += bal;
    if (INVEST.has(a.kind) || PENSION.has(a.kind)) {
      const c = a.contributed ?? null;
      investments.push({ id: a.id, name: a.name, kind: a.kind, balance: bal, contributed: c, gain: c != null ? bal - c : null, gain_ratio: c ? (bal - c) / c : null, locked: PENSION.has(a.kind) });
    }
  }
  const cardDebt = cards.reduce((s, c) => s + c.unpaid_total, 0);
  g.liability += cardDebt;
  const assets = g.liquid + g.invest + g.pension + g.other;
  return { ...g, card_unpaid: cardDebt, total_assets: assets, net_worth: assets - g.liability, spendable: g.liquid - cardDebt, investments };
}

function paymentShortfalls(accs, cards, rec, today) {
  const byId = Object.fromEntries(accs.map((a) => [a.id, a]));
  const due = {};
  for (const c of cards) if (c.payment_account_id && D.parse(c.next_payment.date) <= today + 31) due[c.payment_account_id] = (due[c.payment_account_id] || 0) + c.next_payment.amount;
  for (const r of rec) {
    if (r.active === false || !r.account_id || byId[r.account_id]?.kind === "card") continue;
    due[r.account_id] = (due[r.account_id] || 0) + occurrences(r, today, today + 31).length * Number(r.amount);
  }
  return Object.entries(due).filter(([id]) => byId[id]).map(([id, amount]) => {
    const bal = Number(byId[id].balance) || 0;
    return { account_id: id, account: byId[id].name, balance: bal, due_amount: amount, shortfall: Math.max(0, amount - bal) };
  }).sort((a, b) => b.shortfall - a.shortfall);
}

function emergencyFund(worth, b, months) {
  const living = b.fixed_monthly + (b.avg_variable_spent || b.variable_budget || 0);
  return { monthly_living: living, months_covered: living > 0 ? worth.spendable / living : null, target_months: months, target_amount: living * (Number(months) || 0) };
}

function wishlistAnalysis(items, b, worth, months) {
  const ef = emergencyFund(worth, b, months);
  const typical = b.avg_variable_spent != null ? b.avg_variable_spent : b.projected_spent;
  const surplus = b.income - b.fixed_monthly - b.investment_monthly - typical;
  return items.filter((it) => (it.status || "want") === "want").map((it) => {
    const need = Math.max(0, Number(it.price) - (Number(it.saved) || 0));
    const months2 = need === 0 ? 0 : surplus > 0 ? Math.ceil(need / surplus) : null;
    const fits = need <= Math.max(0, b.remaining);
    const keeps = worth.spendable - need >= ef.target_amount;
    const verdict = need === 0 || fits ? "buy_ok" : keeps ? "buy_from_savings" : "wait";
    return { ...it, need, months_to_save: months2, fits_this_month: fits, keeps_emergency_fund: keeps, verdict };
  }).sort((a, b2) => (a.priority || 2) - (b2.priority || 2) || a.need - b2.need);
}

function netWorthHistory(accs) {
  const points = {};
  const latest = {};
  const snaps = [];
  for (const a of accs) if (a.kind !== "card") for (const h of a.history || []) snaps.push({ ...h, kind: a.kind, id: a.id });
  snaps.sort((a, b) => a.date.localeCompare(b.date));
  const months = [...new Set(snaps.map((s) => D.ym(s.date)))].sort();
  let i = 0;
  for (const ym of months) {
    while (i < snaps.length && D.ym(snaps[i].date) <= ym) { latest[snaps[i].id] = snaps[i]; i++; }
    const p = { month: ym, liquid: 0, invest: 0, pension: 0, other: 0, liability: 0 };
    for (const s of Object.values(latest)) {
      const k = LIQUID.has(s.kind) ? "liquid" : INVEST.has(s.kind) ? "invest" : PENSION.has(s.kind) ? "pension" : LIAB.has(s.kind) ? "liability" : "other";
      p[k] += Number(s.balance) || 0;
    }
    p.net_worth = p.liquid + p.invest + p.pension + p.other - p.liability;
    points[ym] = p;
  }
  return Object.values(points).slice(-24);
}

function dashboard() {
  const today = D.today();
  const st = settings(), accs = accounts(), rec = recurring(), txs = allTx();
  const budget = budgetSummary(st, rec, txs, today);
  const cards = accs.filter((a) => a.kind === "card").map((a) => cardStatus(a, txs, today, S.bills.items.filter((b) => b.account_id === a.id)));
  const worth = netWorth(accs, cards);
  return { today: D.fmt(today), settings: st, budget, cards, net_worth: worth, history: netWorthHistory(accs),
    payment_checks: paymentShortfalls(accs, cards, rec, today), wishlist: wishlistAnalysis(S.wishlist.items, budget, worth, st.emergency_fund_months),
    emergency_fund: emergencyFund(worth, budget, st.emergency_fund_months), accounts: accs, recurring: rec };
}

// ================================================================== CSV（csv_import.py の移植）
const CATEGORY_RULES = [
  ["食費", ["スーパー", "イオン", "西友", "マルエツ", "業務スーパー", "成城石井", "まいばすけっと", "マイバスケット", "生協", "コープ", "オオゼキ", "サミット", "ライフコーポ", "ライフ "]],
  ["コンビニ", ["セブン", "ローソン", "ファミリーマート", "ファミマ", "ミニストップ", "デイリーヤマザキ", "ニューデイズ"]],
  ["外食", ["マクドナルド", "スターバックス", "スタバ", "すき家", "吉野家", "松屋", "ガスト", "サイゼリヤ", "UBER EATS", "UBEREATS", "出前館", "レストラン", "カフェ", "居酒屋", "ドトール", "タリーズ", "コメダ", "ラーメン", "ケンタッキー", "モスバーガー", "日高屋", "珈琲", "コーヒー", "オリジン", "プロント"]],
  ["日用品", ["マツモトキヨシ", "マツキヨ", "トモズ", "ウエルシア", "ツルハ", "スギ薬局", "ダイソー", "無印", "ニトリ", "ドラッグ", "カインズ", "ランドリー", "クリーニング"]],
  ["交通", ["JR", "モバイルSUICA", "SUICA", "PASMO", "パスモ", "スイカ", "メトロ", "タクシー", "鉄道", "バス", "HIGHWAYBUS", "ETC", "高速", "えきねっと"]],
  ["ネットショッピング", ["AMAZON", "アマゾン", "楽天市場", "ヤフーショッピング", "ZOZO", "メルカリ"]],
  ["サブスク", ["NETFLIX", "SPOTIFY", "APPLE.COM", "APPLE COM", "ITUNES", "GOOGLE", "YOUTUBE", "AMAZON PRIME", "プライム", "DISNEY", "U-NEXT", "ADOBE", "CHATGPT", "OPENAI", "ANTHROPIC", "CLAUDE", "オンデマンド", "スカパー"]],
  ["通信", ["DOCOMO", "ドコモ", "ソフトバンク", "SOFTBANK", "楽天モバイル", "AHAMO", "POVO", "LINEMO", "UQ", "NURO"]],
  ["水道・光熱", ["電力", "でんき", "電気", "ガス", "水道", "スイドウ", "ENEOS", "TEPCO", "東京電力", "関西電力"]],
  ["医療", ["病院", "クリニック", "医院", "歯科", "薬局"]],
  ["趣味・娯楽", ["映画", "TOHO", "トウホウシネマ", "シネマ", "テアトル", "劇場", "ゲキジョウ", "チケット", "書店", "ショテン", "紀伊國屋", "STEAM", "NINTENDO", "任天堂", "PLAYSTATION", "ゲーム", "カラオケ", "美術館"]],
  ["衣服・美容", ["ユニクロ", "UNIQLO", "ジーユー", "ZARA", "H&M", "洋服の青山", "美容", "ヘア", "サロン"]],
];
const EXTRA_CATEGORIES = ["旅行", "住居", "保険", "教育", "交際費", "特別な支出", "その他"];
const ALL_CATEGORIES = () => [...CATEGORY_RULES.map(([c]) => c), ...EXTRA_CATEGORIES];

// カード明細の店名は半角カナで、小さい「ッ」「ァ」なども大きい字になっている（ﾌｱﾐﾘｰﾏｰﾄ）。
// 照合はこのキーどうしで行う: 全角化・大文字・小書き文字を大きく・長音やハイフン・空白を除く
const SMALL_KANA = { ァ: "ア", ィ: "イ", ゥ: "ウ", ェ: "エ", ォ: "オ", ッ: "ツ", ャ: "ヤ", ュ: "ユ", ョ: "ヨ", ヮ: "ワ", ヵ: "カ", ヶ: "ケ" };
function kanaKey(s) {
  return String(s || "").normalize("NFKC").toUpperCase()
    .replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60))
    .replace(/[ァィゥェォッャュョヮヵヶ]/g, (c) => SMALL_KANA[c])
    .replace(/[\sー－‐\-・.。、,]/g, "");
}

function guessCategory(desc) {
  const t = kanaKey(desc);
  // 短い言葉（ジーユー→ジユ など）は「シンジユク」に紛れるので先頭一致だけにする
  for (const [cat, words] of CATEGORY_RULES) if (words.some((w) => { const k = kanaKey(w); return k && (k.length <= 3 && /^[ァ-ヶA-Z0-9]+$/.test(k) ? t.startsWith(k) : t.includes(k)); })) return cat;
  return "未分類";
}

function decodeBytes(buf) {
  for (const enc of ["utf-8", "shift_jis", "euc-jp"]) {
    try { return new TextDecoder(enc, { fatal: true }).decode(buf).replace(/^﻿/, ""); } catch {}
  }
  return new TextDecoder("utf-8").decode(buf);
}

function csvRows(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const DATE_COLS = ["利用日", "ご利用日", "利用年月日", "ご利用年月日", "取引日", "日付", "年月日", "date"];
const AMOUNT_COLS = ["利用金額", "ご利用金額", "金額（円）", "金額(円)", "金額", "支払金額", "支払総額", "請求金額", "amount"];
const DESC_COLS = ["利用店名", "ご利用店名", "利用店名・商品名", "ご利用先", "利用先", "内容", "摘要", "取引内容", "店名", "description"];
const WITHDRAW_COLS = ["出金", "出金額", "お引出し", "支払い金額", "引出額"];
const DEPOSIT_COLS = ["入金", "入金額", "お預入れ", "預入額"];
const CATEGORY_COLS = ["大項目", "カテゴリ", "category"];
const norm = (s) => String(s || "").trim().replace(/^"|"$/g, "").replace(/\s+/g, "").toLowerCase();
function findCol(header, cands) {
  const h = header.map(norm);
  for (const c of cands) { const i = h.indexOf(norm(c)); if (i >= 0) return i; }
  for (const c of cands) { const i = h.findIndex((x) => x.includes(norm(c))); if (i >= 0) return i; }
  return null;
}
function parseAmount(v) {
  const s = String(v || "").trim().replace(/[,円¥￥]/g, "").replace(/[−▲△]/g, "-");
  if (!s || s === "-") return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n) : null;
}
function parseDateStr(v) {
  const s = String(v || "").trim();
  let m = s.match(/^(\d{4})[/\-.年](\d{1,2})[/\-.月](\d{1,2})/);
  let y, mo, d;
  if (m) [, y, mo, d] = m.map(Number);
  else if ((m = s.match(/^(\d{2})[/\-.](\d{1,2})[/\-.](\d{1,2})/))) { [, y, mo, d] = m.map(Number); y += 2000; }
  else if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) [, y, mo, d] = m.map(Number);
  else return null;
  if (mo < 1 || mo > 12 || d < 1 || d > D.dim(y, mo)) return null;
  return D.fmt(D.ymd(y, mo, d));
}
// 楽天カードの明細は「ＪＣＢ国内利用　QP  ﾌｱﾐﾘｰﾏｰﾄ」のように決済手段が前に付くことがある
const PAY_PREFIX = /^(?:ＪＣＢ|JCB|マスター|ＶＩＳＡ|VISA|ビザ|ＡＭＥＸ|AMEX|アメックス)(?:国内|海外)利用[\s\u3000]*(?:QP|ＱＰ|MZZ|ＭＺＺ|iD|ｉＤ|ＩＤ)?[\s\u3000]*/;
function cleanShop(desc) { return String(desc || "").replace(PAY_PREFIX, "").trim(); }

function csvItem(date, signed, desc, cat) {
  desc = cleanShop(desc);
  const type = signed >= 0 ? "expense" : "income";
  let category = cat && cat !== "未分類" ? cat : guessCategory(desc);
  if (type === "income" && category === "未分類") category = "収入・返金";
  return { date, amount: Math.abs(signed), type, description: desc, category };
}
// PayPay アプリの取引履歴 CSV。支払いと送金は支出、受け取りとチャージは振替（予算に数えない）、ポイントの増減は対象外
// 「株式会社　リブラス - 本マグロ専門店　まぐろ壱」は店舗名、「Darts UP - 新宿東口」はブランド＋店舗にする
const payee = (p) => { const [a, ...b] = p.split(" - "); return !b.length ? p : /株式会社|有限会社|合同会社|（株）|\(株\)/.test(a) ? b.join(" - ") : `${a} ${b.join(" ")}`; };
function parsePayPay(rows, hi) {
  const h = rows[hi].map(norm), col = (name) => h.indexOf(name);
  const iD = col("取引日"), iO = h.findIndex((x) => x.startsWith("出金金額")), iI = h.findIndex((x) => x.startsWith("入金金額"));
  const iK = col("取引内容"), iP = col("取引先"), iM = col("取引方法");
  const out = [];
  for (const r of rows.slice(hi + 1)) {
    const d = parseDateStr(String(r[iD] || "").split(" ")[0]);
    const kind = (r[iK] || "").trim(), party = (r[iP] || "").trim(), via = (r[iM] || "").trim();
    if (!d || via.includes("ポイント") || kind.includes("ポイント")) continue;
    const w = parseAmount(r[iO]), dep = parseAmount(r[iI]);
    if (kind === "支払い" && w) out.push(csvItem(d, w, payee(party), null));
    else if (kind === "送った金額" && w) out.push({ date: d, amount: w, type: "expense", description: `PayPay送金: ${party}`, category: "交際費" });
    else if (kind === "受け取った金額" && dep) out.push({ date: d, amount: dep, type: "transfer", description: `PayPay受取: ${party}`, category: "立替の精算" });
    else if (kind === "チャージ" && dep) out.push({ date: d, amount: dep, type: "transfer", description: `チャージ（${via.replace(/\s*\*+\d*$/, "")}）`, category: "チャージ" });
    else if (kind.includes("返金") && dep) out.push(csvItem(d, -dep, party, null));
  }
  out.format = "paypay";
  return out;
}
function parseCsv(buf) {
  const rows = csvRows(decodeBytes(buf));
  const pp = rows.slice(0, 5).findIndex((r) => r.map(norm).includes("取引内容") && r.map(norm).includes("取引方法"));
  if (pp >= 0) return parsePayPay(rows, pp);
  let hi = rows.slice(0, 30).findIndex((r) => findCol(r, DATE_COLS) != null && (findCol(r, AMOUNT_COLS) != null || findCol(r, WITHDRAW_COLS) != null));
  const out = [];
  if (hi < 0) {
    for (const r of rows) {
      if (r.length < 3) continue;
      const d = parseDateStr(r[0]);
      const amt = r.slice(2).map(parseAmount).find((x) => x != null);
      if (d && amt != null) out.push(csvItem(d, amt, r[1].trim(), null));
    }
    return out;
  }
  const h = rows[hi];
  const iD = findCol(h, DATE_COLS), iA = findCol(h, AMOUNT_COLS), iT = findCol(h, DESC_COLS), iO = findCol(h, WITHDRAW_COLS), iI = findCol(h, DEPOSIT_COLS), iC = findCol(h, CATEGORY_COLS);
  const mf = iA != null && ["金額（円）", "金額(円)"].includes(norm(h[iA]));
  for (const r of rows.slice(hi + 1)) {
    const d = parseDateStr(r[iD]);
    if (!d) continue;
    const desc = iT != null ? (r[iT] || "").trim() : "";
    const cat = iC != null ? (r[iC] || "").trim() : null;
    if (iO != null || iI != null) {
      const w = iO != null ? parseAmount(r[iO]) : null, dep = iI != null ? parseAmount(r[iI]) : null;
      if (w) out.push(csvItem(d, w, desc, cat)); else if (dep) out.push(csvItem(d, -dep, desc, cat));
      continue;
    }
    let amt = iA != null ? parseAmount(r[iA]) : null;
    if (!amt) continue;
    if (mf) amt = -amt; // マネーフォワードは支出がマイナス
    out.push(csvItem(d, amt, desc, cat));
  }
  return out;
}

// ================================================================== メール解析（mail_parser.py の移植）
const ISSUERS = { "rakuten-card.co.jp": "楽天カード", "vpass.ne.jp": "三井住友カード", "smbc-card.com": "三井住友カード", "jcb.co.jp": "JCB",
  "paypay-card.co.jp": "PayPayカード", "eposcard.co.jp": "エポスカード", "aeon.co.jp": "イオンカード", "saisoncard.co.jp": "セゾンカード",
  "aexp.com": "アメリカン・エキスプレス", "americanexpress.jp": "アメリカン・エキスプレス", "cr.mufg.jp": "三菱UFJカード",
  "dcard.docomo.ne.jp": "dカード", "kddi-fs.com": "au PAY カード", "lifecard.co.jp": "ライフカード", "orico.co.jp": "オリコカード", "viewcard.co.jp": "ビューカード" };
const L = {
  date: "(?:ご?利用日時?|ご?利用年月日|お取引日時?|取引日時?|決済日時?|承認日時?)",
  merchant: "(?:ご?利用先|ご?利用店名?|ご?利用場所|ご?利用加盟店|加盟店名?|店舗名|ご?利用内容|お支払先|支払先)",
  amount: "(?:ご?利用金額|お?取引金額|決済金額|お支払い?金額|ご?請求金額|承認金額)",
  billAmount: "(?:合計)?(?:ご?請求(?:予定)?金額|お?支払い?(?:予定)?金額|お引落し?金額|引落金額|ご請求額|お支払額)",
  billDate: "(?:お?支払い?日|お引落し?日|口座振替日|引落日|お支払予定日)",
};
const SEP = "[\\s:：】\\]）)]*";
const HEAD = "^[ \\t◇◆■□●○・*＊【\\[]*";
const NOTIFY_SUBJECT = /(利用|ご利用|決済|承認|速報)/;
const BILL_SUBJECT = /(ご?請求(予定)?(金額|額)|お支払い?(予定)?金額|お引落し?金額).*(案内|お知らせ|確定)/;
const CANCEL = /(取消|取り消し|キャンセル|返品|売上取消)/;
const IGNORE_SUBJECT = /(キャンペーン|ポイント|キャッシュバック|お得|おトク|特典|プレゼント|エントリー|ご案内します|不正|ご利用確認|ご注意|会員ステージ|メンテナンス|サービス終了)/;

function issuerFor(sender) {
  const m = String(sender || "").match(/<([^>]+)>/);
  const domain = (m ? m[1] : String(sender || "")).toLowerCase().split("@").pop().trim();
  for (const [d, name] of Object.entries(ISSUERS)) if (domain === d || domain.endsWith("." + d)) return name;
  return null;
}
function* labelHits(text, labels) { const re = new RegExp(HEAD + labels + SEP, "gm"); let m; while ((m = re.exec(text))) { yield m.index + m[0].length; if (m[0].length === 0) re.lastIndex++; } }
function amountAt(s) { const m = s.match(/^\s*[-−]?\s*[¥\\]?\s*([0-9][0-9,]*)\s*円/) || s.match(/^\s*[¥\\]\s*([0-9][0-9,]*)/); return m ? Number(m[1].replace(/,/g, "")) : null; }
function dateAt(s) { const m = s.match(/(\d{4})\s*[/\-.年]\s*(\d{1,2})\s*[/\-.月]\s*(\d{1,2})/); if (!m) return null; const [y, mo, d] = m.slice(1).map(Number); return mo >= 1 && mo <= 12 && d >= 1 && d <= D.dim(y, mo) ? D.fmt(D.ymd(y, mo, d)) : null; }
function findAmount(text, labels) { for (const i of labelHits(text, labels)) { const a = amountAt(text.slice(i, i + 30)); if (a != null) return a; } return null; }
function findDate(text, labels) { for (const i of labelHits(text, labels)) { const d = dateAt(text.slice(i, i + 30)); if (d) return d; } return null; }
// 「ご利用店舗名やお支払方法などの…ご確認ください。」のような説明文は値として拾わない
function findLine(text, labels) { for (const i of labelHits(text, labels)) { const v = text.slice(i).match(/^[^\n\t]+/); const s = v && v[0].replace(/^[\s:：]+|[\s:：]+$/g, ""); if (s && !/[。]/.test(s) && !/^(?:舗|や|など|は|を|に|の)/.test(s)) return s.slice(0, 80); } return ""; }
function cardLabel(text) {
  const m = text.match(/(?:\[?ご利用カード\]?|カード名称?)[\s:：】\]]*([^\n]+)/);
  if (m) return m[1].trim();
  // 楽天カードの速報版は「楽天カード（Mastercard）をご利用いただき…」の書き出しにカード名がある
  const n = text.match(/([^\n「」]{0,20}カード\s*\([^)\n]{2,30}\))\s*をご利用/);
  return n ? n[1].trim() : "";
}

function parseMail(sender, subject, body, receivedDate) {
  const issuer = issuerFor(sender);
  subject = String(subject || "").normalize("NFKC");
  const text = String(body || "").normalize("NFKC").replace(/\r\n?/g, "\n");
  if (!issuer) return { kind: "ignored", reason: "カード会社のメールではありません" };
  if (BILL_SUBJECT.test(subject) || /ご請求金額のご案内|お支払い?(予定)?金額のご案内/.test(text.slice(0, 300))) {
    const amount = findAmount(text, L.billAmount), pay = findDate(text, L.billDate);
    if (amount != null && pay) {
      const head = text.slice(0, 2000);
      return { kind: "bill", issuer, card_label: cardLabel(text), amount, payment_date: pay, confirmed: !/(予定|暫定|速報)/.test(head) || head.includes("確定") };
    }
    return { kind: "ignored", issuer, reason: "請求額のメールですが金額か支払い日が読めません" };
  }
  if (IGNORE_SUBJECT.test(subject) || !NOTIFY_SUBJECT.test(subject)) return { kind: "ignored", issuer, reason: "利用通知ではありません" };
  const amount = findAmount(text, L.amount);
  if (amount == null) return { kind: "ignored", issuer, reason: "利用金額が見つかりません" };
  const date = findDate(text, L.date) || receivedDate;
  if (!date) return { kind: "ignored", issuer, reason: "利用日が見つかりません" };
  const merchant = findLine(text, L.merchant), refund = CANCEL.test(subject);
  // 1 通に複数の利用が並ぶことがある（楽天カードの速報版など）。利用日の行ごとに区切って全部読む
  const starts = [...labelHits(text, L.date)].map((i) => text.lastIndexOf("\n", i) + 1);
  const items = starts.length > 1 ? starts.map((st, k) => text.slice(st, starts[k + 1] ?? text.length))
    .map((blk) => ({ date: findDate(blk, L.date) || date, amount: findAmount(blk, L.amount), description: findLine(blk, L.merchant) || `${issuer}のご利用`, refund }))
    .filter((x) => x.amount != null) : [];
  return { kind: "transaction", issuer, card_label: cardLabel(text), date, amount, description: merchant || `${issuer}のご利用`, refund, flash: /速報/.test(subject), ...(items.length > 1 ? { items } : {}) };
}

// 件名と送信元だけで、本文を取りに行く価値があるか判断する（Gmail の呼び出し回数を減らす）
function worthFetching(sender, subject) {
  if (!issuerFor(sender)) return false;
  const s = String(subject || "").normalize("NFKC");
  return BILL_SUBJECT.test(s) || (NOTIFY_SUBJECT.test(s) && !IGNORE_SUBJECT.test(s));
}

function matchCard(p) {
  const cards = accounts().filter((a) => a.kind === "card");
  const label = (p.card_label || "").normalize("NFKC");
  for (const c of cards) {
    const kws = String(c.email_keyword || "").split(",").map((k) => k.trim().normalize("NFKC")).filter(Boolean);
    if (kws.some((k) => label.includes(k) || k === p.issuer)) return c.id;
  }
  const short = (p.issuer || "").replace("カード", "");
  const hit = cards.find((c) => !c.email_keyword && short && (c.name.includes(short) || (c.institution || "").includes(short)));
  if (hit) return hit.id;
  // カード名が読めなくても、その会社のカードが 1 枚だけ登録されていればそれとみなす
  const same = cards.filter((c) => short && (c.name.includes(short) || (c.institution || "").includes(short)));
  return same.length === 1 ? same[0].id : null;
}

// 店名が「APPLE COM BILL」のように共通の明細は、金額も一致したときだけ固定費とみなす（match_amount）
function matchRecurring(desc, amount) {
  const t = kanaKey(desc);
  for (const r of recurring()) {
    if (r.active === false || !r.match_keyword) continue;
    if (r.match_amount && amount != null && Number(amount) !== Number(r.amount)) continue;
    if (r.match_keyword.split(",").some((k) => kanaKey(k) && t.includes(kanaKey(k)))) return r.id;
  }
  return null;
}

// ================================================================== Gmail 取り込み
const GMAIL = "Gmail";
let syncing = false;

function mailErrorText(e) {
  switch (e?.code) {
    case "server_not_connected": return "Gmail が claude.ai に接続されていません。claude.ai の設定 → コネクタで Gmail を追加してください。";
    case "needs_reauth": return "Gmail の接続が切れています。claude.ai の設定 → コネクタで Gmail を再接続してください。";
    case "not_in_manifest": return "このページでの Gmail の利用が許可されていません。ページ右上のメニューの「権限」から許可できます。";
    case "selection_required": return "Gmail の接続が複数あります。表示された画面で使うものを選んでください。";
    case "blocked_by_policy": return "組織の設定で Gmail の利用が止められています。";
    case "approval_required": return "Gmail の利用の承認が必要です。「今すぐ取り込む」を押して承認してください。";
    case "not_granted": case "capability_disabled": case "capability_removed": return "この表示では Gmail を使えません。claude.ai で開いてください。";
    case "server_unavailable": return "Gmail が応答しませんでした。少し待ってからもう一度お試しください。";
    case "tool_error": return `Gmail がエラーを返しました: ${e.message}`;
    default: return `Gmail から取り込めませんでした（${e?.code || e?.message || "不明なエラー"}）`;
  }
}

async function callGmail(mcp, tool, input) {
  try { return (await mcp.callTool(GMAIL, tool, input, { cache: false })).payload; }
  catch (e) {
    if (e?.retryable) { await new Promise((r) => setTimeout(r, (e.retryAfterMs || 1500) + Math.random() * 1000)); return (await mcp.callTool(GMAIL, tool, input, { cache: false })).payload; }
    throw e;
  }
}

function logMail(entry) {
  S.mail.log = [entry, ...S.mail.log.filter((l) => l.id !== entry.id)].slice(0, 120);
  if (entry.status !== "no_account" && !S.mail.seen.includes(entry.id)) S.mail.seen = [...S.mail.seen, entry.id].slice(-3000);
}

// ------------------------------------------------------------------ お店からの購入メール（AI で読む）
// カード会社が 1 回ごとの利用通知を送らない場合の補完。Amazon・チケット・交通・サブスクなどの
// 注文確認や領収書メールから、支払った日・金額・お店・カテゴリを Claude に読み取らせる。
const RECEIPT_EXCLUDE = [...Object.keys(ISSUERS), "moneyforward.com", "rakuten-sec.co.jp", "smarthr.jp", "rakuten-bank.co.jp", "jp-bank.japanpost.jp"];
const RECEIPT_SUBJECT = /(注文|領収|レシート|receipt|購入|決済|支払|ご利用|料金|請求|予約|申込|チケット|invoice|payment|お買い上げ|ご契約)/i;
const RECEIPT_IGNORE = /(キャンペーン|セール|sale|クーポン|ポイント(進呈|獲得|プレゼント)|ニュース|プレゼント|【PR】|（PR）|\(PR\)|アンケート|ログイン|認証|パスワード|お得|おトク|最大|%OFF|％OFF|無料体験|おすすめ|新着|メンテナンス|発送済み|発送のお知らせ|お届け予定|到着予定|配送|購入失敗|リマインド|搭乗前|事前案内|登録完了|会員登録)/i;
const RECEIPT_BATCH = 6, RECEIPT_MAX_PER_SYNC = 36;

function receiptQuery(since) {
  return `after:${since} -category:promotions -category:social -in:sent -from:(${RECEIPT_EXCLUDE.join(" OR ")}) ` +
    `(subject:(注文 OR 領収 OR 購入 OR 決済 OR 支払 OR 料金 OR 請求 OR receipt OR 予約 OR 申込 OR チケット OR invoice) OR 合計金額 OR お支払い金額 OR お支払金額 OR "Amount paid")`;
}

function receiptCandidate(m) {
  const subj = String(m.subject || "").normalize("NFKC");
  return !issuerFor(m.sender) && RECEIPT_SUBJECT.test(subj) && !RECEIPT_IGNORE.test(subj);
}

function trimBody(text) {
  return String(text || "").normalize("NFKC")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[ \t\u3000]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .slice(0, 2500);
}

const RECEIPT_PROMPT = (cats) => `あなたは家計簿アプリのレシート読み取り係です。下のメールそれぞれについて、ユーザーが実際にお金を支払った（支払いが確定した）記録かを判定してください。
JSON 配列だけを返します。メール 1 通につき 1 要素:
{"id": "メールID", "purchase": true, "date": "YYYY-MM-DD", "amount": 1234, "merchant": "お店・サービス名（短く）", "item": "買ったもの（20字以内）", "category": "カテゴリ", "card_last4": "9746", "refund": false, "reason": ""}
- purchase を true にするもの: 注文確定、決済完了、領収書、利用料金の確定、チケット購入完了、スマート支払い完了、サブスクの請求。支払金額が書かれた注文確認メールも true（「発送時に契約成立」と書かれていても、注文確認の方を true にし、あとの発送連絡は重複として false）。
- purchase を false にするもの: 広告、支払いがまだの予約受付や現地払い、配送や発送の連絡、同じ注文の重複連絡、購入失敗、ポイントだけの連絡、給与や入金、投資の積立。false のときは reason に理由を 15 字以内で書き、ほかの項目は省略してよい。
- amount は税・手数料込みの支払総額を円の整数で。外貨の場合はメールに書かれた円換算額（Charged ¥… など）を使い、円換算額がなければ purchase を false にする。
- date は支払日・利用日。分からなければメールの受信日。
- category は次から 1 つ: ${cats.join("、")}
- card_last4 はカード番号の下 4 桁が書いてあるときだけ。返金・取消の連絡なら refund を true。`;

function receiptInput(cats, batch) {
  return RECEIPT_PROMPT(cats) + "\n\n" + batch.map((b) => `=== メールID: ${b.meta.id}\n受信日: ${b.received}\n送信元: ${b.meta.sender}\n件名: ${b.meta.subject}\n本文:\n${b.text}`).join("\n\n");
}

// 返事が JSON として読めなかったまとまりは 1 通ずつ読み直し、それでも駄目なメールは飛ばす
// （同じメールで毎回止まらないように）。利用上限や許可なしはそのまま呼び出し元へ。
async function extractReceipts(sample, cats, batch) {
  try {
    const out = await sample.json(receiptInput(cats, batch), { modelTier: "default", cache: false });
    return Array.isArray(out) ? out : [];
  } catch (e) {
    if (["invalid_json", "refused", "empty_completion", "prompt_too_large"].includes(e?.code)) {
      if (batch.length > 1) {
        const out = [];
        for (const b of batch) out.push(...(await extractReceipts(sample, cats, [b])));
        return out;
      }
      return [{ id: batch[0].meta.id, purchase: false, reason: "AIで読み取れませんでした" }];
    }
    throw e;
  }
}

async function readReceipts(mcp, sample, since, seen, summary, touchedMonths) {
  const metas = [];
  let pageToken;
  for (let page = 0; page < 3; page++) {
    const res = await callGmail(mcp, "search_threads", { query: receiptQuery(since), pageSize: 50, view: "THREAD_VIEW_MINIMAL", ...(pageToken ? { pageToken } : {}) });
    for (const th of res?.threads || []) for (const m of th.messages || []) metas.push(m);
    pageToken = res?.nextPageToken;
    if (!pageToken) break;
  }
  // 古い順に処理する（上限で打ち切っても、残りは次回の取り込みで読む）
  const todo = metas.filter((m) => m.id && !seen.has(m.id) && receiptCandidate(m)).reverse().slice(0, RECEIPT_MAX_PER_SYNC);
  if (!todo.length) return 0;
  const st = settings();
  const cards = accounts().filter((a) => a.kind === "card");
  const defaultAccount = st.receipt_account_id && accounts().some((a) => a.id === st.receipt_account_id) ? st.receipt_account_id : cards.length === 1 ? cards[0].id : null;
  const cats = ALL_CATEGORIES();
  let done = 0;
  for (let i = 0; i < todo.length; i += RECEIPT_BATCH) {
    const batch = [];
    for (const m of todo.slice(i, i + RECEIPT_BATCH)) {
      const full = await callGmail(mcp, "get_message", { messageId: m.id, messageFormat: "PLAIN_TEXT" });
      const dt = m.date ? new Date(m.date) : null;
      const received = dt && !isNaN(dt) ? D.fmt(D.ymd(dt.getFullYear(), dt.getMonth() + 1, dt.getDate())) : D.fmt(D.today());
      batch.push({ meta: m, received, text: trimBody(full?.plaintextBody || m.snippet || "") });
    }
    const out = await extractReceipts(sample, cats, batch);
    const byId = Object.fromEntries(out.filter((r) => r && r.id).map((r) => [String(r.id), r]));
    for (const b of batch) {
      const m = b.meta, r = byId[m.id];
      const base = { id: m.id, date: b.received, sender: m.sender || "", subject: m.subject || "" };
      const amount = Math.round(Number(r?.amount));
      if (!r || !r.purchase || !(amount > 0)) {
        summary.ignored++;
        logMail({ ...base, status: "ignored", detail: r?.reason ? `AI: ${String(r.reason).slice(0, 30)}` : "支払いの記録ではありません" });
        continue;
      }
      const date = /^\d{4}-\d{2}-\d{2}$/.test(r.date || "") && Math.abs(D.parse(r.date) - D.parse(b.received)) <= 62 ? r.date : b.received;
      const type = r.refund ? "income" : "expense";
      // カード下 4 桁が分かれば、登録したカードと一致したときだけそのカードの利用にする
      // （一致しなければ別のカードなので口座なし。下 4 桁が書いていなければ既定の支払い方法）
      const last4 = String(r.card_last4 || "").replace(/\D/g, "").slice(-4);
      // card_last4 は「9746,3939」のように複数書ける（Apple Pay などは別の番号になるため）
      const accountId = last4.length === 4 ? (cards.find((c) => String(c.card_last4 || "").split(",").map((x) => x.trim()).includes(last4))?.id || null) : last4 ? null : defaultAccount;
      const merchant = String(r.merchant || m.sender || "").slice(0, 40);
      const description = r.item ? `${merchant}（${String(r.item).slice(0, 24)}）` : merchant;
      await ensureMonths([D.ym(date)]);
      const dup = allTx().find((t) => t.amount === amount && t.type === type && (t.account_id || null) === accountId && t.mail_id !== m.id && Math.abs(D.parse(t.date) - D.parse(date)) <= 3);
      if (dup) {
        summary.merged++;
        logMail({ ...base, status: "merged", detail: `既存の明細と同じ: ${dup.date} ${dup.description}` });
        continue;
      }
      const category = type === "income" ? "収入・返金" : cats.includes(r.category) ? r.category : guessCategory(description);
      touchedMonths.add(addTx({ date, amount, type, category, account_id: accountId, description,
        memo: r.card_last4 ? `カード下4桁 ${String(r.card_last4).slice(-4)}` : "", recurring_id: type === "expense" ? matchRecurring(description, amount) : null,
        source: "receipt", mail_id: m.id }));
      summary.receipts++;
      logMail({ ...base, status: "receipt", detail: `${description} ${amount.toLocaleString()}円（${category}）` });
    }
    done += batch.length;
  }
  return done;
}

async function syncGmail({ silent = false } = {}) {
  if (syncing) return;
  const mcp = await claude.use("mcp");
  if (!mcp) { if (!silent) toast("この表示では Gmail を使えません"); return; }
  syncing = true;
  renderGmail();
  const st = settings();
  const since = D.fmt(D.today() - (Number(st.gmail_lookback_days) || 45)).replace(/-/g, "/");
  const query = "{" + Object.keys(ISSUERS).map((d) => "from:" + d).join(" ") + "} after:" + since;
  const summary = { checked: 0, imported: 0, merged: 0, bills: 0, ignored: 0, no_account: 0, receipts: 0 };
  const touchedMonths = new Set();
  const at = new Date().toISOString();
  try {
    const metas = [];
    let pageToken;
    for (let page = 0; page < 4; page++) {
      const res = await callGmail(mcp, "search_threads", { query, pageSize: 50, view: "THREAD_VIEW_MINIMAL", ...(pageToken ? { pageToken } : {}) });
      for (const th of res?.threads || []) for (const m of th.messages || []) metas.push(m);
      pageToken = res?.nextPageToken;
      if (!pageToken) break;
    }
    const seen = new Set(S.mail.seen);
    const fresh = metas.filter((m) => m.id && !seen.has(m.id));
    for (const m of fresh) {
      summary.checked++;
      const dt = m.date ? new Date(m.date) : null;
      const received = dt && !isNaN(dt) ? D.fmt(D.ymd(dt.getFullYear(), dt.getMonth() + 1, dt.getDate())) : null;
      const base = { id: m.id, date: received || "", sender: m.sender || "", subject: m.subject || "" };
      if (!worthFetching(m.sender, m.subject)) { summary.ignored++; logMail({ ...base, status: "ignored", detail: "利用通知・請求額のメールではありません" }); continue; }
      const full = await callGmail(mcp, "get_message", { messageId: m.id, messageFormat: "PLAIN_TEXT" });
      const p = parseMail(full?.sender || m.sender, full?.subject || m.subject, full?.plaintextBody || "", received);
      if (p.kind === "ignored") { summary.ignored++; logMail({ ...base, status: "ignored", detail: p.reason }); continue; }
      const accountId = matchCard(p);
      if (p.kind === "bill") {
        if (!accountId) { summary.no_account++; logMail({ ...base, status: "no_account", detail: `${p.issuer} ${p.amount.toLocaleString()}円 ${p.payment_date}払い（このカードを登録すると反映されます）` }); continue; }
        const prev = S.bills.items.find((b) => b.account_id === accountId && b.payment_date === p.payment_date);
        // 確定額を、あとから処理した予定額で上書きしない
        if (!(prev && prev.confirmed !== false && !p.confirmed)) {
          S.bills.items = [...S.bills.items.filter((b) => b !== prev),
            { account_id: accountId, payment_date: p.payment_date, amount: p.amount, confirmed: p.confirmed, mail_id: m.id }].slice(-60);
        }
        summary.bills++;
        logMail({ ...base, status: "bill", detail: `${p.amount.toLocaleString()}円 ${p.payment_date}払い${p.confirmed ? "（確定）" : "（予定）"}` });
        continue;
      }
      for (const u of p.items || [p]) {
        await ensureMonths([D.ym(u.date)]);
        const type = u.refund ? "income" : "expense";
        const dup = allTx().find((t) => t.amount === u.amount && t.type === type && (t.account_id || null) === accountId && ["csv", "manual"].includes(t.source) && !t.mail_id && Math.abs(D.parse(t.date) - D.parse(u.date)) <= 3);
        if (dup) { dup.mail_id = m.id; touchedMonths.add(D.ym(dup.date)); summary.merged++; logMail({ ...base, status: "merged", detail: `既存の明細と同じ: ${dup.date} ${dup.description}` }); continue; }
        // 楽天カードなどは同じ利用に【速報版】（利用先なし）と通常版（利用先あり）の 2 通が届く。2 通目は 1 件にまとめ、利用先が分かれば書き換える
        const generic = (d) => !d || /のご利用$/.test(d);
        // 速報版から入った明細は、あとで名前やカテゴリを自分で直していても同じ利用として扱う
        const fromFlash = (t) => t.flash || String((S.mail.log || []).find((l) => l.id === t.mail_id)?.subject || "").includes("速報");
        const twin = allTx().find((t) => t.source === "gmail" && t.mail_id !== m.id && t.amount === u.amount && t.type === type && (t.account_id || null) === accountId &&
          Math.abs(D.parse(t.date) - D.parse(u.date)) <= 3 && (generic(t.description) || generic(u.description) || (fromFlash(t) && !p.flash)));
        if (twin) {
          if (generic(twin.description) && !generic(u.description)) {
            const rec = type === "expense" ? matchRecurring(u.description, u.amount) : null;
            Object.assign(twin, { description: u.description, recurring_id: twin.recurring_id || rec,
              category: twin.category === "未分類" || twin.category === guessCategory(twin.description) ? (u.refund ? "収入・返金" : learnedCategory(u.description) || guessCategory(u.description)) : twin.category });
          } else if (!generic(u.description) && !String(twin.memo || "").includes(u.description)) {
            twin.memo = [twin.memo, `明細: ${u.description}`].filter(Boolean).join(" / ");
          }
          twin.mail_ids = [...new Set([...(twin.mail_ids || []), m.id])];
          touchedMonths.add(D.ym(twin.date)); summary.merged++;
          logMail({ ...base, status: "merged", detail: `速報版と同じ利用: ${twin.date} ${twin.description}` });
          continue;
        }
        touchedMonths.add(addTx({ date: u.date, amount: u.amount, type, category: u.refund ? "収入・返金" : learnedCategory(u.description) || guessCategory(u.description), account_id: accountId,
          description: u.description, recurring_id: type === "expense" ? matchRecurring(u.description, u.amount) : null, source: "gmail", mail_id: m.id, ...(p.flash ? { flash: true } : {}) }));
        summary.imported++;
        logMail({ ...base, status: "imported", detail: accountId ? "" : "カード未登録のため口座なしで記録" });
      }
    }
    // お店からの購入メール。AI の利用許可が要るので、自動取り込みでは許可済みのときだけ
    let receiptNote = "";
    if (st.receipts_enabled !== false) {
      const sample = await claude.use("sample");
      let allowed = !!sample;
      if (sample && silent) {
        const perms = await claude.use("permissions").catch(() => null);
        allowed = (perms ? await perms.state("sample").catch(() => "unavailable") : "unavailable") === "granted";
      }
      if (allowed) {
        try { await readReceipts(mcp, sample, since, new Set(S.mail.seen), summary, touchedMonths); }
        catch (e) {
          receiptNote = e?.code === "not_granted" ? "（購入メールの読み取りは AI の利用が許可されていないため休止中）"
            : e?.code === "rate_limited" ? "（AI の利用上限のため、購入メールの残りは次回読みます）"
            : e?.code ? `（購入メールの読み取りに失敗: ${e.code}）` : `（購入メールの読み取りに失敗: ${e?.message || e}）`;
        }
      }
    }
    S.mail.lastSync = { at, ok: true, summary, note: receiptNote };
    if (!silent || summary.imported || summary.bills || summary.receipts)
      toast(`明細 ${summary.imported + summary.receipts} 件・請求額 ${summary.bills} 件を取り込みました${receiptNote}`);
  } catch (e) {
    S.mail.lastSync = { at, ok: false, error: mailErrorText(e) };
    if (!silent) toast(mailErrorText(e));
  } finally {
    syncing = false;
    for (const ym of touchedMonths) await save("tx/" + ym);
    await save("bills");
    await save("mail");
    render();
  }
}

async function maybeAutoSync() {
  const st = settings();
  if (!st.gmail_auto || syncing) return;
  const last = S.mail.lastSync?.at;
  if (last && Date.now() - Date.parse(last) < Math.max(5, Number(st.gmail_interval_min) || 60) * 60000) return;
  // 自動では確認画面を出さない。許可済みのときだけ取り込む
  const perms = await claude.use("permissions").catch(() => null);
  const state = perms ? await perms.state("mcp:" + GMAIL).catch(() => "unavailable") : "unavailable";
  if (state === "granted") syncGmail({ silent: true });
}

// ================================================================== AI アドバイス
const ADVISOR_PROMPT = `あなたはユーザー専属の家計アドバイザーです。以下の家計データ（JSON）を読み、日本語で具体的に助言します。

方針:
- 最初に「今月の状況」を一言で（使いすぎ／順調／余裕あり など）伝え、「今日あといくら」「今月あといくら」使えるかを金額で示す。
- 数字は JSON の値から計算し、推測した数字には「見込み」と書く。データにない事実を作らない。
- 指摘は優先度の高い順に最大 5 つ。それぞれ「何を」「いくら」「どうする」が分かるように。
- サブスク・インフラ（通信・電気など）は、見直し余地がありそうなものを具体名で挙げる。
- カードの引き落とし予定と口座残高を照らし合わせ、残高不足のおそれがあれば最優先で警告する。next_payment.source が "email" ならカード会社から届いた確定請求額。tracked_amount（取り込んだ明細の合計）と大きく違えば、明細の取り込み漏れの可能性を伝える。
- NISA・iDeCo・企業型DC は「すぐには使えないお金」として生活費とは分けて扱う。iDeCo/DC は原則 60 歳まで引き出せない。
- ほしいものリストは、今買ってよいか・いつなら買えるかを判断する。
- 口座残高や収入が 0 のままなら、登録すると精度が上がることを短く伝える。
- 個別銘柄の売買推奨はしない。見出しと箇条書きで簡潔に、全体で 600 字程度。質問があればそれに最優先で答える。`;

function adviceContext(d) {
  const b = d.budget, w = d.net_worth;
  const pick = (o, ks) => Object.fromEntries(ks.map((k) => [k, o[k]]));
  return {
    today: d.today, period: b.period,
    budget: pick(b, ["income", "fixed_monthly", "investment_monthly", "savings_goal", "variable_budget", "spent", "reimbursed", "today_spent", "remaining", "daily_allowance", "today_remaining", "expected_by_now", "pace_ratio", "projected_spent", "projected_surplus", "status", "avg_variable_spent"]),
    past_periods_variable_spent: b.history, categories: b.categories,
    recurring: d.recurring.filter((r) => r.active !== false).map((r) => ({ name: r.name, kind: r.kind, amount: r.amount, cycle: r.cycle, variable: !!r.variable, note: r.note || "" })),
    recurring_monthly_by_kind: b.recurring.monthly_by_kind, upcoming_bills_next_31_days: b.recurring.upcoming,
    cards: d.cards.map((c) => pick(c, ["name", "current_cycle", "next_payment", "unpaid_total", "limit", "limit_usage"])),
    payment_checks: d.payment_checks,
    net_worth: pick(w, ["liquid", "invest", "pension", "other", "liability", "card_unpaid", "total_assets", "net_worth", "spendable"]),
    investments: w.investments, emergency_fund: d.emergency_fund,
    wishlist: d.wishlist.map((it) => pick(it, ["name", "price", "priority", "saved", "need", "target_date", "months_to_save", "fits_this_month", "keeps_emergency_fund", "verdict"])),
  };
}

async function ask(question, out, button) {
  const sample = await claude.use("sample");
  if (!sample) { out.className = "md neg"; out.textContent = "この表示では AI に相談できません。claude.ai で開いてください。"; return; }
  if (button) button.disabled = true;
  out.className = "md loading";
  out.innerHTML = "";
  const input = `${ADVISOR_PROMPT}\n\n## 家計データ\n\`\`\`json\n${JSON.stringify(adviceContext(dashboard()))}\n\`\`\`\n\n## 質問\n${question || "今の家計の状況を診断して、今月どう過ごせばいいかアドバイスしてください。"}`;
  try {
    const r = await sample(input, { modelTier: "default", cache: false, onText: ({ text }) => { out.className = "md"; out.innerHTML = renderMarkdown(text); } });
    out.className = "md";
    out.innerHTML = renderMarkdown(r.text);
    S.advice.log = [{ at: new Date().toISOString(), question: question || "", answer: r.text }, ...S.advice.log].slice(0, 20);
    save("advice");
  } catch (e) {
    out.className = "md neg";
    out.textContent = e?.code === "not_granted" ? "AI への相談が許可されていません。ページのメニューの「権限」から許可できます。"
      : e?.code === "rate_limited" ? "しばらく時間をおいてからもう一度お試しください。" : `AI に相談できませんでした（${e?.code || e?.message}）`;
  } finally {
    if (button) button.disabled = false;
  }
}

// ================================================================== render
let currentTab = "dashboard";
try { currentTab = localStorage.getItem("tab") || "dashboard"; } catch {}

function showTab(name) {
  currentTab = name;
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab").forEach((s) => s.classList.toggle("active", s.id === `tab-${name}`));
  try { localStorage.setItem("tab", name); } catch {}
  render();
}
$("#tabs").addEventListener("click", (e) => { if (e.target.dataset.tab) showTab(e.target.dataset.tab); });
document.addEventListener("click", (e) => { const g = e.target.closest("[data-goto]"); if (g) { e.preventDefault(); showTab(g.dataset.goto); } });

let renderQueued = false;
function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderRefs();
    fillIcons();
    $("#fab").hidden = !SHEET_FOR_TAB[currentTab];
    ({ dashboard: renderDashboard, transactions: () => { renderTxTable(); renderGmail(); }, assets: renderAccounts, recurring: renderRecurring,
       wishlist: renderWishlist, advice: renderAdviceHistory, settings: renderSettings }[currentTab])?.();
  });
}

function renderRefs() {
  const accs = accounts();
  const accOpts = `<option value="">（未指定）</option>` + accs.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}（${KIND_LABELS[a.kind]}）</option>`).join("");
  $$("select.account-select").forEach((s) => { const v = s.value; s.innerHTML = s.id === "tx-account" ? accOpts.replace("（未指定）", "すべての口座") : accOpts; s.value = v; });
  const bankOpts = `<option value="">（未指定）</option>` + accs.filter((a) => LIQUID.has(a.kind)).map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join("");
  $$("select.bank-select").forEach((s) => { const v = s.value; s.innerHTML = bankOpts; s.value = v; });
  const recOpts = `<option value="">なし（変動費）</option>` + recurring().filter((r) => r.active !== false).map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join("");
  $$("select.recurring-select").forEach((s) => { const v = s.value; s.innerHTML = recOpts; s.value = v; });
  const cats = new Set([...ALL_CATEGORIES(), "収入", "未分類", ...allTx().map((t) => t.category), ...Object.keys(settings().category_budgets || {})]);
  $("#category-list").innerHTML = [...cats].map((c) => `<option value="${esc(c)}">`).join("");
}

// ------------------------------------------------------------------ やること
// 前回の CSV 取り込み日（記録がなければ、その口座の CSV 明細のいちばん新しい日付）
function lastCsv(accId) {
  const rec = (settings().last_csv || {})[accId];
  const fromTx = allTx().filter((t) => t.account_id === accId && t.source === "csv").map((t) => t.date).sort().pop();
  return [rec, fromTx].filter(Boolean).sort().pop() || null;
}
const ago = (s) => (s ? D.today() - D.parse(s) : null);
const agoText = (s) => (s ? `前回 ${s.slice(5).replace("-", "/")}（${ago(s) === 0 ? "今日" : ago(s) + "日前"}）` : "まだ取り込んでいません");
function todoItems() {
  const today = D.today(), [y, m, day] = D.parts(today), items = [];
  const cards = accounts().filter((a) => a.kind === "card");
  for (const c of cards) {
    const last = lastCsv(c.id);
    // 請求額が確定する 12 日ごろ以降に、その月まだ取り込んでいなければお知らせ
    const due = !last || ago(last) > 35 || (day >= 12 && D.parse(last) < D.ymd(y, m, 12));
    items.push({ due, title: `${c.name}の CSV を取り込む`, freq: "月1回（毎月12日ごろ）", status: agoText(last), goto: "transactions",
      how: `楽天e-NAVI にログイン →「ご利用明細」→ 月を選んで「CSV ダウンロード」→ この画面の「明細」タブ →「CSV を取り込む」で「${c.name}」を選んで取り込む。今月分（未確定）も取り込めます。何回取り込んでも二重になりません。` });
  }
  const pp = accounts().find((a) => /paypay/i.test(a.name) && a.kind === "emoney");
  if (pp) {
    const last = lastCsv(pp.id);
    items.push({ due: !last || ago(last) > 31, title: "PayPay の CSV を取り込む", freq: "月1回", status: agoText(last), goto: "transactions",
      how: "PayPay アプリのホーム →［取引履歴］→ 右上の［取引履歴のダウンロード］→ 期間を選んで［ダウンロード申請をする］→ 通知が来たら［申請ステータス］からダウンロード（24 時間以内）→「CSV を取り込む」で選ぶだけ（PayPay は自動で判別します）。受け取った立替の精算は自動で支出から差し引かれます。" });
  }
  // 給料（25日）とカード・家賃の引き落とし（27日）が済んだ 28 日ごろに、月1回まとめて更新する
  const last28 = day >= 28 ? D.ymd(y, m, 28) : D.ymd(...D.addM(y, m, -1), 28);
  const stale = accounts().filter((a) => a.kind !== "card" && (!a.updated_at || D.parse(a.updated_at) < last28 || /未入力/.test(a.note || "")));
  items.push({ due: stale.length > 0, title: "口座・電子マネー・ポイントの残高を更新する", freq: "月1回（毎月28日ごろ）", goto: "assets",
    status: stale.length ? `更新が必要: ${stale.map((a) => a.name).join("、")}` : "すべて1か月以内に更新済み",
    how: "各アプリで残高を見て「口座・資産」タブで入力。Claude に金額を伝えても入れてもらえます。" });
  const [ps, pe] = periodBounds(today, settings().cycle_start_day);
  const unc = allTx().filter((t) => t.type === "expense" && t.category === "未分類" && inRange(t.date, ps, pe));
  if (unc.length) items.push({ due: true, title: `カテゴリが未分類の明細を確認する（${unc.length} 件）`, freq: "気づいたとき", goto: "transactions",
    status: unc.slice(0, 3).map((t) => t.description).join("、") + (unc.length > 3 ? " など" : ""), how: "「明細」タブで未分類の行を開いてカテゴリを入れる。直した店名は次から自動で同じカテゴリになります。" });
  return items;
}
const TODO_SOMETIMES = [
  ["楽天キャッシュや現金で立替の精算を受け取った", "Claude にひとこと（いつ・誰から・いくら・何の精算か）伝えるか、楽天ペイの履歴のスクリーンショットを送る。PayPay で受け取った分は CSV で自動です。"],
  ["精算ではないお金を受け取った（プレゼント・物の売却など）", "その明細のカテゴリを「立替の精算」から別のものに変える（そのままだと支出から差し引かれてしまうため）。"],
  ["サブスク・固定費を始めた／やめた", "「固定費・サブスク」タブで追加・停止する。"],
  ["大きな買い物をしたい", "「ほしいもの」に入れておくと、AI が買っていいタイミングを教えます。"],
];
function renderTodos() {
  const items = todoItems(), due = items.filter((i) => i.due), todos = settings().todos || [];
  const open = todos.filter((t) => !t.done);
  const row = (i) => `<li class="todo ${i.due ? "due" : "done"}"><span class="todo-mark" aria-hidden="true">${i.due ? "●" : "✓"}</span><div>
    <div><b>${esc(i.title)}</b> <span class="small muted">${esc(i.freq)}</span></div>
    <div class="small ${i.due ? "" : "muted"}">${esc(i.status)}${i.goto ? ` <a href="#" data-goto="${i.goto}">開く</a>` : ""}</div>
    <details><summary class="small">やり方</summary><p class="small">${esc(i.how)}</p></details></div></li>`;
  const nDue = due.length + open.length;
  $("#todo-card").innerHTML = `<div class="row-between wrap"><h2>${ico("check")}わたしのやること</h2><span class="todo-count ${nDue ? "due" : ""}">${nDue ? `${nDue} 件` : "✓ なし"}</span></div>
    ${due.length ? `<ul class="todo-list">${due.map(row).join("")}</ul>` : ""}
    ${open.length ? `<ul class="todo-list">${open.map((t) => `<li class="todo due"><label><input type="checkbox" data-todo="${esc(t.id)}"> ${esc(t.text)}</label></li>`).join("")}</ul>` : ""}
    ${!nDue ? `<p class="small muted">今やることはありません。</p>` : ""}
    <details class="todo-more"><summary class="small">すべてのやること・メモを追加</summary>
      <ul class="todo-list">${items.filter((i) => !i.due).map(row).join("")}</ul>
      ${todos.filter((t) => t.done).length ? `<ul class="todo-list">${todos.filter((t) => t.done).map((t) => `<li class="todo done"><label><input type="checkbox" data-todo="${esc(t.id)}" checked> ${esc(t.text)}</label></li>`).join("")}</ul><button type="button" class="small" id="todo-clear">完了したものを消す</button>` : ""}
      <form id="todo-add" class="row-between"><input name="text" id="todo-add-text" placeholder="メモを追加（例: 楽天銀行の残高を確認）" aria-label="メモを追加"><button type="submit">追加</button></form>
      <p class="small"><b>そのときだけ</b></p><ul class="small">${TODO_SOMETIMES.map(([a, b]) => `<li><b>${esc(a)}</b>: ${esc(b)}</li>`).join("")}</ul>
      <p class="small muted">自動: カード利用メールの取り込み・カテゴリ分け・予算の計算・PayPay で受け取った精算の差し引き</p>
    </details>`;
}
document.addEventListener("change", (e) => {
  const id = e.target.dataset?.todo;
  if (!id) return;
  S.settings = { ...settings(), todos: (settings().todos || []).map((t) => (t.id === id ? { ...t, done: e.target.checked } : t)) };
  save("settings"); render();
});
document.addEventListener("submit", (e) => {
  if (e.target.id !== "todo-add") return;
  e.preventDefault();
  const text = e.target.text.value.trim();
  if (!text) return;
  S.settings = { ...settings(), todos: [...(settings().todos || []), { id: Math.random().toString(36).slice(2, 10), text, done: false }] };
  save("settings"); render();
});
document.addEventListener("click", (e) => {
  if (e.target.id !== "todo-clear") return;
  S.settings = { ...settings(), todos: (settings().todos || []).filter((t) => !t.done) };
  save("settings"); render();
});

// ------------------------------------------------------------------ 口座のブランド色・カテゴリの色
// 口座は金融機関の色（楽天=赤、ゆうちょ=緑 など）、それ以外は種類ごとの色
const BRANDS = [[/楽天|rakuten/i, "#bf0000", "楽"], [/ゆうちょ|郵便/, "#5fae3b", "ゆ"], [/paypay/i, "#ff0033", "P"], [/三井住友|smbc|olive/i, "#00804a", "三"],
  [/三菱|mufg/i, "#d7000f", "三"], [/みずほ/, "#1a3f99", "み"], [/住信|sbi/i, "#0d4ea5", "S"], [/イオン|aeon/i, "#b6007a", "イ"], [/au |auじぶん|au pay/i, "#eb5505", "au"],
  [/d払い|dカード|docomo|ドコモ/i, "#cc0033", "d"], [/suica|モバイルpasmo|pasmo/i, "#2e9b3a", "交"], [/amazon/i, "#ff9900", "a"]];
const KIND_COLOR = { bank: "#2a78d6", cash: "#a07b3b", emoney: "#eda100", card: "#6250d6", securities: "#eb6834", nisa: "#eb6834", ideco: "#1baf7a", dc: "#1baf7a", loan: "#77766f", other: "#e87ba4" };
function brandOf(a) {
  const txt = `${a?.name || ""} ${a?.institution || ""}`;
  for (const [re, c, l] of BRANDS) if (re.test(txt)) return { c, l };
  return { c: KIND_COLOR[a?.kind] || "#77766f", l: a?.kind === "cash" ? "¥" : (a?.name || "?").replace(/[（(].*$/, "").trim().charAt(0) };
}
const inkFor = (hex) => { const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255; return 0.299 * r + 0.587 * g + 0.114 * b > 170 ? "#1a1a19" : "#ffffff"; };
const avatar = (a) => { const { c, l } = brandOf(a); return `<span class="avatar" style="background:${c};color:${inkFor(c)}" aria-hidden="true">${esc(l)}</span>`; };
const accDot = (a) => (a ? `<span class="acc-dot" style="background:${brandOf(a).c}"></span>${esc(a.institution && a.institution.length <= 8 ? a.institution : a.name)}` : "");
// お店はブランド色の丸バッジ（ロゴ画像は使わず、色と頭文字で見分けられるようにする）
const MERCHANTS = [
  [["ファミリーマート", "ファミマ", "FAMILYMART"], "#00a040", "F"], [["ローソン", "LAWSON"], "#0068b7", "L"], [["セブンイレブン", "セブン-イレブン", "7-ELEVEN", "SEVEN-ELEVEN"], "#f58220", "7"],
  [["ミニストップ"], "#003f98", "M"], [["ニューデイズ", "NEWDAYS"], "#0a7d3b", "N"], [["デイリーヤマザキ"], "#e60012", "D"],
  [["マクドナルド", "MCDONALD"], "#da291c", "M", "#ffc72c"], [["スターバックス", "STARBUCKS"], "#00704a", "S"], [["ドトール"], "#1d2087", "D", "#f8b500"], [["タリーズ"], "#0b2a4a", "T"],
  [["すき家"], "#e60012", "す"], [["吉野家"], "#f39800", "吉"], [["松屋"], "#f6c300", "松"], [["サイゼリヤ"], "#008c3a", "サ"], [["ガスト"], "#e6001f", "ガ"], [["コメダ"], "#7a3f1d", "コ"],
  [["まいばすけっと", "マイバスケット"], "#e60012", "ま"], [["イオン", "AEON"], "#b6007a", "イ"], [["西友"], "#e60012", "西"], [["ライフ"], "#e95513", "ラ"], [["成城石井"], "#a51e36", "成"], [["業務スーパー"], "#00913a", "業"],
  [["AMAZON", "アマゾン"], "#232f3e", "a", "#ff9900"], [["楽天市場", "楽天モバイル", "RAKUTEN"], "#bf0000", "楽"], [["APPLE"], "#555555", "A"], [["UBER"], "#06c167", "U", "#000000"], [["出前館"], "#e60012", "出"],
  [["ユニクロ", "UNIQLO"], "#ff0000", "U"], [["ジーユー"], "#0044a5", "GU"], [["無印良品", "MUJI"], "#7f0019", "無"], [["ニトリ"], "#009e5a", "ニ"], [["ダイソー", "DAISO"], "#e4007f", "D"],
  [["マツモトキヨシ", "マツキヨ"], "#fcc800", "マ", "#1a1a19"], [["ウエルシア"], "#e60012", "ウ"], [["ツルハ"], "#e60012", "ツ"], [["洋服の青山"], "#1d2c6b", "青"],
  [["モバイルパスモ", "PASMO"], "#e4007f", "P"], [["モバイルスイカ", "SUICA"], "#2e9b3a", "S"], [["CLAUDE", "ANTHROPIC"], "#d97757", "C"], [["東京ガス"], "#0073c8", "ガ"],
  [["NETFLIX"], "#e50914", "N"], [["SPOTIFY"], "#1db954", "S", "#000000"], [["TOHOシネマズ", "トウホウシネマ"], "#c8102e", "T"], [["紀伊國屋", "紀伊国屋"], "#004098", "紀"],
].map(([keys, c, l, ink]) => [keys.map((k) => kanaKey(k)), c, l, ink]);
function merchantOf(desc) {
  const k = kanaKey(desc);
  // 短い名前（ジーユー→ジユ、イオン など）は「新宿」「エイチケイオン」に紛れるので、先頭に来たときだけ
  for (const [keys, c, l, ink] of MERCHANTS) if (keys.some((x) => x && (x.length <= 3 && /^[ァ-ヶA-Z0-9]+$/.test(x) ? k.startsWith(x) : k.includes(x)))) return { c, l, ink };
  return null;
}
const merchantBadge = (desc) => { const m = merchantOf(desc); return m ? `<span class="avatar" style="background:${m.c};color:${m.ink || inkFor(m.c)}" aria-hidden="true">${esc(m.l)}</span>` : null; };

// カテゴリは色が「そのカテゴリ」に付く（順位では変えない）。8 色を超える分はグレー
const CAT_SLOT = { 交通: 1, 外食: 2, 食費: 3, コンビニ: 4, "衣服・美容": 5, 旅行: 6, "趣味・娯楽": 7, ネットショッピング: 8 };
const catColor = (c) => (CAT_SLOT[c] ? `var(--series-${CAT_SLOT[c]})` : "var(--series-other)");
const catIcon = (c) => `<span class="cat-ico" style="--c:${catColor(c)}" aria-hidden="true">${CAT_EMOJI[c] || "•"}</span>`;

// ------------------------------------------------------------------ アイコン・グラフの部品
const ICON_PATHS = {
  wallet: '<path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h14a2 2 0 0 1 2 2v3h-4a2 2 0 0 0 0 4h4v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  bank: '<path d="M3 21h18M5 21V10M19 21V10M9.5 21V10M14.5 21V10M2 10l10-6 10 6"/>',
  gauge: '<path d="M12 14l4-4"/><path d="M3.3 19a9 9 0 1 1 17.4 0"/>',
  check: '<path d="M10 6h10M10 12h10M10 18h10"/><path d="M3.5 6l1.5 1.5L7.5 5M3.5 12l1.5 1.5L7.5 11M3.5 18l1.5 1.5 2.5-2.5"/>',
  pie: '<path d="M21 12A9 9 0 1 1 12 3v9z"/><path d="M15 3.5A9 9 0 0 1 20.5 9H15z"/>',
  card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h4"/>',
  calendar: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>',
  trend: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  repeat: '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>',
  gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13M19 12v9H5v-9"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5C10 3 12 8 12 8s2-5 4.5-5a2.5 2.5 0 0 1 0 5"/>',
  sparkle: '<path d="M12 3l1.9 5.6 5.6 1.9-5.6 1.9L12 18l-1.9-5.6-5.6-1.9 5.6-1.9z"/>',
  home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
};
const ico = (n) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICON_PATHS[n] || ""}</svg>`;
const CAT_EMOJI = { 食費: "🍙", コンビニ: "🏪", 外食: "🍽️", 日用品: "🧴", 交通: "🚃", ネットショッピング: "📦", サブスク: "🔁", 通信: "📱", "水道・光熱": "💡", 医療: "🏥",
  "趣味・娯楽": "🎮", "衣服・美容": "👕", 旅行: "✈️", 住居: "🏠", 保険: "🛡️", 教育: "📚", 交際費: "🍻", 特別な支出: "🎁", その他: "🗂️", 未分類: "❓", 投資: "📈" };
const KIND_EMOJI = { bank: "🏦", cash: "💴", emoney: "📲", card: "💳", securities: "📈", nisa: "📈", ideco: "🧓", dc: "🧓", loan: "🧾", other: "🎟️" };
const STATUS_FACE = { ok: "😊", warning: "😐", over: "😣", deficit: "😣" };
function fillIcons() { $$("[data-icon]").forEach((el) => { if (!el.firstChild) el.innerHTML = ico(el.dataset.icon); }); }

// 今期の日ごとの支出（変動費・自分の分、受け取った精算は差し引き）
function dailySpending(b) {
  const start = D.parse(b.period.start), days = b.period.total_days, out = Array(days).fill(0);
  for (const t of allTx()) {
    const i = D.parse(t.date) - start;
    if (i < 0 || i >= days) continue;
    if (t.type === "expense" && !t.recurring_id) out[i] += mine(t);
    else if (isSettle(t)) out[i] -= t.amount;
  }
  return out;
}
function renderCumChart(b) {
  const days = b.period.total_days, el = b.period.elapsed_days, daily = dailySpending(b), budget = Math.max(b.variable_budget, 1);
  const cum = []; daily.slice(0, el).reduce((s, v, i) => (cum[i] = s + v), 0);
  const W = Math.max(300, Math.min(1100, ($("#pace-card").clientWidth || 760) - 40)), narrow = W < 600, H = narrow ? 230 : 240, padL = 44, padR = 10, padT = 14, padB = 24;
  const maxV = Math.max(budget, b.projected_spent, ...cum, 1);
  const mag = Math.pow(10, Math.floor(Math.log10(maxV))), step = mag * (maxV / mag > 5 ? 2 : maxV / mag > 2 ? 1 : 0.5), top = Math.ceil(maxV / step) * step;
  const x = (i) => padL + ((W - padL - padR) * i) / days, y = (v) => padT + (H - padT - padB) * (1 - Math.max(0, v) / top);
  const start = D.parse(b.period.start);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="今期の支出の累計。${yen(cum[el - 1] || 0)} 使用、予算 ${yen(budget)}"><g class="axis">`;
  for (let v = 0; v <= top + 1; v += step) svg += `<line class="grid-line" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/><text x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">${man(v)}</text>`;
  for (let i = 0; i < days; i += narrow ? 7 : 5) svg += `<text x="${x(i + 0.5)}" y="${H - 6}" text-anchor="middle">${md(D.fmt(start + i))}</text>`;
  svg += `</g>`;
  svg += `<line class="budget-hline" x1="${padL}" x2="${W - padR}" y1="${y(budget)}" y2="${y(budget)}"/><text class="lbl" x="${W - padR}" y="${y(budget) - 5}" text-anchor="end">予算 ${yen(budget)}</text>`;
  svg += `<path class="pace-line" d="M${x(0)},${y(0)} L${x(days)},${y(budget)}"/>`;
  if (cum.length) {
    const pts = cum.map((v, i) => `${x(i + 1)},${y(v)}`);
    svg += `<path class="cum-area" d="M${x(0)},${y(0)} L${pts.join(" L")} L${x(el)},${y(0)} Z"/><path class="cum-line" d="M${x(0)},${y(0)} L${pts.join(" L")}"/>`;
    svg += `<path class="proj-line" d="M${x(el)},${y(cum[el - 1])} L${x(days)},${y(b.projected_spent)}"/>`;
    svg += `<circle class="today-dot" cx="${x(el)}" cy="${y(cum[el - 1])}" r="5"/><text class="lbl" x="${x(el) + 8}" y="${y(cum[el - 1]) - 8}">今日 ${yen(cum[el - 1])}</text>`;
  }
  for (let i = 0; i < days; i++) {
    const dt = D.fmt(start + i), pace = (budget * (i + 1)) / days;
    const tip = i < el ? `${md(dt)}|この日 ${yen(daily[i])}|累計 ${yen(cum[i])}|目安 ${yen(pace)}` : `${md(dt)}|目安 ${yen(pace)}`;
    svg += `<rect x="${x(i)}" y="${padT}" width="${x(1) - x(0)}" height="${H - padT - padB}" fill="transparent" data-tip="${esc(tip)}" data-sw="${i < el ? "--accent,--accent,--muted" : "--muted"}"/>`;
  }
  return `<div class="chart">${svg}</svg></div>
    <div class="flow-legend"><span><span class="sw" style="background:var(--accent)"></span>使った累計</span><span><span class="sw" style="background:var(--muted)"></span>点線＝予算どおりのペース</span><span><span class="sw" style="background:var(--critical)"></span>予算の上限</span></div>`;
}
function ring(ratio, status) {
  const r = 30, c = 2 * Math.PI * r, v = Math.max(0, Math.min(1, ratio));
  return `<svg class="ring ${status}" viewBox="0 0 76 76" role="img" aria-label="予算の残り ${Math.round(v * 100)}%"><circle class="track" cx="38" cy="38" r="${r}" fill="none" stroke-width="8"/>
    <circle class="val" cx="38" cy="38" r="${r}" fill="none" stroke-width="8" stroke-linecap="round" stroke-dasharray="${c * v} ${c}" transform="rotate(-90 38 38)"/>
    <text x="38" y="35" text-anchor="middle" class="face">${STATUS_FACE[status] || ""}</text><text x="38" y="53" text-anchor="middle">${Math.round(v * 100)}%</text></svg>`;
}
function donut(slices, total, c1 = "総資産", c3 = "") {
  const R = 80, r = 54, cx = 85, cy = 85;
  let a0 = -Math.PI / 2, out = "";
  const sum = slices.reduce((s, x) => s + x.value, 0) || 1;
  for (const sl of slices) {
    const sweep = Math.max((sl.value / sum) * 2 * Math.PI, 0.03), a1 = Math.min(a0 + sweep, a0 + 2 * Math.PI - 0.0001), large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (rad, ang) => `${cx + rad * Math.cos(ang)},${cy + rad * Math.sin(ang)}`;
    out += `<path d="M${p(R, a0)} A${R},${R} 0 ${large} 1 ${p(R, a1)} L${p(r, a1)} A${r},${r} 0 ${large} 0 ${p(r, a0)} Z" fill="var(${sl.color})" data-tip="${esc(sl.tip)}" data-sw="${sl.color}"/>`;
    a0 = a1;
  }
  return `<svg class="donut" viewBox="0 0 170 170" role="img" aria-label="総資産 ${yen(total)} の内訳">${out}<text class="c1" x="85" y="${c3 ? 72 : 78}" text-anchor="middle">${c1}</text><text class="c2" x="85" y="${c3 ? 94 : 100}" text-anchor="middle">${Math.abs(total) >= 100000 ? man(total) : yen(total)}</text>${c3 ? `<text class="c1" x="85" y="113" text-anchor="middle">${c3}</text>` : ""}</svg>`;
}
const ASSET_GROUPS = [["deposit", "預金・現金", "--series-1", ["bank", "cash"]], ["invest", "投資（NISA・特定口座）", "--series-2", ["securities", "nisa"]],
  ["pension", "年金（iDeCo・企業型DC）", "--series-3", ["ideco", "dc"]], ["emoney", "電子マネー", "--series-4", ["emoney"]], ["other", "ポイント・その他", "--series-5", ["other"]]];
function renderAssets(d, w) {
  const accs = d.accounts.filter((a) => Number(a.balance) > 0 && !LIAB.has(a.kind) && a.kind !== "card");
  const groups = ASSET_GROUPS.map(([k, label, color, kinds]) => {
    const items = accs.filter((a) => kinds.includes(a.kind)).sort((a, b) => b.balance - a.balance);
    return { k, label, color, items, value: items.reduce((s, a) => s + Number(a.balance), 0) };
  }).filter((g) => g.value > 0);
  const total = groups.reduce((s, g) => s + g.value, 0);
  if (!total) return `<p class="muted">口座の残高を入れると内訳が出ます。</p>`;
  const p = (v) => `${((v / total) * 100).toFixed(v / total < 0.1 ? 1 : 0)}%`;
  return `<div class="donut-wrap">${donut(groups.map((g) => ({ value: g.value, color: g.color, tip: `${g.label}|${yen(g.value)}（${p(g.value)}）` })), total)}
    <div class="asset-groups">${groups.map((g) => `<div class="asset-group"><div class="head"><span class="sw" style="background:var(${g.color})"></span><span>${esc(g.label)}<span class="p">${p(g.value)}</span>${g.k === "pension" ? '<span class="tag locked">60歳まで引出不可</span>' : ""}</span><span>${yen(g.value)}</span></div>
      ${g.items.map((a) => `<div class="acc">${avatar(a)}<span>${esc(a.name)}</span><span>${yen(a.balance)}</span></div>`).join("")}</div>`).join("")}
      <div class="asset-total"><span>総資産</span><span>${yen(total)}</span><span class="muted">借入（奨学金など）・カード未払い</span><span class="neg">−${yen(w.liability)}</span><span class="big">純資産</span><span class="big">${yen(total - w.liability)}</span></div></div></div>`;
}

// 右下の ＋ ボタンと入力シート（明細・口座・固定費・ほしいもの）
const SHEET_FOR_TAB = { dashboard: "sheet-tx", transactions: "sheet-tx", assets: "sheet-acc", recurring: "sheet-rec", wishlist: "sheet-wish" };
function openSheet(id, fresh) {
  const d = $("#" + id), f = d?.querySelector("form");
  if (!d) return;
  if (fresh && f) { f.reset(); const idf = f.elements.namedItem("id"); if (idf) idf.value = ""; f.dispatchEvent(new Event("change")); }
  fillIcons();
  if (!d.open) d.showModal();
}
$("#fab").addEventListener("click", () => openSheet(SHEET_FOR_TAB[currentTab] || "sheet-tx", true));
document.addEventListener("click", (e) => { const o = e.target.closest?.("[data-open]"); if (o) { e.preventDefault(); openSheet(o.dataset.open, true); } });
$$("dialog.form-sheet").forEach((d) => {
  d.addEventListener("click", (e) => { if (e.target.closest("[data-close]") || e.target === d) d.close(); });
  d.querySelector("form")?.addEventListener("reset", () => d.close());
});

document.addEventListener("click", (e) => {
  const v = e.target.closest?.("[data-spend-view]")?.dataset.spendView;
  if (!v) return;
  try { localStorage.setItem("spendView", v); } catch {}
  render();
});

// 純資産のカードを押すと総資産の内訳をポップアップで出す
let lastAssets = "";
function openAssets() { $("#asset-dialog-body").innerHTML = lastAssets; fillIcons(); $("#asset-dialog").showModal(); }
$("#hero-worth").addEventListener("click", openAssets);
$("#hero-worth").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openAssets(); } });
$("#asset-dialog").addEventListener("click", (e) => { if (e.target.closest("[data-close]") || e.target === e.currentTarget) e.currentTarget.close(); });

function renderDashboard() {
  renderTodos();
  fillIcons();
  const d = dashboard();
  const b = d.budget, w = d.net_worth;
  $("#onboarding").hidden = !(b.income === 0 || !d.accounts.some((a) => a.kind !== "card" && Number(a.balance)));
  $("#onboarding").innerHTML = `はじめに <a href="#" data-goto="settings">設定</a> で手取り月収を、<a href="#" data-goto="assets">口座・資産</a> で預金・NISA・iDeCo の残高を入れてください。${d.accounts.some((a) => a.kind === "card") ? "登録済みのカードはそのまま使えます。" : ""}`;

  let spendView = "budget";
  try { spendView = localStorage.getItem("spendView") || "budget"; } catch {}
  $("#hero-month").innerHTML = `<div class="row-between wrap spend-head"><div><div class="label">今月あと使えるお金 <span class="status ${b.status}">${STATUS_TEXT[b.status]}</span></div>
      <div class="value big ${b.remaining_all < 0 ? "neg" : b.remaining < 0 ? "warn-ink" : ""}">${yen(b.buffer ? b.remaining_all : b.remaining)}</div>
      <div class="sub">予算 ${yen(b.variable_budget)}${b.buffer ? ` ＋ 貯金枠 ${yen(b.buffer)}` : ""} のうち ${yen(b.spent)} 使用・${md(b.period.end)}の締めまで あと${b.period.days_left}日</div>
      ${b.status === "buffer" ? `<div class="buffer-note">⚠ 予算を超えて<b>貯金枠</b>を使っています。今月の貯金はあと <b>${yen(b.buffer_left)}</b>（${yen(b.buffer)} 中）</div>`
        : b.buffer && b.remaining >= 0 && b.remaining < b.variable_budget * 0.1 ? `<div class="buffer-note soft">もうすぐ貯金枠に入ります（予算の残り ${yen(b.remaining)}）</div>` : ""}</div>
    <div class="seg small-seg" role="group" aria-label="グラフの表示">
      <button type="button" data-spend-view="budget" aria-pressed="${spendView === "budget"}">予算に対して</button>
      <button type="button" data-spend-view="spent" aria-pressed="${spendView === "spent"}">使った内訳</button></div></div>`;
  $("#hero-today").innerHTML = `<div class="hero-top"><div><div class="label">今日あと使えるお金</div>
    <div class="value ${b.today_remaining < 0 ? "neg" : ""}">${yen(b.today_remaining)}</div></div><span class="badge">${ico("sun")}</span></div>
    <div class="calc">${yen((b.remaining > 0 || !b.buffer ? b.remaining : b.remaining_all) + b.today_spent)} ÷ ${b.period.days_left}日${b.today_spent ? ` − 今日 ${yen(b.today_spent)}` : ""}</div>
    <div class="sub">毎日この額までなら予算内で終われます</div>`;
  // 先月比と、貯金・積立・借入の返済で毎月どれだけ良くなるかの見込み
  const hist = d.history, curH = hist[hist.length - 1], prevH = hist[hist.length - 2];
  const delta = curH && prevH ? curH.net_worth - prevH.net_worth : null;
  const loans = d.accounts.filter((a) => a.kind === "loan" && Number(a.loan_total) > 0 && Number(a.balance) > 0);
  const principal = loans.reduce((x, a) => x + Math.max(0, (Number(a.loan_payment) || 0) - Math.round((Number(a.balance) * (Number(a.loan_rate) || 0)) / 100 / 12)), 0);
  const improve = (b.savings_goal || 0) + (b.investment_monthly || 0) + principal;
  const toPlus = w.net_worth < 0 && improve > 0 ? Math.ceil(-w.net_worth / improve) : null;
  const plusAt = toPlus ? (() => { const [y, m] = D.addM(...D.parts(D.today()).slice(0, 2), toPlus); return `${y}年${m}月`; })() : "";
  $("#hero-worth").innerHTML = `<div class="hero-top"><div><div class="label">純資産（NISA・iDeCo 含む）</div>
    <div class="value">${yen(w.net_worth)}</div></div><span class="badge">${ico("bank")}</span></div>
    ${delta != null ? `<div class="trend ${delta >= 0 ? "up" : "down"}">${delta >= 0 ? "▲" : "▼"} 先月より ${delta >= 0 ? "+" : "−"}${yen(Math.abs(delta))}</div>`
      : improve > 0 ? `<div class="trend up">▲ 毎月 約 +${yen(improve)} ずつ増える見込み</div>` : ""}
    ${toPlus ? `<div class="sub">このペースだと約${toPlus}か月（${plusAt}ごろ）でプラスに</div>` : ""}
    ${loans.map((a) => { const r = Math.min(1, 1 - Number(a.balance) / Number(a.loan_total)); return `<div class="loan-prog"><div class="row-between"><span>${esc(a.name)}の返済</span><b>${Math.round(r * 100)}% 済み</b></div>
      <div class="loan-bar" role="img" aria-label="${esc(a.name)} ${Math.round(r * 100)}% 返済済み"><span style="width:${r * 100}%"></span></div>
      <div class="sub">残り ${yen(a.balance)}${a.loan_end ? `・完済 ${esc(a.loan_end)}` : ""}</div></div>`; }).join("")}
    <div class="calc">総資産 ${yen(w.total_assets)} − 借入・カード未払い ${yen(w.liability)}</div>
    <div class="sub"><span class="more">内訳を見る ›</span></div>`;

  const budget = Math.max(b.variable_budget, 1);
  const cls = b.status === "ok" ? "" : b.status === "warning" ? "warning" : "over";
  const inc = Math.max(b.income, 1), flowParts = [["固定費", b.fixed_monthly, "--series-1"], ["積立・先取り貯金", b.investment_monthly + b.savings_goal, "--series-3"], ["使った", Math.max(0, b.spent), "--series-2"]];
  const restV = Math.max(0, b.remaining);
  const flowHtml = `<h2>${ico("pie")}今月の手取り ${yen(b.income)} の行き先</h2>
    <div class="flow" role="img" aria-label="手取りの内訳">${flowParts.filter(([, v]) => v > 0).map(([l, v, c]) => `<div style="flex:${v};background:var(${c})" data-tip="${l}|${yen(v)}（${pct(v / inc)}）" data-sw="${c}"></div>`).join("")}${restV ? `<div class="rest" style="flex:${restV}" data-tip="あと使える|${yen(restV)}（${pct(restV / inc)}）"></div>` : ""}</div>
    <div class="flow-legend">${flowParts.map(([l, v, c]) => `<span><span class="sw" style="background:var(${c})"></span>${l}<b>${yen(v)}</b></span>`).join("")}<span><span class="sw" style="background:var(--surface-2);box-shadow:inset 0 0 0 1px var(--border)"></span>あと使える<b>${yen(restV)}</b></span></div>`;
  $("#pace-card").innerHTML = flowHtml + `<div class="row-between wrap pace-head"><h2>${ico("gauge")}使ったペース</h2>
      <span class="pace-verdict ${b.status}">${b.projected_surplus >= 0 ? `このままだと締めで <b>${yen(b.projected_surplus)}</b> 余る` : b.buffer && -b.projected_surplus <= b.buffer ? `このままだと貯金枠から <b>${yen(-b.projected_surplus)}</b> 使う見込み` : `このままだと <b>${yen(-b.projected_surplus - b.buffer)}</b> 足りない`}</span></div>
    ${renderCumChart(b)}${b.reimbursed ? `<p class="small muted">立替の精算 ${yen(b.reimbursed)} を差し引き済み</p>` : ""}`;

  const alerts = [];
  for (const p of d.payment_checks) if (p.shortfall > 0) alerts.push(["", `<b>${esc(p.account)}</b> の残高 ${yen(p.balance)} に対し、1か月以内に ${yen(p.due_amount)} の引き落とし予定。<b>${yen(p.shortfall)} 不足</b>しています。`]);
  if (b.status === "deficit") alerts.push(["", "固定費・積立・先取り貯金の合計が収入を超えています。固定費か積立額の見直しが必要です。"]);
  for (const c of b.categories) if (c.budget && c.spent > c.budget) alerts.push(["warn", `<b>${esc(c.category)}</b> が予算 ${yen(c.budget)} を ${yen(c.spent - c.budget)} 超えています。`]);
  for (const c of d.cards) if (c.limit_usage > 0.8) alerts.push(["warn", `<b>${esc(c.name)}</b> の利用枠を ${pct(c.limit_usage)} 使っています。`]);
  $("#alerts").innerHTML = alerts.map(([k, m]) => `<div class="alert ${k}"><span class="icon">${k ? "!" : "⚠"}</span><div>${m}</div></div>`).join("");

  const cats = b.categories.filter((c) => c.spent > 0 || c.budget);
  const gross = cats.reduce((x, c) => x + c.spent, 0);
  const slices = []; let other = 0;
  for (const c of cats) if (c.spent > 0) { if (CAT_SLOT[c.category]) slices.push({ value: c.spent, color: catColor(c.category).slice(4, -1), tip: `${c.category}|${yen(c.spent)}（${pct(c.spent / gross)}）` }); else other += c.spent; }
  if (other) slices.push({ value: other, color: "--series-other", tip: `その他のカテゴリ|${yen(other)}（${pct(other / gross)}）` });
  const byBudget = spendView === "budget" && b.variable_budget > 0;
  const restB = Math.max(0, b.remaining);
  if (byBudget && restB) slices.push({ value: restB, color: "--track", tip: `あと使える|${yen(restB)}（予算の ${pct(restB / b.variable_budget)}）`, track: true });
  if (byBudget && b.buffer_left) slices.push({ value: b.buffer_left, color: "--buffer", tip: `貯金枠の残り|${yen(b.buffer_left)}（${yen(b.buffer)} 中）`, track: true });
  const share = (v) => pct(v / Math.max(1, byBudget ? b.variable_budget : gross));
  $("#cat-chart").innerHTML = gross > 0 || byBudget ? `<div class="donut-wrap spend">${byBudget ? donut(slices, b.buffer ? b.remaining_all : b.remaining, "あと使える", `予算 ${man(b.variable_budget + b.buffer)}`) : donut(slices, b.spent, "使った")}
    <div class="cat-list">${cats.filter((c) => c.spent > 0).map((c) => `<div class="cat-row" data-tip="${esc(c.category)}|${yen(c.spent)}（${pct(c.spent / gross)}）">${catIcon(c.category)}
      <span class="nm">${esc(c.category)}</span><span class="bar"><span style="width:${(c.spent / cats[0].spent) * 100}%;background:${catColor(c.category)}"></span></span><span class="amt">${yen(c.spent)}</span><span class="pct">${share(c.spent)}</span></div>`).join("")}
      ${b.reimbursed ? `<div class="cat-row muted small"><span></span><span class="nm">立替の精算（受け取り）</span><span></span><span class="amt">−${yen(b.reimbursed)}</span><span></span></div>` : ""}
      ${byBudget && (restB > 0 || !b.buffer) ? `<div class="cat-row rest"><span class="cat-ico" style="--c:var(--track)" aria-hidden="true">✓</span><span class="nm">あと使える</span><span class="bar"><span style="width:${Math.min(100, (restB / Math.max(1, cats[0]?.spent || restB)) * 100)}%;background:var(--track-ink)"></span></span><span class="amt">${yen(restB)}</span><span class="pct">${share(restB)}</span></div>` : ""}
      ${byBudget && b.buffer ? `<div class="cat-row rest"><span class="cat-ico" style="--c:var(--buffer)" aria-hidden="true">🐷</span><span class="nm">貯金枠の残り</span><span class="bar"><span style="width:${(b.buffer_left / b.buffer) * 100}%;background:var(--buffer)"></span></span><span class="amt">${yen(b.buffer_left)}</span><span class="pct">${pct(b.buffer_left / b.buffer)}</span></div>` : ""}
      <div class="cat-foot"><a href="#" class="small" data-goto="transactions">明細を見る ›</a></div></div></div>`
    : `<p class="muted">今期の支出はまだありません。右下の ＋ から記録するか、カードの CSV を取り込んでください。</p>`;

  $("#cards-list").innerHTML = d.cards.length ? `<div class="list">${d.cards.map((c) => `
    <div class="item"><div class="with-av">${avatar(c)}<div><div class="title">${esc(c.institution || c.name)}</div>
      <div class="meta">今の利用分 ${yen(c.current_cycle.amount)}（${md(c.current_cycle.end)}締め）</div></div></div>
      <div class="right"><div>${md(c.next_payment.date)} 引き落とし</div>
      <div class="title">${yen(c.next_payment.amount)}${c.next_payment.source === "email" ? '<span class="tag">メールで確定</span>' : c.next_payment.confirmed ? '<span class="tag">明細から推定</span>' : '<span class="tag">利用中</span>'}</div>
      ${c.next_payment.source === "email" && c.next_payment.amount - c.next_payment.tracked_amount > 1000 ? `<div class="meta">取り込んだ明細より ${yen(c.next_payment.amount - c.next_payment.tracked_amount)} 多い</div>` : ""}
      ${c.limit ? `<div class="meta">枠 ${pct(c.limit_usage)} 使用</div>` : ""}</div></div>`).join("")}</div>`
    : `<p class="muted">カードが未登録です。<a href="#" data-goto="assets">登録する</a></p>`;

  lastAssets = `${renderAssets(d, w)}
    ${w.investments.length ? `<h3>運用成績</h3><div class="list">${w.investments.map((i) => `<div class="item"><div><div class="title">${esc(i.name)}</div><div class="meta">元本 ${yen(i.contributed)}</div></div><div class="right"><div>${yen(i.balance)}</div>${i.gain != null ? `<div class="meta ${i.gain < 0 ? "neg" : ""}">${i.gain >= 0 ? "+" : ""}${yen(i.gain)}（${i.gain_ratio != null ? (i.gain_ratio * 100).toFixed(1) : "-"}%）</div>` : ""}</div></div>`).join("")}</div>` : ""}
    <p class="small muted">生活防衛資金: すぐ使えるお金は生活費の <b>${d.emergency_fund.months_covered != null ? d.emergency_fund.months_covered.toFixed(1) : "-"}</b> か月分（目標 ${d.emergency_fund.target_months} か月 = ${yen(d.emergency_fund.target_amount)}）</p>`;
  if ($("#asset-dialog").open) $("#asset-dialog-body").innerHTML = lastAssets;

  const byId = Object.fromEntries(d.accounts.map((a) => [a.id, a]));
  const upcoming = [...b.recurring.upcoming.filter((u) => byId[u.account_id]?.kind !== "card").map((u) => ({ ...u, label: REC_LABELS[u.kind] })),
    ...d.cards.filter((c) => D.parse(c.next_payment.date) - D.today() <= 31).map((c) => ({ date: c.next_payment.date, name: c.institution || c.name, amount: c.next_payment.amount, label: "カード" }))]
    .sort((a, b2) => a.date.localeCompare(b2.date));
  $("#upcoming").innerHTML = upcoming.length ? `<div class="list">${upcoming.map((u) => `<div class="item"><div><span class="title">${esc(u.name)}</span><span class="tag">${u.label}</span>${u.variable ? '<span class="tag">変動</span>' : ""}<div class="meta">${md(u.date)}</div></div><div class="right">${u.variable ? "約" : ""}${yen(u.amount)}</div></div>`).join("")}</div>`
    : `<p class="muted">1か月以内の引き落とし予定はありません。</p>`;

  $("#worth-card").hidden = d.history.length < 2;
  if (d.history.length >= 2) renderWorthChart($("#worth-chart"), d.history);
  $("#wish-card").hidden = !d.wishlist.length;

  const rk = b.recurring.monthly_by_kind;
  $("#recurring-summary").innerHTML = `<div class="legend">${Object.entries(REC_LABELS).map(([k, l]) => `<div class="item"><span></span><span>${l}</span><span class="amt">${yen(rk[k] || 0)}</span></div>`).join("")}
    <div class="item"><span></span><b>合計</b><b class="amt">${yen(b.recurring.monthly_total)}</b></div></div>
    <p class="small muted">サブスク ${b.recurring.subscription_count} 件で年間 ${yen(b.recurring.subscription_yearly)}。<a href="#" data-goto="recurring">一覧を見る</a></p>`;

  $("#wish-summary").innerHTML = d.wishlist.length ? `<div class="list">${d.wishlist.slice(0, 5).map((it) => `
    <div class="item"><div><div class="title">${esc(it.name)}</div><div class="meta verdict-${it.verdict}">${VERDICT_TEXT[it.verdict]}${it.months_to_save ? `・貯めるなら約${it.months_to_save}か月` : ""}</div></div>
    <div class="right">${yen(it.price)}${it.saved ? `<div class="meta">あと ${yen(it.need)}</div>` : ""}</div></div>`).join("")}</div>`
    : `<p class="muted">ほしいものはまだありません。<a href="#" data-goto="wishlist">追加する</a></p>`;
}

function renderWorthChart(el, history) {
  if (!history.length) { el.innerHTML = `<p class="muted">口座の残高を更新するたびに記録され、ここに月ごとの推移が表示されます。</p>`; return; }
  const series = [["liquid", "預金・現金", "--series-1"], ["invest", "投資", "--series-2"], ["pension", "年金", "--series-3"], ["other", "その他", "--series-5"]].filter(([k]) => history.some((h) => h[k] > 0));
  const W = Math.max(300, Math.min(1100, (el.clientWidth || 760))), H = 240, padL = 44, padR = 8, padT = 10, padB = 24;
  const maxV = Math.max(1, ...history.map((h) => series.reduce((s, [k]) => s + h[k], 0)));
  const mag = Math.pow(10, Math.floor(Math.log10(maxV)));
  const step = mag * (maxV / mag > 5 ? 2 : 1);
  const top = Math.ceil(maxV / step) * step;
  const y = (v) => padT + (H - padT - padB) * (1 - v / top);
  const band = (W - padL - padR) / history.length, bw = Math.min(36, band * 0.7);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="純資産の推移"><g class="axis">`;
  for (let v = 0; v <= top; v += step) svg += `<line class="grid-line" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/><text x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">${man(v)}</text>`;
  history.forEach((h, i) => { if (history.length <= 12 || i % 2 === 0) svg += `<text x="${padL + band * i + band / 2}" y="${H - 6}" text-anchor="middle">${+h.month.slice(5)}月</text>`; });
  svg += `</g>`;
  history.forEach((h, i) => {
    const x = padL + band * i + (band - bw) / 2;
    let acc = 0;
    const segs = series.filter(([k]) => h[k] > 0);
    segs.forEach(([k, , v], j) => {
      const y0 = y(acc), y1 = y(acc + h[k]);
      acc += h[k];
      const gap = j > 0 ? 2 : 0, hgt = Math.max(0, y0 - y1 - gap);
      svg += j === segs.length - 1 && hgt > 4
        ? `<path d="M${x},${y0 - gap} v${-hgt + 4} q0,-4 4,-4 h${bw - 8} q4,0 4,4 v${hgt - 4} z" fill="var(${v})"/>`
        : `<rect x="${x}" y="${y1}" width="${bw}" height="${hgt}" fill="var(${v})"/>`;
    });
    const tip = [`${h.month.replace("-", "年")}月`, ...series.map(([k, l]) => `${l} ${yen(h[k])}`), `負債 −${yen(h.liability)}`, `純資産 ${yen(h.net_worth)}`].join("|");
    svg += `<rect x="${padL + band * i}" y="${padT}" width="${band}" height="${H - padT - padB}" fill="transparent" data-tip="${esc(tip)}" data-sw="${series.map(([, , v]) => v).join(",")}"/>`;
  });
  el.innerHTML = svg + `</svg><div class="legend inline-legend">${series.map(([, l, v]) => `<div class="item"><span class="sw" style="background:var(${v})"></span><span>${l}</span></div>`).join("")}</div>`;
}

const tooltip = $("#tooltip");
document.addEventListener("pointermove", (e) => {
  const t = e.target.closest?.("[data-tip]");
  if (!t) { tooltip.hidden = true; return; }
  const [head, ...rest] = t.dataset.tip.split("|");
  const sws = (t.dataset.sw || "").split(",").filter(Boolean);
  tooltip.innerHTML = `<b>${esc(head)}</b>` + rest.map((r, i) => `<div class="tt-row"><span class="sw" style="${sws[i] ? `background:var(${sws[i]})` : ""}"></span><span>${esc(r)}</span><span></span></div>`).join("");
  tooltip.hidden = false;
  tooltip.style.left = `${Math.min(e.clientX + 14, window.innerWidth - tooltip.offsetWidth - 8)}px`;
  tooltip.style.top = `${Math.min(e.clientY + 14, window.innerHeight - tooltip.offsetHeight - 8)}px`;
});

$("#quick-advice").addEventListener("click", (e) => ask("", $("#quick-advice-out"), e.target));

// ------------------------------------------------------------------ 明細
const txForm = $("#tx-form");
const thisMonth = () => D.fmt(D.today()).slice(0, 7);
// 明細は「給料日〜締め」の期間ごとに見る（ダッシュボードの「今月」と同じ区切り）
const cycleDay = () => settings().cycle_start_day;
let txWant = null;
function setTxPeriodFor(dateStr) { txWant = D.fmt(periodBounds(D.parse(dateStr), cycleDay())[0]); }
function fillPeriodOptions() {
  const sel = $("#tx-month"), prev = sel.value, today = D.today();
  const opts = [periodBounds(today, cycleDay()), ...previousPeriods(today, cycleDay(), 12)];
  sel.innerHTML = opts.map(([a, b], i) => `<option value="${D.fmt(a)}">${md(D.fmt(a))}〜${md(D.fmt(b - 1))}${i === 0 ? "（今期）" : ""}</option>`).join("");
  const want = txWant || prev;
  sel.value = opts.some(([a]) => D.fmt(a) === want) ? want : D.fmt(opts[0][0]);
  txWant = null;
}
const txPeriod = () => { const [a, b] = periodBounds(D.parse($("#tx-month").value || D.fmt(D.today())), cycleDay()); return [a, b]; };
if (!txForm.date.value) txForm.date.value = D.fmt(D.today());

async function onMonthChange() { const [a, b] = txPeriod(); await ensureMonths([D.ym(D.fmt(a)), D.ym(D.fmt(b - 1))]); render(); }
$("#tx-month").addEventListener("change", onMonthChange);
$("#tx-account").addEventListener("change", render);
$("#tx-search").addEventListener("input", render);

function renderTxTable() {
  fillPeriodOptions();
  const [pa, pb] = txPeriod();
  const acc = $("#tx-account").value;
  const q = $("#tx-search").value.trim().toLowerCase();
  const rows = allTx().filter((t) => inRange(t.date, pa, pb) && (!acc || t.account_id === acc) && (!q || `${t.description} ${t.category} ${t.memo || ""}`.toLowerCase().includes(q)))
    .sort((a, b) => b.date.localeCompare(a.date));
  const accName = (id) => accounts().find((a) => a.id === id)?.name || "";
  const recName = (id) => recurring().find((r) => r.id === id)?.name || "";
  const exp = rows.filter((t) => t.type === "expense").reduce((s, t) => s + t.amount, 0);
  const inc = rows.filter((t) => t.type === "income").reduce((s, t) => s + t.amount, 0);
  $("#tx-total").innerHTML = `<span>${rows.length} 件</span><span class="neg-ink">支出 ${yen(exp)}</span><span class="pos-ink">収入 ${yen(inc)}</span>`;
  const byDay = {};
  for (const t of rows) (byDay[t.date] ||= []).push(t);
  const WD = "月火水木金土日";
  $("#tx-table").innerHTML = rows.length ? Object.entries(byDay).map(([d, ts]) => `<div class="day-head">${md(d)}（${WD[D.weekday(D.parse(d))]}）</div>
    <div class="tx-list">${ts.map((t) => { const a = accounts().find((x) => x.id === t.account_id) || S.accounts.items.find((x) => x.id === t.account_id);
      const rowC = t.type === "transfer" ? "var(--muted)" : t.type === "income" ? "var(--good)" : catColor(t.category);
      return `<div class="tx-row" style="--c:${rowC}">${t.type === "transfer" ? '<span class="cat-ico" style="--c:var(--muted)" aria-hidden="true">⇄</span>' : t.type === "income" ? '<span class="cat-ico" style="--c:var(--good)" aria-hidden="true">💰</span>' : merchantBadge(t.description) || catIcon(t.category)}
      <div class="tx-main"><div class="tx-desc">${esc(t.description)}</div>
        <div class="tx-meta">${esc(t.category)}${a ? `<span class="sep">·</span>${accDot(a)}` : ""}${t.recurring_id ? `<span class="tag">固定費</span>` : ""}${t.own_share === 0 || isCompanyPaid(t) ? `<span class="tag">会社精算</span>` : t.own_share != null && t.own_share < t.amount ? `<span class="tag">自分の分 ${yen(t.own_share)}</span>` : ""}${t.source === "gmail" ? '<span class="tag">メール</span>' : ""}</div>
        ${t.memo ? `<div class="tx-memo">${esc(t.memo)}</div>` : ""}</div>
      <div class="tx-amt ${t.type}">${t.type === "income" ? "+" : t.type === "transfer" ? "" : "−"}${yen(t.amount)}
        <div class="tx-act"><button class="link-btn" data-edit-tx="${esc(t.id)}" type="button">編集</button><button class="link-btn danger" data-del-tx="${esc(t.id)}" type="button">${pendingDelete === t.id ? "本当に削除" : "削除"}</button></div></div></div>`; }).join("")}</div>`).join("")
    : `<p class="muted">この期間の明細はありません。右下の ＋ から記録するか、カードの CSV を取り込んでください。</p>`;
}

// confirm() が使えないので、削除はボタンを 2 回押して確定する
let pendingDelete = null;
function armDelete(id) {
  if (pendingDelete === id) { pendingDelete = null; return true; }
  pendingDelete = id;
  render();
  setTimeout(() => { if (pendingDelete === id) { pendingDelete = null; render(); } }, 4000);
  return false;
}

$("#tx-table").addEventListener("click", (e) => {
  const edit = e.target.dataset.editTx, del = e.target.dataset.delTx;
  if (edit) { const [ym, i] = findTx(edit); if (ym) fillForm(txForm, S.tx[ym][i]); }
  if (del && armDelete(del)) {
    const [ym, i] = findTx(del);
    if (ym) { S.tx[ym].splice(i, 1); save("tx/" + ym); toast("削除しました"); render(); }
  }
});

txForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = formData(txForm);
  if (!f.date || !(f.amount > 0)) { toast("日付と金額を入れてください"); return; }
  const own = f.own_share != null && f.own_share >= 0 && f.own_share < f.amount ? Math.round(f.own_share) : null;
  const tx = { date: f.date, amount: Math.round(f.amount), own_share: own, type: f.type || "expense", category: f.category || (f.type === "income" ? "収入" : guessCategory(f.description)),
    account_id: f.account_id || null, description: f.description, memo: f.memo, recurring_id: f.recurring_id || (f.type === "expense" ? matchRecurring(f.description, Math.round(f.amount)) : null) };
  await ensureMonths([D.ym(f.date)]);
  if (f.id) {
    const [ym, i] = findTx(f.id);
    if (ym) {
      const old = S.tx[ym][i];
      S.tx[ym].splice(i, 1);
      if (ym !== D.ym(f.date)) save("tx/" + ym);
      (S.tx[D.ym(f.date)] ||= []).push({ ...old, ...tx, recurring_id: f.recurring_id || null });
    }
  } else {
    addTx({ ...tx, source: "manual" });
  }
  save("tx/" + D.ym(f.date));
  toast("保存しました");
  const keep = txForm.date.value;
  txForm.reset();
  idField(txForm).value = "";
  txForm.date.value = keep;
  setTxPeriodFor(keep);
  render();
});
txForm.addEventListener("click", (e) => {
  if (e.target.dataset.company != null) { txForm.own_share.value = 0; toast("会社精算（自分の負担 0円）にしました"); return; }
  const n = Number(e.target.dataset.split);
  if (!n) return;
  const amount = Number(txForm.amount.value);
  if (!(amount > 0)) { toast("先に金額を入れてください"); return; }
  txForm.own_share.value = Math.round(amount / n);
});
txForm.addEventListener("reset", () => setTimeout(() => { idField(txForm).value = ""; if (!txForm.date.value) txForm.date.value = D.fmt(D.today()); }));

const csvForm = $("#csv-form");
// メール由来の明細（利用通知・購入メール）と CSV の同じ利用を探す。
// 購入メールの日付は受信日なので CSV の利用日と数日ずれる。カード不明（口座なし）の購入メールも対象
function findMailTwin(it, accountId) {
  const cands = allTx().filter((t) => (t.source === "gmail" || t.source === "receipt") && t.amount === it.amount && t.type === it.type &&
    ((t.account_id || null) === accountId || (t.source === "receipt" && !t.account_id)) &&
    Math.abs(D.parse(t.date) - D.parse(it.date)) <= (t.source === "receipt" ? 5 : 3));
  return cands.sort((a, b) => Math.abs(D.parse(a.date) - D.parse(it.date)) - Math.abs(D.parse(b.date) - D.parse(it.date)))[0] || null;
}

// 同じ店名に前に付けた（または直した）カテゴリ。新しい明細ほど優先
function learnedCategory(desc) {
  const key = kanaKey(cleanShop(desc));
  let hit = null;
  for (const t of [...allTx()].sort((a, b) => a.date.localeCompare(b.date)))
    if (t.category && t.category !== "未分類" && !t.recurring_id && kanaKey(cleanShop(t.description)) === key) hit = t.category;
  return hit;
}

async function importCsv(buf, accountId, dryRun) {
  const items = parseCsv(buf);
  if (!items.length) return { items, inserted: 0, skipped: 0, merged: 0 };
  if (items.format === "paypay" && !accountId) accountId = (accounts().find((a) => /paypay/i.test(a.name)) || {}).id || null;
  await ensureMonths(items.map((it) => D.ym(it.date)));
  const hashes = new Set(allTx().map((t) => t.h).filter(Boolean));
  // 同じ店名に前に付けた（または直した）カテゴリを引き継ぐ。新しい明細ほど優先
  const learned = {};
  for (const t of [...allTx()].sort((a, b) => a.date.localeCompare(b.date)))
    if (t.category && t.category !== "未分類" && !t.recurring_id) learned[kanaKey(cleanShop(t.description))] = t.category;
  for (const it of items) { const c = learned[kanaKey(it.description)]; if (c && it.type === "expense") it.category = c; }
  const occ = {};
  let inserted = 0, skipped = 0, merged = 0;
  const touched = new Set();
  const added = [];
  for (const it of items) {
    const key = `${it.date}|${it.amount}|${it.type}|${it.description}`;
    const h = `${accountId}|${key}|${(occ[key] = (occ[key] || 0) + 1) - 1}`;
    if (hashes.has(h)) { skipped++; continue; }
    hashes.add(h);
    // メールで先に入っていた同じ利用は、CSV の内容で置き換える（メールの方が分かりやすい内容とカテゴリは残す）
    const dup = findMailTwin(it, accountId);
    if (dup) {
      merged++;
      if (!dryRun) {
        const [ym, i] = findTx(dup.id);
        S.tx[ym].splice(i, 1);
        touched.add(ym);
        const { id: _old, ...rest } = dup;
        // 速報版メールの「楽天カードのご利用」のように店名がない明細は、CSV の店名に置き換える
        const genericMail = !dup.description || /のご利用$/.test(dup.description);
        if (genericMail) rest.description = it.description;
        touched.add(addTx({ ...rest, date: it.date, account_id: accountId, memo: genericMail ? dup.memo : [dup.memo, `明細: ${it.description}`].filter(Boolean).join(" / "),
          category: dup.category === "未分類" ? it.category : dup.category, recurring_id: dup.recurring_id || matchRecurring(it.description, it.amount) || matchRecurring(dup.description, it.amount), source: "csv", h }));
      }
      continue;
    }
    inserted++;
    if (!dryRun) {
      const recId = it.type === "expense" ? matchRecurring(it.description, it.amount) : null;
      const rec = recId && recurring().find((r) => r.id === recId);
      // 固定費と照合できたら、その固定費のカテゴリを使う（楽天証券投信積立 → 投資 など）
      const category = it.category === "未分類" && rec ? rec.category || REC_LABELS[rec.kind] : it.category;
      const tx = { ...it, category, account_id: accountId, recurring_id: recId, source: "csv", h };
      touched.add(addTx(tx));
      added.push(tx);
    }
  }
  let aiCategorized = 0;
  if (!dryRun) aiCategorized = await aiCategorize(allTx().filter((t) => t.source === "csv" && t.category === "未分類" && hashes.has(t.h)), touched);
  for (const ym of touched) save("tx/" + ym);
  if (!dryRun && accountId) { S.settings = { ...settings(), last_csv: { ...(settings().last_csv || {}), [accountId]: D.fmt(D.today()) } }; save("settings"); }
  return { items, inserted, skipped, merged, aiCategorized };
}

// ルールで分からなかった店名（ｶﾝﾀﾞｹﾞｷｼﾞﾖｳ など）を Claude にまとめて分類してもらう
async function aiCategorize(txs, touched) {
  if (!txs.length) return 0;
  const sample = await claude.use("sample");
  if (!sample) return 0;
  const names = [...new Set(txs.map((t) => t.description))].slice(0, 80);
  const cats = ALL_CATEGORIES();
  try {
    const out = await sample.json(`カード明細の店名（半角カナや略称）を家計簿のカテゴリに分類してください。JSON オブジェクトだけを返します: {"店名": "カテゴリ", ...}
カテゴリは次から 1 つ: ${cats.join("、")}。見当がつかない店名は「その他」。
店名:
${names.map((n) => "- " + n).join("\n")}`, { modelTier: "default", cache: false });
    let n = 0;
    for (const t of txs) {
      const c = out && typeof out === "object" ? out[t.description] : null;
      if (c && cats.includes(c) && c !== "その他") { t.category = c; touched.add(D.ym(t.date)); n++; }
    }
    return n;
  } catch { return 0; }
}

async function uploadCsv(dryRun) {
  const file = csvForm.file.files[0];
  if (!file) { toast("ファイルを選んでください"); return; }
  const r = await importCsv(new Uint8Array(await file.arrayBuffer()), csvForm.account_id.value || null, dryRun);
  if (!r.items.length) { $("#csv-result").innerHTML = `<p class="neg">明細を読み取れませんでした。日付・金額・内容の列がある CSV か確認してください。</p>`; return; }
  $("#csv-result").innerHTML = `<p>${r.items.length} 件を読み取り、${dryRun ? "取り込み対象" : "取り込み"} ${r.inserted} 件／重複スキップ ${r.skipped} 件${r.merged ? `／メールで取り込み済みの明細と統合 ${r.merged} 件` : ""}${r.aiCategorized ? `／AI がカテゴリを判定 ${r.aiCategorized} 件` : ""}</p>
    <div class="table-wrap"><table><tbody>${r.items.slice(0, 10).map((p) => `<tr><td>${p.date}</td><td class="desc">${esc(p.description)}</td><td>${esc(p.category)}</td><td class="num">${p.type === "income" ? "+" : p.type === "transfer" ? "⇄ " : ""}${yen(p.amount)}</td></tr>`).join("")}</tbody></table></div>
    ${r.items.length > 10 ? `<p class="small muted">先頭 10 件を表示</p>` : ""}`;
  if (!dryRun) { toast(`${r.inserted} 件取り込みました`); if (r.items[0]) setTxPeriodFor(r.items.map((x) => x.date).sort().pop()); render(); }
}
$("#csv-preview").addEventListener("click", () => uploadCsv(true));
csvForm.addEventListener("submit", (e) => { e.preventDefault(); uploadCsv(false); });

// ------------------------------------------------------------------ Gmail パネル
const GMAIL_STATUS = { imported: "明細に追加", receipt: "購入メールから追加", merged: "既存の明細と同じ", bill: "請求額を反映", no_account: "カード未登録", ignored: "対象外" };
function renderGmail() {
  const last = S.mail.lastSync, sum = last?.summary, st = settings();
  $("#gmail-status").innerHTML = syncing ? `<p>取り込み中です…</p>` : last
    ? `<p class="${last.ok ? "muted" : "neg"}">前回 ${esc(new Date(last.at).toLocaleString("ja-JP"))}：${last.ok
      ? `明細 ${sum.imported + (sum.receipts || 0)} 件追加（うち購入メールから ${sum.receipts || 0} 件）・請求額 ${sum.bills} 件反映${sum.merged ? `・重複 ${sum.merged} 件` : ""}${sum.no_account ? `・<b>カード未登録 ${sum.no_account} 件</b>` : ""}${last.note ? ` ${esc(last.note)}` : ""}`
      : esc(last.error)}</p>`
    : `<p class="muted">まだ取り込んでいません。「今すぐ取り込む」を押すと、Gmail の利用を許可する確認が出ます。</p>`;
  $("#gmail-sync").disabled = syncing;
  const f = $("#gmail-settings");
  if (document.activeElement?.form !== f) {
    f.gmail_auto.checked = !!st.gmail_auto; f.gmail_interval_min.value = st.gmail_interval_min; f.gmail_lookback_days.value = st.gmail_lookback_days;
    f.receipts_enabled.checked = st.receipts_enabled !== false; f.receipt_account_id.value = st.receipt_account_id || "";
  }
  const rows = S.mail.log.slice(0, 30);
  $("#gmail-log").innerHTML = rows.length ? `<thead><tr><th>受信</th><th>件名</th><th>結果</th></tr></thead><tbody>` +
    rows.map((r) => `<tr><td>${esc(r.date)}</td><td class="desc">${esc(r.subject)}<div class="muted small">${esc(r.sender)}</div></td><td class="desc"><span class="st-${r.status}">${GMAIL_STATUS[r.status] || r.status}</span>${r.detail ? `<div class="muted small">${esc(r.detail)}</div>` : ""}</td></tr>`).join("") + "</tbody>"
    : `<tbody><tr><td class="muted">履歴はまだありません。</td></tr></tbody>`;
}
$("#gmail-sync").addEventListener("click", () => syncGmail());
$("#gmail-settings").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.target;
  S.settings = { ...settings(), gmail_auto: f.gmail_auto.checked, gmail_interval_min: Math.max(5, Number(f.gmail_interval_min.value) || 60), gmail_lookback_days: Math.max(1, Number(f.gmail_lookback_days.value) || 45),
    receipts_enabled: f.receipts_enabled.checked, receipt_account_id: f.receipt_account_id.value || "" };
  save("settings");
  toast("保存しました");
});

// ------------------------------------------------------------------ 口座・資産
const accForm = $("#account-form");
function syncAccountFields() {
  const kind = accForm.kind.value;
  $$(".card-only", accForm).forEach((el) => (el.hidden = kind !== "card"));
  $$(".not-card", accForm).forEach((el) => (el.hidden = kind === "card"));
  $$(".invest-only", accForm).forEach((el) => (el.hidden = !["nisa", "ideco", "dc", "securities"].includes(kind)));
}
accForm.addEventListener("change", syncAccountFields);
syncAccountFields();

function renderAccounts() {
  syncAccountFields();
  const groups = {};
  for (const a of accounts()) (groups[a.kind] ||= []).push(a);
  $("#account-list").innerHTML = Object.keys(KIND_LABELS).filter((k) => groups[k]).map((k) => `<h3>${KIND_LABELS[k]}</h3><div class="list">${groups[k].map((a) => `
    <div class="item"><div class="with-av">${avatar(a)}<div><div class="title">${esc(a.name)}${PENSION.has(a.kind) ? '<span class="tag locked">60歳まで引出不可</span>' : ""}</div>
      <div class="meta">${esc(a.institution || "")}${a.kind === "card" ? `　${a.closing_day === 31 ? "月末" : a.closing_day + "日"}締め・翌月${a.payment_day}日払い` : a.updated_at ? `　更新 ${esc(a.updated_at)}` : "　残高未入力"}</div></div></div>
      <div class="right">${a.kind === "card" ? (a.card_limit ? `枠 ${yen(a.card_limit)}` : "") : `<div class="title">${a.kind === "loan" ? "−" : ""}${yen(a.balance)}</div>${a.contributed != null ? `<div class="meta">元本 ${yen(a.contributed)}</div>` : ""}`}
        <div><button class="link-btn" data-edit-acc="${esc(a.id)}" type="button">編集</button><button class="link-btn danger" data-del-acc="${esc(a.id)}" type="button">${pendingDelete === a.id ? "本当に削除" : "削除"}</button></div></div></div>`).join("")}</div>`).join("")
    || `<p class="muted">まだ登録がありません。銀行口座・カード・NISA・iDeCo などを登録しましょう。</p>`;
}
$("#account-list").addEventListener("click", (e) => {
  const edit = e.target.dataset.editAcc, del = e.target.dataset.delAcc;
  if (edit) { fillForm(accForm, S.accounts.items.find((a) => a.id === edit)); syncAccountFields(); }
  if (del && armDelete(del)) { const a = S.accounts.items.find((x) => x.id === del); if (a) { a.archived = true; save("accounts"); toast("削除しました（明細は残ります）"); render(); } }
});
accForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const f = formData(accForm);
  if (!f.name) { toast("名前を入れてください"); return; }
  const today = D.fmt(D.today());
  const data = { name: f.name, kind: f.kind, institution: f.institution, balance: Math.round(f.balance || 0), contributed: f.contributed ?? null, note: f.note,
    closing_day: f.closing_day, payment_day: f.payment_day, payment_account_id: f.payment_account_id || null, card_limit: f.card_limit ?? null, email_keyword: f.email_keyword || "" };
  let a = f.id && S.accounts.items.find((x) => x.id === f.id);
  if (a) Object.assign(a, data); else { a = { id: uid(), history: [], ...data }; S.accounts.items.push(a); }
  if (a.kind !== "card") {
    a.updated_at = today;
    a.history = [...(a.history || []).filter((h) => h.date !== today), { date: today, balance: a.balance, contributed: a.contributed }].slice(-120);
  }
  save("accounts");
  toast("保存しました");
  accForm.reset();
  idField(accForm).value = "";
  render();
});
accForm.addEventListener("reset", () => setTimeout(() => { idField(accForm).value = ""; syncAccountFields(); }));

// ------------------------------------------------------------------ 固定費・サブスク
const recForm = $("#recurring-form");
const syncRecFields = () => $$(".yearly-only", recForm).forEach((el) => (el.hidden = !["yearly", "quarterly"].includes(recForm.cycle.value)));
recForm.addEventListener("change", syncRecFields);
syncRecFields();

function renderRecurring() {
  syncRecFields();
  const groups = {};
  for (const r of recurring()) (groups[r.kind] ||= []).push(r);
  const accName = (id) => accounts().find((a) => a.id === id)?.name || "";
  $("#recurring-list").innerHTML = Object.keys(REC_LABELS).filter((k) => groups[k]).map((k) => {
    const total = groups[k].filter((r) => r.active !== false).reduce((s, r) => s + monthlyEq(r), 0);
    return `<h3>${REC_LABELS[k]} <span class="muted small">月 ${yen(total)}・年 ${yen(total * 12)}</span></h3><div class="list">${groups[k].map((r) => `
      <div class="item" style="${r.active !== false ? "" : "opacity:.5"}"><div><div class="title">${esc(r.name)}${r.variable ? '<span class="tag">変動</span>' : ""}${r.active !== false ? "" : '<span class="tag">解約済み</span>'}</div>
        <div class="meta">${CYCLE_LABELS[r.cycle] || ""}${(r.cycle === "yearly" || r.cycle === "quarterly") && r.billing_month ? `${r.cycle === "quarterly" ? "（" : ""}${r.billing_month}月${r.cycle === "quarterly" ? "〜）" : ""}` : ""}${r.billing_day ? `${r.billing_day}日` : ""}${accName(r.account_id) ? `・${esc(accName(r.account_id))}` : ""}${r.note ? `・${esc(r.note)}` : ""}</div></div>
        <div class="right"><div class="title">${yen(r.amount)}</div>${r.cycle !== "monthly" ? `<div class="meta">月 ${yen(monthlyEq(r))}</div>` : ""}
          <div><button class="link-btn" data-edit-rec="${esc(r.id)}" type="button">編集</button><button class="link-btn danger" data-del-rec="${esc(r.id)}" type="button">${pendingDelete === r.id ? "本当に削除" : "削除"}</button></div></div></div>`).join("")}</div>`;
  }).join("") || `<p class="muted">家賃・電気・ガス・水道・スマホ・ネット回線・サブスク・NISA積立などを登録しましょう。</p>`;
}
$("#recurring-list").addEventListener("click", (e) => {
  const edit = e.target.dataset.editRec, del = e.target.dataset.delRec;
  if (edit) { fillForm(recForm, recurring().find((r) => r.id === edit)); syncRecFields(); }
  if (del && armDelete(del)) { S.recurring.items = recurring().filter((r) => r.id !== del); save("recurring"); toast("削除しました"); render(); }
});
recForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const f = formData(recForm);
  if (!f.name || f.amount == null) { toast("名前と金額を入れてください"); return; }
  const data = { name: f.name, kind: f.kind, amount: Math.round(f.amount), cycle: f.cycle, billing_day: f.billing_day, billing_month: f.billing_month,
    account_id: f.account_id || null, match_keyword: f.match_keyword, variable: !!f.variable, active: f.active !== false, note: f.note };
  const r = f.id && recurring().find((x) => x.id === f.id);
  if (r) Object.assign(r, data); else S.recurring.items.push({ id: uid(), ...data });
  save("recurring");
  toast("保存しました");
  recForm.reset();
  idField(recForm).value = "";
  render();
});
recForm.addEventListener("reset", () => setTimeout(() => { idField(recForm).value = ""; syncRecFields(); }));

// ------------------------------------------------------------------ ほしいもの
const wishForm = $("#wish-form");
function renderWishlist() {
  const analysis = Object.fromEntries(dashboard().wishlist.map((w) => [w.id, w]));
  const PRIO = { 1: "高", 2: "中", 3: "低" }, STATUS = { want: "", bought: "買った", dropped: "見送り" };
  const items = [...S.wishlist.items].sort((a, b) => ((a.status || "want") === "want" ? 0 : 1) - ((b.status || "want") === "want" ? 0 : 1) || (a.priority || 2) - (b.priority || 2));
  $("#wish-list").innerHTML = items.length ? `<div class="list">${items.map((it) => {
    const a = analysis[it.id];
    const link = /^https?:\/\//.test(it.url || "") ? `<a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.name)}</a>` : esc(it.name);
    return `<div class="item" style="${(it.status || "want") === "want" ? "" : "opacity:.55"}"><div>
      <div class="title">${link}<span class="tag">優先度 ${PRIO[it.priority] || "中"}</span>${STATUS[it.status] ? `<span class="tag">${STATUS[it.status]}</span>` : ""}</div>
      <div class="meta">${a ? `<span class="verdict-${a.verdict}">${VERDICT_TEXT[a.verdict]}</span>${a.months_to_save ? `・貯めるなら約${a.months_to_save}か月` : ""}` : ""}${it.target_date ? `・${esc(it.target_date)} まで` : ""}${it.note ? `・${esc(it.note)}` : ""}</div></div>
      <div class="right"><div class="title">${yen(it.price)}</div>${it.saved ? `<div class="meta">取り分け ${yen(it.saved)}</div>` : ""}
        <div><button class="link-btn" data-edit-wish="${esc(it.id)}" type="button">編集</button><button class="link-btn danger" data-del-wish="${esc(it.id)}" type="button">${pendingDelete === it.id ? "本当に削除" : "削除"}</button></div></div></div>`;
  }).join("")}</div>` : `<p class="muted">ほしいものを登録すると、今買えるか・何か月で貯まるかを判定します。</p>`;
}
$("#wish-list").addEventListener("click", (e) => {
  const edit = e.target.dataset.editWish, del = e.target.dataset.delWish;
  if (edit) fillForm(wishForm, S.wishlist.items.find((w) => w.id === edit));
  if (del && armDelete(del)) { S.wishlist.items = S.wishlist.items.filter((w) => w.id !== del); save("wishlist"); render(); }
});
wishForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const f = formData(wishForm);
  if (!f.name || !(f.price > 0)) { toast("名前と価格を入れてください"); return; }
  const data = { name: f.name, price: Math.round(f.price), priority: f.priority || 2, saved: Math.round(f.saved || 0), target_date: f.target_date, url: f.url, status: f.status || "want", note: f.note };
  const w = f.id && S.wishlist.items.find((x) => x.id === f.id);
  if (w) Object.assign(w, data); else S.wishlist.items.push({ id: uid(), created_at: D.fmt(D.today()), ...data });
  save("wishlist");
  toast("保存しました");
  wishForm.reset();
  idField(wishForm).value = "";
  render();
});

// ------------------------------------------------------------------ AI
function renderAdviceHistory() {
  const hist = S.advice.log;
  $("#advice-history").innerHTML = hist.length ? hist.map((h) => `<details class="history-item"><summary>${esc(new Date(h.at).toLocaleString("ja-JP"))}　${esc(h.question || "今月の診断")}</summary><div class="md">${renderMarkdown(h.answer)}</div></details>`).join("")
    : `<p class="muted">まだ相談履歴はありません。</p>`;
}
$("#advice-form").addEventListener("submit", (e) => { e.preventDefault(); ask(e.target.question.value.trim(), $("#advice-out"), $("#advice-form button")); });
$(".chips").addEventListener("click", (e) => { if (e.target.dataset.q !== undefined) { $("#advice-form").question.value = e.target.dataset.q; ask(e.target.dataset.q, $("#advice-out"), $("#advice-form button")); } });

// ------------------------------------------------------------------ 設定
const setForm = $("#settings-form");
function catBudgetRow(cat = "", amount = "") {
  const row = document.createElement("div");
  row.className = "cat-budget-row";
  row.innerHTML = `<input class="cb-name" list="category-list" placeholder="カテゴリ" value="${esc(cat)}" aria-label="カテゴリ"><input class="cb-amt" type="number" min="0" placeholder="円" value="${esc(amount)}" aria-label="予算（円）"><button type="button" class="link-btn danger">削除</button>`;
  row.querySelector("button").addEventListener("click", () => row.remove());
  $("#cat-budgets").append(row);
}
function renderSettings() {
  if (setForm.contains(document.activeElement)) return; // 入力中は書き換えない
  const st = settings();
  for (const k of ["monthly_income", "cycle_start_day", "savings_goal", "emergency_fund_months"]) setForm[k].value = st[k];
  setForm.reimburse_keywords.value = st.reimburse_keywords || "";
  setForm.savings_flex.checked = !!st.savings_flex;
  $("#cat-budgets").innerHTML = "";
  Object.entries(st.category_budgets || {}).forEach(([c, a]) => catBudgetRow(c, a));
}
$("#add-cat-budget").addEventListener("click", () => catBudgetRow());
setForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const body = { ...settings() };
  for (const k of ["monthly_income", "cycle_start_day", "savings_goal", "emergency_fund_months"]) body[k] = Number(setForm[k].value || 0);
  body.cycle_start_day = Math.min(31, Math.max(1, body.cycle_start_day || 1));
  body.reimburse_keywords = setForm.reimburse_keywords.value.trim();
  body.savings_flex = setForm.savings_flex.checked;
  body.category_budgets = {};
  $$(".cat-budget-row").forEach((r) => { const n = r.querySelector(".cb-name").value.trim(), a = Number(r.querySelector(".cb-amt").value || 0); if (n && a > 0) body.category_budgets[n] = a; });
  S.settings = body;
  save("settings");
  document.activeElement?.blur();
  toast("保存しました");
});

// ================================================================== boot
showTab(currentTab);
(async () => {
  const db = await claude.use("db");
  if (!db) {
    $("#store-notice").hidden = false;
    $("#store-notice").textContent = "この表示ではデータを保存できません。claude.ai にログインして開いてください。";
    return;
  }
  S.db = db;
  const fail = (e) => {
    if (e?.code === "revoked") { $("#store-notice").hidden = false; $("#store-notice").textContent = "このページへのアクセスが変わったため、データを表示できなくなりました。"; }
  };
  const arrived = new Set();
  for (const name of Object.keys(APP_DOCS)) {
    db.doc("app/" + name).onSnapshot((snap) => {
      if (writing[name]) return; // 自分の書き込み中はローカルの状態を正とする
      S[name] = snap.exists ? JSON.parse(JSON.stringify(snap.data())) : APP_DOCS[name]();
      if (name === "mail") { S.mail.seen ||= []; S.mail.log ||= []; }
      render();
      arrived.add(name);
      if (arrived.size === Object.keys(APP_DOCS).length && !S.autoStarted) { S.autoStarted = true; maybeAutoSync(); }
    }, fail);
  }
  for (const ym of monthsAround(D.today(), 5)) {
    S.loaded.add(ym);
    db.doc("tx/" + ym).onSnapshot((snap) => {
      if (writing["tx/" + ym]) return;
      S.tx[ym] = snap.exists ? [...(snap.data().items || [])].map((t) => ({ ...t })) : [];
      render();
    }, fail);
  }
  setInterval(maybeAutoSync, 5 * 60000);
})();
// グラフは表示幅に合わせて描くので、幅が変わったら描き直す
let resizeTimer, lastW = window.innerWidth;
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (Math.abs(window.innerWidth - lastW) > 40) { lastW = window.innerWidth; render(); } }, 200); });
