"use strict";

// ------------------------------------------------------------------ utilities
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const yen = (n) => (n == null ? "-" : `${Math.round(n).toLocaleString("ja-JP")}円`);
const man = (n) => (Math.abs(n) >= 10000 ? `${(n / 10000).toLocaleString("ja-JP", { maximumFractionDigits: 1 })}万` : `${Math.round(n).toLocaleString("ja-JP")}`);
const pct = (r) => (r == null ? "-" : `${Math.round(r * 100)}%`);
const localISO = (d = new Date()) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const md = (s) => { const [, m, d] = s.split("-"); return `${+m}/${+d}`; };

const KIND_LABELS = {
  bank: "銀行口座", cash: "現金", emoney: "電子マネー", card: "クレジットカード", securities: "証券口座",
  nisa: "NISA", ideco: "iDeCo", dc: "企業型DC", loan: "ローン", other: "その他資産",
};
const REC_LABELS = { subscription: "サブスク", utility: "インフラ", fixed: "固定費", investment: "積立投資" };
const CYCLE_LABELS = { monthly: "毎月", yearly: "毎年", weekly: "毎週" };
const STATUS_TEXT = { ok: "順調", warning: "ペース早め", over: "予算オーバー", deficit: "赤字構造" };
const VERDICT_TEXT = { buy_ok: "今月の予算で買えます", buy_from_savings: "貯金から出せば買えます", wait: "もう少し待ちましょう" };

async function api(path, opts = {}) {
  const init = { ...opts };
  if (opts.json !== undefined) {
    init.body = JSON.stringify(opts.json);
    init.headers = { "Content-Type": "application/json" };
  }
  const res = await fetch(path, init);
  if (!res.ok) {
    let detail = res.statusText;
    try { const j = await res.json(); detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail); } catch {}
    throw new Error(detail);
  }
  return res.json();
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 2600);
}

function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.type === "file") continue;
    if (el.type === "radio") { if (el.checked) out[el.name] = el.value; continue; }
    if (el.type === "checkbox") { out[el.name] = el.checked; continue; }
    const v = el.value.trim();
    if (el.type === "number" || el.dataset.int !== undefined || el.tagName === "SELECT" && /_id$|priority/.test(el.name)) {
      out[el.name] = v === "" ? null : Number(v);
    } else {
      out[el.name] = v === "" && el.type === "date" ? null : v;
    }
  }
  return out;
}

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
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

