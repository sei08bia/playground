"""家計の集計ロジック（DB に依存しない純粋関数）。

金額はすべて円の整数。取引の amount は常に正で、向きは type（expense/income/transfer）で表す。
"""
from __future__ import annotations

import calendar
import math
from collections import defaultdict
from datetime import date, timedelta
from typing import Any, Iterable

LIQUID_KINDS = {"bank", "cash", "emoney"}
INVEST_KINDS = {"securities", "nisa"}
PENSION_KINDS = {"ideco", "dc"}
LIABILITY_KINDS = {"loan"}

KIND_LABELS = {
    "bank": "銀行口座",
    "cash": "現金",
    "emoney": "電子マネー",
    "card": "クレジットカード",
    "securities": "証券口座（特定・一般）",
    "nisa": "NISA",
    "ideco": "iDeCo",
    "dc": "企業型DC",
    "loan": "ローン",
    "other": "その他資産",
}

RECURRING_KIND_LABELS = {
    "subscription": "サブスク",
    "utility": "インフラ（光熱費・通信）",
    "fixed": "固定費（家賃・保険など）",
    "investment": "積立投資・掛金",
}


# ---------------------------------------------------------------- 日付ユーティリティ

def clamp_day(year: int, month: int, day: int) -> date:
    """存在しない日（2/30 など）は月末に丸める。"""
    return date(year, month, min(day, calendar.monthrange(year, month)[1]))


def add_months(year: int, month: int, delta: int) -> tuple[int, int]:
    idx = year * 12 + (month - 1) + delta
    return idx // 12, idx % 12 + 1


def period_bounds(today: date, start_day: int = 1) -> tuple[date, date]:
    """今日を含む家計期間 [start, end) を返す。start_day=25 なら 25 日始まり（給料日起点）。"""
    start_day = max(1, min(int(start_day or 1), 31))
    this_start = clamp_day(today.year, today.month, start_day)
    if today >= this_start:
        start = this_start
    else:
        y, m = add_months(today.year, today.month, -1)
        start = clamp_day(y, m, start_day)
    y, m = add_months(start.year, start.month, 1)
    end = clamp_day(y, m, start_day)
    return start, end


def previous_periods(today: date, start_day: int, n: int) -> list[tuple[date, date]]:
    out = []
    start, _ = period_bounds(today, start_day)
    for _ in range(n):
        start, end = period_bounds(start - timedelta(days=1), start_day)
        out.append((start, end))
    return out


def parse_date(value: str | date) -> date:
    return value if isinstance(value, date) else date.fromisoformat(str(value)[:10])


def in_range(d: str | date, start: date, end: date) -> bool:
    return start <= parse_date(d) < end


# ---------------------------------------------------------------- 固定費・サブスク

def monthly_equivalent(rec: dict) -> int:
    amount = int(rec.get("amount") or 0)
    cycle = rec.get("cycle") or "monthly"
    if cycle == "yearly":
        return round(amount / 12)
    if cycle == "weekly":
        return round(amount * 52 / 12)
    return amount


def recurring_occurrences(rec: dict, start: date, end: date) -> list[date]:
    """期間 [start, end) 内の請求日。"""
    cycle = rec.get("cycle") or "monthly"
    day = int(rec.get("billing_day") or 1)
    out: list[date] = []
    if cycle == "weekly":
        # billing_day を曜日 (0=月) として扱う
        d = start + timedelta(days=(day % 7 - start.weekday()) % 7)
        while d < end:
            out.append(d)
            d += timedelta(days=7)
        return out
    y, m = start.year, start.month
    while date(y, m, 1) < end:
        if cycle == "monthly" or int(rec.get("billing_month") or 1) == m:
            d = clamp_day(y, m, day)
            if start <= d < end:
                out.append(d)
        y, m = add_months(y, m, 1)
    return out