// Markdown（見出し・太字・斜体・箇条書き・引用だけ）を安全に HTML 化
function renderMarkdown(text) {
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/(^|\s)_(\S.*?)_(?=\s|$)/g, "$1<em>$2</em>");
  const out = [];
  let list = null;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const li = line.match(/^\s*(?:[-*・]|\d+\.)\s+(.*)$/);
    if (li) { if (!list) { list = []; } list.push(`<li>${inline(li[1])}</li>`); continue; }
    if (list) { out.push(`<ul>${list.join("")}</ul>`); list = null; }
    let m;
    if ((m = line.match(/^#{1,6}\s+(.*)$/))) out.push(`<h3>${inline(m[1])}</h3>`);
    else if ((m = line.match(/^>\s?(.*)$/))) out.push(`<blockquote>${inline(m[1])}</blockquote>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push(`<ul>${list.join("")}</ul>`);
  return out.join("");
}

// ------------------------------------------------------------------ state & tabs
const state = { accounts: [], recurring: [], dashboard: null };

function showTab(name) {
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab").forEach((s) => s.classList.toggle("active", s.id === `tab-${name}`));
  try { localStorage.setItem("tab", name); } catch {}
  ({ dashboard: loadDashboard, transactions: loadTransactions, assets: loadAccounts, recurring: loadRecurring,
     wishlist: loadWishlist, advice: loadAdvice, settings: loadSettings }[name])?.();
}
$("#tabs").addEventListener("click", (e) => { if (e.target.dataset.tab) showTab(e.target.dataset.tab); });
document.addEventListener("click", (e) => {
  const g = e.target.closest("[data-goto]");
  if (g) { e.preventDefault(); showTab(g.dataset.goto); }
});

async function refreshRefs() {
  [state.accounts, state.recurring] = await Promise.all([api("/api/accounts"), api("/api/recurring")]);
  const accOpts = `<option value="">（未指定）</option>` + state.accounts.map((a) => `<option value="${a.id}">${esc(a.name)}（${KIND_LABELS[a.kind]}）</option>`).join("");
  $$("select.account-select").forEach((s) => {
    const v = s.value;
    s.innerHTML = s.id === "tx-account" ? accOpts.replace("（未指定）", "すべての口座") : accOpts;
    s.value = v;
  });
  const bankOpts = `<option value="">（未指定）</option>` + state.accounts.filter((a) => ["bank", "cash", "emoney"].includes(a.kind)).map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join("");
  $$("select.bank-select").forEach((s) => { const v = s.value; s.innerHTML = bankOpts; s.value = v; });
  const recOpts = `<option value="">なし（変動費）</option>` + state.recurring.filter((r) => r.active).map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join("");
  $$("select.recurring-select").forEach((s) => { const v = s.value; s.innerHTML = recOpts; s.value = v; });
  const cats = await api("/api/categories");
  $("#category-list").innerHTML = cats.map((c) => `<option value="${esc(c)}">`).join("");
}

// ------------------------------------------------------------------ dashboard
async function loadDashboard() {
  const d = await api("/api/dashboard");
  state.dashboard = d;
  const b = d.budget, w = d.net_worth;

  $("#onboarding").hidden = !(b.income === 0 || d.accounts.length === 0);

  $("#hero-month").innerHTML = `
    <div class="label">今月あと使えるお金 <span class="status ${b.status}">${STATUS_TEXT[b.status]}</span></div>
    <div class="value ${b.remaining < 0 ? "neg" : ""}">${yen(b.remaining)}</div>
    <div class="sub">${md(b.period.start)}〜${md(b.period.end)}・残り${b.period.days_left}日／変動費の予算 ${yen(b.variable_budget)}</div>`;
  $("#hero-today").innerHTML = `
    <div class="label">今日あと使えるお金</div>
    <div class="value ${b.today_remaining < 0 ? "neg" : ""}">${yen(b.today_remaining)}</div>
    <div class="sub">1日あたり ${yen(b.daily_allowance)}・今日の支出 ${yen(b.today_spent)}</div>`;
  $("#hero-worth").innerHTML = `
    <div class="label">純資産（NISA・iDeCo 含む）</div>
    <div class="value">${yen(w.net_worth)}</div>
    <div class="sub">すぐ使えるお金 ${yen(w.spendable)}（預金 − カード未払い）</div>`;

  // ペースメーター
  const budget = Math.max(b.variable_budget, 1);
  const fillPct = Math.min(100, (b.spent / budget) * 100);
  const markPct = Math.min(100, (b.period.elapsed_days / b.period.total_days) * 100);
  const cls = b.status === "ok" ? "" : b.status === "warning" ? "warning" : "over";
  $("#pace-card").innerHTML = `
    <div class="row-between wrap"><h2>今期の使ったペース</h2>
      <span class="small muted">縦線＝今日時点の目安（${yen(b.expected_by_now)}）</span></div>
    <div class="meter" role="img" aria-label="予算 ${yen(b.variable_budget)} のうち ${yen(b.spent)} 使用"><div class="fill ${cls}" style="width:${fillPct}%"></div><div class="mark" style="left:calc(${markPct}% - 1px)"></div></div>
    <div class="meter-legend">
      <span>使った ${yen(b.spent)}（${pct(b.spent / budget)}）</span>
      <span>このペースだと月末 ${yen(b.projected_spent)} → ${b.projected_surplus >= 0 ? `${yen(b.projected_surplus)} 余る見込み` : `<b class="neg">${yen(-b.projected_surplus)} 足りない見込み</b>`}</span>
      <span>収入 ${yen(b.income)} − 固定費 ${yen(b.fixed_monthly)} − 積立 ${yen(b.investment_monthly)} − 先取り貯金 ${yen(b.savings_goal)}</span>
    </div>`;

  // アラート
  const alerts = [];
  for (const p of d.payment_checks) if (p.shortfall > 0) alerts.push(["", `<b>${esc(p.account)}</b> の残高 ${yen(p.balance)} に対し、1か月以内に ${yen(p.due_amount)} の引き落とし予定。<b>${yen(p.shortfall)} 不足</b>しています。`]);
  if (b.status === "deficit") alerts.push(["", "固定費・積立・先取り貯金の合計が収入を超えています。固定費か積立額の見直しが必要です。"]);
  for (const c of b.categories) if (c.budget && c.spent > c.budget) alerts.push(["warn", `<b>${esc(c.category)}</b> が予算 ${yen(c.budget)} を ${yen(c.spent - c.budget)} 超えています。`]);
  for (const c of d.cards) if (c.limit_usage > 0.8) alerts.push(["warn", `<b>${esc(c.name)}</b> の利用枠を ${pct(c.limit_usage)} 使っています。`]);
  $("#alerts").innerHTML = alerts.map(([k, m]) => `<div class="alert ${k}"><span class="icon">${k ? "!" : "⚠"}</span><div>${m}</div></div>`).join("");

  // カテゴリ
  const cats = b.categories.filter((c) => c.spent > 0 || c.budget);
  const maxCat = Math.max(1, ...cats.map((c) => Math.max(c.spent, c.budget || 0)));
  $("#cat-chart").innerHTML = cats.length ? `<div class="bars">${cats.map((c) => `
    <div class="bar-row" data-tip="${esc(c.category)}|使った ${yen(c.spent)}${c.budget ? `|予算 ${yen(c.budget)}（${pct(c.ratio)}）|残り ${yen(c.remaining)}` : ""}">
      <span class="name">${esc(c.category)}</span>
      <div class="bar-track"><div class="fill ${c.budget && c.spent > c.budget ? "over" : ""}" style="width:${(c.spent / maxCat) * 100}%"></div>
        ${c.budget ? `<div class="budget-line" style="left:calc(${(c.budget / maxCat) * 100}% - 1px)"></div>` : ""}</div>
      <span class="amt">${yen(c.spent)}${c.budget ? ` <span class="muted">/ ${man(c.budget)}</span>` : ""}</span>
    </div>`).join("")}</div><p class="small muted">縦線＝カテゴリ予算。固定費として照合された明細は含みません。</p>`
    : `<p class="muted">今期の支出はまだありません。</p>`;

  // カード
  $("#cards-list").innerHTML = d.cards.length ? `<div class="list">${d.cards.map((c) => `
    <div class="item"><div><div class="title">${esc(c.name)}</div>
      <div class="meta">${c.closing_day === 31 ? "月末" : c.closing_day + "日"}締め・翌月${c.payment_day}日払い／今の利用期間 ${md(c.current_cycle.start)}〜${md(c.current_cycle.end)}: ${yen(c.current_cycle.amount)}</div></div>
      <div class="right"><div>${md(c.next_payment.date)} 引き落とし</div><div class="title">${yen(c.next_payment.amount)}${c.next_payment.confirmed ? "" : '<span class="tag">利用中</span>'}</div>
      ${c.limit ? `<div class="meta">枠 ${pct(c.limit_usage)} 使用</div>` : ""}</div></div>`).join("")}</div>`
    : `<p class="muted">カードが未登録です。<a href="#" data-goto="assets">登録する</a></p>`;

  // 資産の内訳
  const groups = [["liquid", "預金・現金", "--series-1"], ["invest", "投資（NISA・特定口座）", "--series-2"],
                  ["pension", "年金（iDeCo・企業型DC）", "--series-3"], ["other", "その他", "--series-4"]];
  const totalA = Math.max(1, w.total_assets);
  $("#asset-breakdown").innerHTML = `
    <div class="stack" role="img" aria-label="資産の内訳">${groups.filter(([k]) => w[k] > 0).map(([k, label, v]) => `<div style="flex:${w[k]};background:var(${v})" data-tip="${label}|${yen(w[k])}（${pct(w[k] / totalA)}）"></div>`).join("")}</div>
    <div class="legend">${groups.filter(([k]) => w[k] > 0 || k !== "other").map(([k, label, v]) => `<div class="item"><span class="sw" style="background:var(${v})"></span><span>${label}${k === "pension" ? '<span class="tag locked">60歳まで引出不可</span>' : ""}</span><span class="amt">${yen(w[k])}</span></div>`).join("")}
      <div class="item"><span></span><span class="muted">負債（ローン・カード未払い）</span><span class="amt neg">−${yen(w.liability)}</span></div></div>
    ${w.investments.length ? `<h3>運用成績</h3><div class="list">${w.investments.map((i) => `<div class="item"><div><div class="title">${esc(i.name)}</div><div class="meta">元本 ${yen(i.contributed)}</div></div><div class="right"><div>${yen(i.balance)}</div>${i.gain != null ? `<div class="meta ${i.gain < 0 ? "neg" : ""}">${i.gain >= 0 ? "+" : ""}${yen(i.gain)}（${i.gain_ratio != null ? (i.gain_ratio * 100).toFixed(1) : "-"}%）</div>` : ""}</div></div>`).join("")}</div>` : ""}
    <p class="small muted">生活防衛資金: すぐ使えるお金は生活費の <b>${d.emergency_fund.months_covered != null ? d.emergency_fund.months_covered.toFixed(1) : "-"}</b> か月分（目標 ${d.emergency_fund.target_months} か月 = ${yen(d.emergency_fund.target_amount)}）</p>`;

  // これからの引き落とし
  const upcoming = [...b.recurring.upcoming.map((u) => ({ ...u, label: REC_LABELS[u.kind] })),
    ...d.cards.filter((c) => (new Date(c.next_payment.date) - new Date(d.today)) / 86400000 <= 31).map((c) => ({ date: c.next_payment.date, name: `${c.name} 引き落とし`, amount: c.next_payment.amount, label: "カード" }))]
    // カード払いの固定費はカードの引き落としに含まれるので二重に出さない
    .filter((u) => u.label === "カード" || d.accounts.find((a) => a.id === u.account_id)?.kind !== "card")
    .sort((a, b2) => a.date.localeCompare(b2.date));
  $("#upcoming").innerHTML = upcoming.length ? `<div class="list">${upcoming.map((u) => `<div class="item"><div><span class="title">${esc(u.name)}</span><span class="tag">${u.label}</span>${u.variable ? '<span class="tag">変動</span>' : ""}<div class="meta">${md(u.date)}</div></div><div class="right">${u.variable ? "約" : ""}${yen(u.amount)}</div></div>`).join("")}</div><p class="small muted">カード払いの固定費はカードの引き落としに含まれます。</p>`
    : `<p class="muted">1か月以内の引き落とし予定はありません。</p>`;

  renderWorthChart($("#worth-chart"), d.net_worth_history);

  // 固定費
  const rk = b.recurring.monthly_by_kind;
  $("#recurring-summary").innerHTML = `
    <div class="legend">${Object.entries(REC_LABELS).map(([k, l]) => `<div class="item"><span></span><span>${l}</span><span class="amt">${yen(rk[k] || 0)}</span></div>`).join("")}
    <div class="item"><span></span><b>合計</b><b class="amt">${yen(b.recurring.monthly_total)}</b></div></div>
    <p class="small muted">サブスク ${b.recurring.subscription_count} 件で年間 ${yen(b.recurring.subscription_yearly)}。<a href="#" data-goto="recurring">一覧を見る</a></p>`;

  // ほしいもの
  $("#wish-summary").innerHTML = d.wishlist.length ? `<div class="list">${d.wishlist.slice(0, 5).map((it) => `
    <div class="item"><div><div class="title">${esc(it.name)}</div><div class="meta verdict-${it.verdict}">${VERDICT_TEXT[it.verdict]}${it.months_to_save ? `・貯めるなら約${it.months_to_save}か月` : ""}</div></div>
    <div class="right">${yen(it.price)}${it.saved ? `<div class="meta">あと ${yen(it.need)}</div>` : ""}</div></div>`).join("")}</div>`
    : `<p class="muted">ほしいものはまだありません。<a href="#" data-goto="wishlist">追加する</a></p>`;
}

function renderWorthChart(el, history) {
  if (!history.length) { el.innerHTML = `<p class="muted">口座の残高を更新すると、ここに推移が表示されます。</p>`; return; }
  const series = [["liquid", "預金・現金", "--series-1"], ["invest", "投資", "--series-2"], ["pension", "年金", "--series-3"], ["other", "その他", "--series-4"]]
    .filter(([k]) => history.some((h) => h[k] > 0));
  const W = 760, H = 240, padL = 48, padR = 8, padT = 10, padB = 24;
  const maxV = Math.max(1, ...history.map((h) => series.reduce((s, [k]) => s + h[k], 0)));
  const step = Math.pow(10, Math.floor(Math.log10(maxV))) * (maxV / Math.pow(10, Math.floor(Math.log10(maxV))) > 5 ? 2 : 1);
  const top = Math.ceil(maxV / step) * step;
  const y = (v) => padT + (H - padT - padB) * (1 - v / top);
  const band = (W - padL - padR) / history.length;
  const bw = Math.min(36, band * 0.7);
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
      const hgt = Math.max(0, y0 - y1 - (j > 0 ? 2 : 0));   // 2px の隙間
      const last = j === segs.length - 1;
      svg += last
        ? `<path d="M${x},${y0 - (j > 0 ? 2 : 0)} v${-hgt + 4} q0,-4 4,-4 h${bw - 8} q4,0 4,4 v${hgt - 4} z" fill="var(${v})"/>`
        : `<rect x="${x}" y="${y1}" width="${bw}" height="${hgt}" fill="var(${v})"/>`;
    });
    const tip = [`${h.month.replace("-", "年")}月`, ...series.map(([k, l]) => `${l} ${yen(h[k])}`), `負債 −${yen(h.liability)}`, `純資産 ${yen(h.net_worth)}`].join("|");
    svg += `<rect x="${padL + band * i}" y="${padT}" width="${band}" height="${H - padT - padB}" fill="transparent" data-tip="${esc(tip)}" data-sw="${series.map(([, , v]) => v).join(",")}"/>`;
  });
  svg += `</svg>`;
  el.innerHTML = svg + `<div class="legend" style="grid-template-columns:repeat(auto-fit,minmax(120px,max-content));gap:6px 18px;margin-top:8px">${series.map(([, l, v]) => `<div class="item" style="grid-template-columns:12px auto"><span class="sw" style="background:var(${v})"></span><span>${l}</span></div>`).join("")}</div>`;
}

// ツールチップ（data-tip="見出し|行|行..."）
const tooltip = $("#tooltip");
document.addEventListener("pointermove", (e) => {
  const t = e.target.closest?.("[data-tip]");
  if (!t) { tooltip.hidden = true; return; }
  const [head, ...rest] = t.dataset.tip.split("|");
  const sws = (t.dataset.sw || "").split(",").filter(Boolean);
  tooltip.innerHTML = `<b>${esc(head)}</b>` + rest.map((r, i) => `<div class="tt-row"><span class="sw" style="${sws[i] ? `background:var(${sws[i]})` : ""}"></span><span>${esc(r)}</span><span></span></div>`).join("");
  tooltip.hidden = false;
  const x = Math.min(e.clientX + 14, window.innerWidth - tooltip.offsetWidth - 8);
  const y = Math.min(e.clientY + 14, window.innerHeight - tooltip.offsetHeight - 8);
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
});

$("#quick-advice").addEventListener("click", async (e) => {
  const out = $("#quick-advice-out");
  e.target.disabled = true;
  out.className = "md loading";
  out.innerHTML = "";
  try {
    const r = await api("/api/advice", { method: "POST", json: {} });
    out.className = "md";
    out.innerHTML = renderMarkdown(r.answer);
  } catch (err) {
    out.className = "md neg";
    out.textContent = err.message;
  } finally { e.target.disabled = false; }
});

// ------------------------------------------------------------------ transactions
const txForm = $("#tx-form");
let txCache = [];

async function loadTransactions() {
  await refreshRefs();
  if (!txForm.date.value) txForm.date.value = localISO();
  if (!$("#tx-month").value) $("#tx-month").value = localISO().slice(0, 7);
  const [y, m] = $("#tx-month").value.split("-").map(Number);
  const start = `${$("#tx-month").value}-01`;
  const end = localISO(new Date(y, m, 0));
  const params = new URLSearchParams({ start, end });
  if ($("#tx-account").value) params.set("account_id", $("#tx-account").value);
  txCache = await api(`/api/transactions?${params}`);
  renderTxTable();
}

function renderTxTable() {
  const q = $("#tx-search").value.trim().toLowerCase();
  const rows = txCache.filter((t) => !q || `${t.description} ${t.category} ${t.memo}`.toLowerCase().includes(q));
  const accName = (id) => state.accounts.find((a) => a.id === id)?.name || "";
  const recName = (id) => state.recurring.find((r) => r.id === id)?.name || "";
  const exp = rows.filter((t) => t.type === "expense").reduce((s, t) => s + t.amount, 0);
  const inc = rows.filter((t) => t.type === "income").reduce((s, t) => s + t.amount, 0);
  $("#tx-total").textContent = `${rows.length} 件／支出 ${yen(exp)}／収入 ${yen(inc)}`;
  $("#tx-table").innerHTML = `<thead><tr><th>日付</th><th>内容</th><th>カテゴリ</th><th>口座</th><th class="num">金額</th><th></th></tr></thead><tbody>` +
    rows.map((t) => `<tr><td>${md(t.date)}</td><td class="desc">${esc(t.description)}${t.recurring_id ? `<span class="tag">固定費: ${esc(recName(t.recurring_id))}</span>` : ""}${t.memo ? `<div class="meta muted small">${esc(t.memo)}</div>` : ""}</td>
      <td>${esc(t.category)}</td><td>${esc(accName(t.account_id))}</td>
      <td class="num ${t.type === "income" ? "" : ""}">${t.type === "income" ? "+" : t.type === "transfer" ? "⇄ " : "−"}${yen(t.amount)}</td>
      <td><button class="link-btn" data-edit-tx="${t.id}">編集</button><button class="link-btn danger" data-del-tx="${t.id}">削除</button></td></tr>`).join("") + "</tbody>";
}

$("#tx-month").addEventListener("change", loadTransactions);
$("#tx-account").addEventListener("change", loadTransactions);
$("#tx-search").addEventListener("input", renderTxTable);
$("#tx-table").addEventListener("click", async (e) => {
  const edit = e.target.dataset.editTx, del = e.target.dataset.delTx;
  if (edit) fillForm(txForm, txCache.find((t) => t.id === +edit));
  if (del && confirm("この明細を削除しますか？")) { await api(`/api/transactions/${del}`, { method: "DELETE" }); toast("削除しました"); loadTransactions(); }
});

txForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = formData(txForm);
  const id = data.id; delete data.id;
  if (!data.category) {
    data.category = data.type === "income" ? "収入" : guessCategory(data.description);
  }
  try {
    await api(id ? `/api/transactions/${id}` : "/api/transactions", { method: id ? "PUT" : "POST", json: data });
    toast("保存しました");
    const keepDate = txForm.date.value;
    txForm.reset(); txForm.date.value = keepDate;
    loadTransactions();
  } catch (err) { toast(`保存できませんでした: ${err.message}`); }
});
txForm.addEventListener("reset", () => setTimeout(() => { txForm.id.value = ""; txForm.date.value = localISO(); }));

function guessCategory(desc) {
  const rules = { 食費: ["スーパー", "イオン"], コンビニ: ["セブン", "ローソン", "ファミ"], 外食: ["ランチ", "カフェ", "スタバ", "飲み"], 交通: ["電車", "タクシー", "suica"] };
  for (const [c, ws] of Object.entries(rules)) if (ws.some((w) => (desc || "").toLowerCase().includes(w.toLowerCase()))) return c;
  return "未分類";
}

const csvForm = $("#csv-form");
async function uploadCsv(dryRun) {
  const fd = new FormData();
  const file = csvForm.file.files[0];
  if (!file) { toast("ファイルを選んでください"); return; }
  fd.append("file", file);
  if (csvForm.account_id.value) fd.append("account_id", csvForm.account_id.value);
  fd.append("dry_run", dryRun ? "true" : "false");
  try {
    const r = await api("/api/import/csv", { method: "POST", body: fd });
    $("#csv-result").innerHTML = `<p>${r.parsed} 件を読み取り、${dryRun ? "取り込み対象" : "取り込み"} ${r.inserted} 件／重複スキップ ${r.skipped_duplicates} 件</p>
      <div class="table-wrap"><table><tbody>${r.preview.map((p) => `<tr><td>${p.date}</td><td class="desc">${esc(p.description)}</td><td>${esc(p.category)}</td><td class="num">${p.type === "income" ? "+" : ""}${yen(p.amount)}</td></tr>`).join("")}</tbody></table></div>
      ${r.parsed > r.preview.length ? `<p class="small muted">先頭 ${r.preview.length} 件を表示</p>` : ""}`;
    if (!dryRun) { toast(`${r.inserted} 件取り込みました`); loadTransactions(); }
  } catch (err) { $("#csv-result").innerHTML = `<p class="neg">${esc(err.message)}</p>`; }
}
$("#csv-preview").addEventListener("click", () => uploadCsv(true));
csvForm.addEventListener("submit", (e) => { e.preventDefault(); uploadCsv(false); });

// ------------------------------------------------------------------ accounts
const accForm = $("#account-form");
function syncAccountFields() {
  const kind = accForm.kind.value;
  $$(".card-only", accForm).forEach((el) => (el.hidden = kind !== "card"));
  $$(".not-card", accForm).forEach((el) => (el.hidden = kind === "card"));
  $$(".invest-only", accForm).forEach((el) => (el.hidden = !["nisa", "ideco", "dc", "securities"].includes(kind)));
}
accForm.addEventListener("change", syncAccountFields);

async function loadAccounts() {
  await refreshRefs();
  syncAccountFields();
  const groups = {};
  for (const a of state.accounts) (groups[a.kind] ||= []).push(a);
  $("#account-list").innerHTML = Object.keys(KIND_LABELS).filter((k) => groups[k]).map((k) => `
    <h3>${KIND_LABELS[k]}</h3><div class="list">${groups[k].map((a) => `
      <div class="item"><div><div class="title">${esc(a.name)}${["ideco", "dc"].includes(a.kind) ? '<span class="tag locked">60歳まで引出不可</span>' : ""}</div>
        <div class="meta">${esc(a.institution)}${a.kind === "card" ? `　${a.closing_day === 31 ? "月末" : a.closing_day + "日"}締め・翌月${a.payment_day}日払い` : `　更新 ${a.updated_at}`}</div></div>
        <div class="right">${a.kind === "card" ? (a.card_limit ? `枠 ${yen(a.card_limit)}` : "") : `<div class="title">${a.kind === "loan" ? "−" : ""}${yen(a.balance)}</div>${a.contributed != null ? `<div class="meta">元本 ${yen(a.contributed)}</div>` : ""}`}
          <div><button class="link-btn" data-edit-acc="${a.id}">編集</button><button class="link-btn danger" data-del-acc="${a.id}">削除</button></div></div></div>`).join("")}</div>`).join("")
    || `<p class="muted">まだ登録がありません。銀行口座・カード・NISA・iDeCo などを登録しましょう。</p>`;
}
$("#account-list").addEventListener("click", async (e) => {
  const edit = e.target.dataset.editAcc, del = e.target.dataset.delAcc;
  if (edit) { fillForm(accForm, state.accounts.find((a) => a.id === +edit)); syncAccountFields(); }
  if (del && confirm("この口座を削除しますか？（明細は残ります）")) { await api(`/api/accounts/${del}`, { method: "DELETE" }); toast("削除しました"); loadAccounts(); }
});
accForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = formData(accForm);
  const id = data.id; delete data.id;
  data.balance ??= 0;
  try {
    await api(id ? `/api/accounts/${id}` : "/api/accounts", { method: id ? "PUT" : "POST", json: data });
    toast("保存しました"); accForm.reset(); accForm.id.value = ""; loadAccounts();
  } catch (err) { toast(`保存できませんでした: ${err.message}`); }
});
accForm.addEventListener("reset", () => setTimeout(() => { accForm.id.value = ""; syncAccountFields(); }));

// ------------------------------------------------------------------ recurring
const recForm = $("#recurring-form");
const syncRecFields = () => $$(".yearly-only", recForm).forEach((el) => (el.hidden = recForm.cycle.value !== "yearly"));
recForm.addEventListener("change", syncRecFields);

async function loadRecurring() {
  await refreshRefs();
  syncRecFields();
  const monthly = (r) => (r.cycle === "yearly" ? r.amount / 12 : r.cycle === "weekly" ? (r.amount * 52) / 12 : r.amount);
  const groups = {};
  for (const r of state.recurring) (groups[r.kind] ||= []).push(r);
  const accName = (id) => state.accounts.find((a) => a.id === id)?.name || "";
  $("#recurring-list").innerHTML = Object.keys(REC_LABELS).filter((k) => groups[k]).map((k) => {
    const total = groups[k].filter((r) => r.active).reduce((s, r) => s + monthly(r), 0);
    return `<h3>${REC_LABELS[k]} <span class="muted small">月 ${yen(total)}・年 ${yen(total * 12)}</span></h3><div class="list">${groups[k].map((r) => `
      <div class="item" style="${r.active ? "" : "opacity:.5"}"><div><div class="title">${esc(r.name)}${r.variable ? '<span class="tag">変動</span>' : ""}${r.active ? "" : '<span class="tag">解約済み</span>'}</div>
        <div class="meta">${CYCLE_LABELS[r.cycle]}${r.cycle === "yearly" && r.billing_month ? `${r.billing_month}月` : ""}${r.billing_day ? `${r.billing_day}日` : ""}${accName(r.account_id) ? `・${esc(accName(r.account_id))}` : ""}${r.note ? `・${esc(r.note)}` : ""}</div></div>
        <div class="right"><div class="title">${yen(r.amount)}</div>${r.cycle !== "monthly" ? `<div class="meta">月 ${yen(monthly(r))}</div>` : ""}
          <div><button class="link-btn" data-edit-rec="${r.id}">編集</button><button class="link-btn danger" data-del-rec="${r.id}">削除</button></div></div></div>`).join("")}</div>`;
  }).join("") || `<p class="muted">家賃・電気・ガス・水道・スマホ・ネット回線・サブスク・NISA積立などを登録しましょう。</p>`;
}
$("#recurring-list").addEventListener("click", async (e) => {
  const edit = e.target.dataset.editRec, del = e.target.dataset.delRec;
  if (edit) { fillForm(recForm, state.recurring.find((r) => r.id === +edit)); syncRecFields(); }
  if (del && confirm("削除しますか？（解約した場合は「契約中」を外すと履歴が残ります）")) { await api(`/api/recurring/${del}`, { method: "DELETE" }); toast("削除しました"); loadRecurring(); }
});
recForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = formData(recForm);
  const id = data.id; delete data.id;
  try {
    await api(id ? `/api/recurring/${id}` : "/api/recurring", { method: id ? "PUT" : "POST", json: data });
    toast("保存しました"); recForm.reset(); recForm.id.value = ""; loadRecurring();
  } catch (err) { toast(`保存できませんでした: ${err.message}`); }
});
recForm.addEventListener("reset", () => setTimeout(() => { recForm.id.value = ""; syncRecFields(); }));

// ------------------------------------------------------------------ wishlist
const wishForm = $("#wish-form");
let wishCache = [];
async function loadWishlist() {
  const [items, dash] = await Promise.all([api("/api/wishlist"), api("/api/dashboard")]);
  wishCache = items;
  const analysis = Object.fromEntries(dash.wishlist.map((w) => [w.id, w]));
  const PRIO = { 1: "高", 2: "中", 3: "低" };
  const STATUS = { want: "", bought: "買った", dropped: "見送り" };
  $("#wish-list").innerHTML = items.length ? `<div class="list">${items.map((it) => {
    const a = analysis[it.id];
    return `<div class="item" style="${it.status === "want" ? "" : "opacity:.55"}"><div>
      <div class="title">${it.url ? `<a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.name)}</a>` : esc(it.name)}<span class="tag">優先度 ${PRIO[it.priority]}</span>${STATUS[it.status] ? `<span class="tag">${STATUS[it.status]}</span>` : ""}</div>
      <div class="meta">${a ? `<span class="verdict-${a.verdict}">${VERDICT_TEXT[a.verdict]}</span>${a.months_to_save ? `・貯めるなら約${a.months_to_save}か月` : ""}` : ""}${it.target_date ? `・${it.target_date} まで` : ""}${it.note ? `・${esc(it.note)}` : ""}</div></div>
      <div class="right"><div class="title">${yen(it.price)}</div>${it.saved ? `<div class="meta">取り分け ${yen(it.saved)}</div>` : ""}
        <div><button class="link-btn" data-edit-wish="${it.id}">編集</button><button class="link-btn danger" data-del-wish="${it.id}">削除</button></div></div></div>`;
  }).join("")}</div>` : `<p class="muted">ほしいものを登録すると、今買えるか・何か月で貯まるかを判定します。</p>`;
}
$("#wish-list").addEventListener("click", async (e) => {
  const edit = e.target.dataset.editWish, del = e.target.dataset.delWish;
  if (edit) fillForm(wishForm, wishCache.find((w) => w.id === +edit));
  if (del && confirm("削除しますか？")) { await api(`/api/wishlist/${del}`, { method: "DELETE" }); loadWishlist(); }
});
wishForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = formData(wishForm);
  const id = data.id; delete data.id;
  data.saved ??= 0;
  try {
    await api(id ? `/api/wishlist/${id}` : "/api/wishlist", { method: id ? "PUT" : "POST", json: data });
    toast("保存しました"); wishForm.reset(); wishForm.id.value = ""; loadWishlist();
  } catch (err) { toast(`保存できませんでした: ${err.message}`); }
});

// ------------------------------------------------------------------ advice
async function loadAdvice() {
  const [s, hist] = await Promise.all([api("/api/advice/status"), api("/api/advice/history")]);
  $("#ai-status").innerHTML = s.ai_enabled
    ? `Claude（${esc(s.model)}）が家計の集計値をもとに回答します。個々の明細の内容は送信しません。`
    : `ANTHROPIC_API_KEY が未設定のため、ルールベースの簡易診断で回答します。`;
  $("#advice-history").innerHTML = hist.length ? hist.map((h) => `<details class="history-item"><summary>${esc(h.created_at)}　${esc(h.question || "今月の診断")} <span class="tag">${h.mode === "ai" ? "AI" : "簡易"}</span></summary><div class="md">${renderMarkdown(h.answer)}</div></details>`).join("")
    : `<p class="muted">まだ相談履歴はありません。</p>`;
}
async function ask(question) {
  const out = $("#advice-out");
  const btn = $("#advice-form button");
  btn.disabled = true;
  out.className = "md loading"; out.innerHTML = "";
  try {
    const r = await api("/api/advice", { method: "POST", json: { question } });
    out.className = "md"; out.innerHTML = renderMarkdown(r.answer);
    loadAdvice();
  } catch (err) { out.className = "md neg"; out.textContent = err.message; }
  finally { btn.disabled = false; }
}
$("#advice-form").addEventListener("submit", (e) => { e.preventDefault(); ask(e.target.question.value.trim()); });
$(".chips").addEventListener("click", (e) => { if (e.target.dataset.q !== undefined) { $("#advice-form").question.value = e.target.dataset.q; ask(e.target.dataset.q); } });

// ------------------------------------------------------------------ settings
const setForm = $("#settings-form");
function catBudgetRow(cat = "", amount = "") {
  const row = document.createElement("div");
  row.className = "cat-budget-row";
  row.innerHTML = `<input class="cb-name" list="category-list" placeholder="カテゴリ" value="${esc(cat)}"><input class="cb-amt" type="number" min="0" placeholder="円" value="${esc(amount)}"><button type="button" class="link-btn danger">削除</button>`;
  row.querySelector("button").addEventListener("click", () => row.remove());
  $("#cat-budgets").append(row);
}
async function loadSettings() {
  await refreshRefs();
  const s = await api("/api/settings");
  for (const k of ["monthly_income", "cycle_start_day", "savings_goal", "emergency_fund_months"]) setForm[k].value = s[k];
  $("#cat-budgets").innerHTML = "";
  Object.entries(s.category_budgets || {}).forEach(([c, a]) => catBudgetRow(c, a));
}
$("#add-cat-budget").addEventListener("click", () => catBudgetRow());
setForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {};
  for (const k of ["monthly_income", "cycle_start_day", "savings_goal", "emergency_fund_months"]) body[k] = Number(setForm[k].value || 0);
  body.cycle_start_day = Math.min(31, Math.max(1, body.cycle_start_day || 1));
  body.category_budgets = {};
  $$(".cat-budget-row").forEach((r) => {
    const n = r.querySelector(".cb-name").value.trim(), a = Number(r.querySelector(".cb-amt").value || 0);
    if (n && a > 0) body.category_budgets[n] = a;
  });
  await api("/api/settings", { method: "PUT", json: body });
  toast("保存しました");
});

// ------------------------------------------------------------------ boot
let initialTab = "dashboard";
try { initialTab = localStorage.getItem("tab") || "dashboard"; } catch {}
refreshRefs().then(() => showTab(initialTab));