def recurring_summary(recurring: Iterable[dict], start: date, end: date, today: date) -> dict:
    active = [r for r in recurring if r.get("active", 1)]
    by_kind: dict[str, int] = defaultdict(int)
    upcoming = []
    for r in active:
        by_kind[r["kind"]] += monthly_equivalent(r)
        # 「これからの引き落とし」は期間の区切りに関係なく今日から 1 か月分
        for d in recurring_occurrences(r, today, today + timedelta(days=31)):
            upcoming.append({"date": d.isoformat(), "name": r["name"], "amount": int(r["amount"]),
                             "kind": r["kind"], "variable": bool(r.get("variable")),
                             "account_id": r.get("account_id")})
    upcoming.sort(key=lambda x: x["date"])
    subs = [r for r in active if r["kind"] == "subscription"]
    return {
        "monthly_by_kind": dict(by_kind),
        "monthly_total": sum(by_kind.values()),
        "monthly_spending": sum(v for k, v in by_kind.items() if k != "investment"),
        "monthly_investment": by_kind.get("investment", 0),
        "subscription_count": len(subs),
        "subscription_monthly": sum(monthly_equivalent(r) for r in subs),
        "subscription_yearly": sum(monthly_equivalent(r) for r in subs) * 12,
        "upcoming": upcoming,
    }


# ---------------------------------------------------------------- 予算・ペース

def _expenses(transactions: Iterable[dict], start: date, end: date) -> list[dict]:
    return [t for t in transactions if t["type"] == "expense" and in_range(t["date"], start, end)]


def variable_spending(transactions: Iterable[dict], start: date, end: date) -> int:
    """固定費として紐づいていない支出（＝自分でコントロールできる支出）の合計。"""
    return sum(int(t["amount"]) for t in _expenses(transactions, start, end) if not t.get("recurring_id"))


def budget_summary(settings: dict, recurring: list[dict], transactions: list[dict], today: date) -> dict[str, Any]:
    start, end = period_bounds(today, settings.get("cycle_start_day", 1))
    total_days = (end - start).days
    elapsed_days = (today - start).days + 1          # 今日を含む
    days_left = total_days - elapsed_days + 1         # 今日を含む

    rec = recurring_summary(recurring, start, end, today)
    planned_income = int(settings.get("monthly_income") or 0)
    actual_income = sum(int(t["amount"]) for t in transactions
                        if t["type"] == "income" and in_range(t["date"], start, end))
    income = planned_income or actual_income
    savings_goal = int(settings.get("savings_goal") or 0)

    variable_budget = income - rec["monthly_spending"] - rec["monthly_investment"] - savings_goal
    expenses = _expenses(transactions, start, end)
    spent = sum(int(t["amount"]) for t in expenses if not t.get("recurring_id"))
    fixed_charged = sum(int(t["amount"]) for t in expenses if t.get("recurring_id"))
    today_spent = sum(int(t["amount"]) for t in expenses
                      if not t.get("recurring_id") and parse_date(t["date"]) == today)

    remaining = variable_budget - spent
    # 今日の分を含めて残り日数で割る（今日すでに使った分は今日の枠から引いて表示する）
    daily_allowance = math.floor((remaining + today_spent) / days_left) if days_left > 0 else remaining
    expected_by_now = variable_budget * elapsed_days / total_days if total_days else 0
    pace_ratio = (spent / expected_by_now) if expected_by_now > 0 else None
    projected = round(spent / elapsed_days * total_days) if elapsed_days > 0 else spent

    if variable_budget <= 0 and income > 0:
        status = "deficit"       # 固定費と貯金だけで収入を超えている
    elif remaining < 0:
        status = "over"
    elif pace_ratio is not None and pace_ratio > 1.05:   # このままだと月末に予算を超える
        status = "warning"
    else:
        status = "ok"

    by_cat: dict[str, int] = defaultdict(int)
    for t in expenses:
        if not t.get("recurring_id"):
            by_cat[t["category"] or "未分類"] += int(t["amount"])
    budgets = settings.get("category_budgets") or {}
    categories = []
    for cat in sorted(set(by_cat) | set(budgets), key=lambda c: -by_cat.get(c, 0)):
        b = int(budgets.get(cat) or 0)
        s = by_cat.get(cat, 0)
        categories.append({
            "category": cat, "spent": s, "budget": b or None,
            "remaining": (b - s) if b else None,
            "ratio": (s / b) if b else None,
            "pace_ratio": (s / (b * elapsed_days / total_days)) if b else None,
        })

    history = []
    for p_start, p_end in previous_periods(today, settings.get("cycle_start_day", 1), 3):
        history.append({"start": p_start.isoformat(), "end": p_end.isoformat(),
                        "variable_spent": variable_spending(transactions, p_start, p_end)})
    with_data = [h["variable_spent"] for h in history if h["variable_spent"] > 0]
    avg_variable = round(sum(with_data) / len(with_data)) if with_data else None

    return {
        "period": {"start": start.isoformat(), "end": (end - timedelta(days=1)).isoformat(),
                   "total_days": total_days, "elapsed_days": elapsed_days, "days_left": days_left},
        "income": income, "planned_income": planned_income, "actual_income": actual_income,
        "fixed_monthly": rec["monthly_spending"], "investment_monthly": rec["monthly_investment"],
        "savings_goal": savings_goal,
        "variable_budget": variable_budget,
        "spent": spent, "today_spent": today_spent, "fixed_charged": fixed_charged,
        "remaining": remaining,
        "daily_allowance": daily_allowance,
        "today_remaining": daily_allowance - today_spent,
        "expected_by_now": round(expected_by_now),
        "pace_ratio": pace_ratio,
        "projected_spent": projected,
        "projected_surplus": variable_budget - projected,
        "status": status,
        "categories": categories,
        "history": history,
        "avg_variable_spent": avg_variable,
        "recurring": rec,
    }


# ---------------------------------------------------------------- クレジットカード

def _closing_date(year: int, month: int, closing_day: int) -> date:
    return clamp_day(year, month, closing_day)


def card_cycles(today: date, closing_day: int) -> dict[str, tuple[date, date]]:
    """締め日から「今の利用期間」と「直近で締まった期間」を返す（どちらも両端含む）。"""
    close_this = _closing_date(today.year, today.month, closing_day)
    if today <= close_this:
        cur_end = close_this
    else:
        y, m = add_months(today.year, today.month, 1)
        cur_end = _closing_date(y, m, closing_day)
    py, pm = add_months(cur_end.year, cur_end.month, -1)
    prev_end = _closing_date(py, pm, closing_day)
    ppy, ppm = add_months(prev_end.year, prev_end.month, -1)
    prev_prev_end = _closing_date(ppy, ppm, closing_day)
    return {
        "current": (prev_end + timedelta(days=1), cur_end),
        "last_closed": (prev_prev_end + timedelta(days=1), prev_end),
    }


def payment_date_for(cycle_end: date, payment_day: int) -> date:
    y, m = add_months(cycle_end.year, cycle_end.month, 1)
    return clamp_day(y, m, payment_day)


def card_status(card: dict, transactions: list[dict], today: date) -> dict[str, Any]:
    closing = int(card.get("closing_day") or 31)
    pay_day = int(card.get("payment_day") or 27)
    cycles = card_cycles(today, closing)
    mine = [t for t in transactions if t.get("account_id") == card["id"] and t["type"] == "expense"]

    def total(rng: tuple[date, date]) -> int:
        s, e = rng
        return sum(int(t["amount"]) for t in mine if s <= parse_date(t["date"]) <= e)

    current_amount = total(cycles["current"])
    closed_amount = total(cycles["last_closed"])
    closed_pay = payment_date_for(cycles["last_closed"][1], pay_day)
    current_pay = payment_date_for(cycles["current"][1], pay_day)

    if closed_pay >= today:
        next_payment = {"date": closed_pay.isoformat(), "amount": closed_amount, "confirmed": True}
        unpaid = closed_amount + current_amount
    else:
        next_payment = {"date": current_pay.isoformat(), "amount": current_amount, "confirmed": False}
        unpaid = current_amount
    limit = card.get("card_limit")
    return {
        "id": card["id"], "name": card["name"], "institution": card.get("institution", ""),
        "closing_day": closing, "payment_day": pay_day,
        "current_cycle": {"start": cycles["current"][0].isoformat(), "end": cycles["current"][1].isoformat(),
                          "amount": current_amount},
        "next_payment": next_payment,
        "unpaid_total": unpaid,
        "limit": limit,
        "limit_usage": (unpaid / limit) if limit else None,
        "payment_account_id": card.get("payment_account_id"),
    }


# ---------------------------------------------------------------- 資産

def net_worth(accounts: list[dict], cards: list[dict]) -> dict[str, Any]:
    groups = {"liquid": 0, "invest": 0, "pension": 0, "other": 0, "liability": 0}
    invest_detail = []
    for a in accounts:
        if a.get("archived"):
            continue
        kind, bal = a["kind"], int(a.get("balance") or 0)
        if kind == "card":
            continue
        if kind in LIQUID_KINDS:
            groups["liquid"] += bal
        elif kind in INVEST_KINDS:
            groups["invest"] += bal
        elif kind in PENSION_KINDS:
            groups["pension"] += bal
        elif kind in LIABILITY_KINDS:
            groups["liability"] += bal
        else:
            groups["other"] += bal
        if kind in INVEST_KINDS | PENSION_KINDS:
            contributed = a.get("contributed")
            invest_detail.append({
                "id": a["id"], "name": a["name"], "kind": kind, "balance": bal,
                "contributed": contributed,
                "gain": (bal - contributed) if contributed is not None else None,
                "gain_ratio": ((bal - contributed) / contributed) if contributed else None,
                "locked": kind in PENSION_KINDS,
            })
    card_debt = sum(c["unpaid_total"] for c in cards)
    groups["liability"] += card_debt
    assets = groups["liquid"] + groups["invest"] + groups["pension"] + groups["other"]
    return {
        **groups,
        "card_unpaid": card_debt,
        "total_assets": assets,
        "net_worth": assets - groups["liability"],
        # すぐ使えるお金 = 預金・現金 − カード未払い
        "spendable": groups["liquid"] - card_debt,
        "investments": invest_detail,
    }


def payment_shortfalls(accounts: list[dict], cards: list[dict], recurring: list[dict],
                       today: date, horizon_days: int = 31) -> list[dict]:
    """引き落とし口座ごとに、近い引き落とし予定額が残高を超えていないか。"""
    by_id = {a["id"]: a for a in accounts}
    horizon = today + timedelta(days=horizon_days)
    due: dict[int, int] = defaultdict(int)
    for c in cards:
        acc = c.get("payment_account_id")
        if acc and parse_date(c["next_payment"]["date"]) <= horizon:
            due[acc] += c["next_payment"]["amount"]
    for r in recurring:
        acc = r.get("account_id")
        if not r.get("active", 1) or not acc or by_id.get(acc, {}).get("kind") == "card":
            continue
        due[acc] += sum(int(r["amount"]) for _ in recurring_occurrences(r, today, horizon))
    out = []
    for acc_id, amount in due.items():
        a = by_id.get(acc_id)
        if not a:
            continue
        bal = int(a.get("balance") or 0)
        out.append({"account_id": acc_id, "account": a["name"], "balance": bal,
                    "due_amount": amount, "shortfall": max(0, amount - bal)})
    return sorted(out, key=lambda x: -x["shortfall"])


# ---------------------------------------------------------------- ほしいもの

def wishlist_analysis(items: list[dict], budget: dict, worth: dict, emergency_months: int) -> list[dict]:
    monthly_living = budget["fixed_monthly"] + (budget["avg_variable_spent"] or budget["variable_budget"] or 0)
    emergency_target = monthly_living * int(emergency_months or 0)
    # 毎月の余剰の見込み: 収入 − 固定費 − 積立 − 普段の変動費
    typical_variable = budget["avg_variable_spent"] if budget["avg_variable_spent"] is not None else budget["projected_spent"]
    monthly_surplus = budget["income"] - budget["fixed_monthly"] - budget["investment_monthly"] - typical_variable
    out = []
    for it in items:
        if it.get("status", "want") != "want":
            continue
        need = max(0, int(it["price"]) - int(it.get("saved") or 0))
        months = 0 if need == 0 else (math.ceil(need / monthly_surplus) if monthly_surplus > 0 else None)
        fits_this_month = need <= max(0, budget["remaining"])
        keeps_emergency = (worth["spendable"] - need) >= emergency_target
        if need == 0 or fits_this_month:
            verdict = "buy_ok"             # 今月の変動費の枠内なので貯金は減らない
        elif keeps_emergency:
            verdict = "buy_from_savings"   # 今月の枠は超えるが貯金から出せる
        else:
            verdict = "wait"
        out.append({**it, "need": need, "months_to_save": months, "fits_this_month": fits_this_month,
                    "keeps_emergency_fund": keeps_emergency, "verdict": verdict})
    return sorted(out, key=lambda x: (x.get("priority", 2), x["need"]))


def emergency_fund(worth: dict, budget: dict, months_target: int) -> dict:
    monthly_living = budget["fixed_monthly"] + (budget["avg_variable_spent"] or budget["variable_budget"] or 0)
    months = (worth["spendable"] / monthly_living) if monthly_living > 0 else None
    return {"monthly_living": monthly_living, "months_covered": months,
            "target_months": months_target, "target_amount": monthly_living * int(months_target or 0)}
