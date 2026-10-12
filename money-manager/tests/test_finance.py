from datetime import date

from app import finance


def tx(d, amount, **kw):
    return {"date": d, "amount": amount, "type": kw.pop("type", "expense"), "category": kw.pop("category", "食費"),
            "account_id": kw.pop("account_id", None), "recurring_id": kw.pop("recurring_id", None), **kw}


def test_period_bounds_calendar_month():
    assert finance.period_bounds(date(2026, 10, 12), 1) == (date(2026, 10, 1), date(2026, 11, 1))


def test_period_bounds_payday_start():
    assert finance.period_bounds(date(2026, 10, 12), 25) == (date(2026, 9, 25), date(2026, 10, 25))
    assert finance.period_bounds(date(2026, 10, 25), 25) == (date(2026, 10, 25), date(2026, 11, 25))
    # 31 日始まりは短い月で月末に丸める
    assert finance.period_bounds(date(2026, 3, 1), 31) == (date(2026, 2, 28), date(2026, 3, 31))


def test_monthly_equivalent():
    assert finance.monthly_equivalent({"amount": 1200, "cycle": "monthly"}) == 1200
    assert finance.monthly_equivalent({"amount": 6000, "cycle": "yearly"}) == 500
    assert finance.monthly_equivalent({"amount": 1000, "cycle": "weekly"}) == 4333


def test_recurring_occurrences_yearly_only_in_its_month():
    r = {"amount": 5900, "cycle": "yearly", "billing_day": 8, "billing_month": 3}
    assert finance.recurring_occurrences(r, date(2026, 2, 25), date(2026, 3, 25)) == [date(2026, 3, 8)]
    assert finance.recurring_occurrences(r, date(2026, 3, 25), date(2026, 4, 25)) == []


def test_budget_remaining_and_daily_allowance():
    settings = {"monthly_income": 300000, "cycle_start_day": 1, "savings_goal": 30000}
    recurring = [
        {"id": 1, "name": "家賃", "kind": "fixed", "amount": 90000, "cycle": "monthly", "billing_day": 27, "active": 1},
        {"id": 2, "name": "NISA", "kind": "investment", "amount": 30000, "cycle": "monthly", "billing_day": 1, "active": 1},
    ]
    transactions = [
        tx("2026-10-02", 50000),
        tx("2026-10-10", 10000),
        tx("2026-10-11", 90000, recurring_id=1),   # 固定費の明細は変動費に数えない
        tx("2026-09-30", 99999),                   # 期間外
        tx("2026-10-05", 300000, type="income"),
    ]
    b = finance.budget_summary(settings, recurring, transactions, date(2026, 10, 11))
    assert b["variable_budget"] == 300000 - 90000 - 30000 - 30000   # 150,000
    assert b["spent"] == 60000
    assert b["remaining"] == 90000
    assert b["period"]["days_left"] == 21                            # 11 日〜31 日
    assert b["daily_allowance"] == 90000 // 21
    # 11 日/31 日 時点の予定は 150000*11/31 ≈ 53,226 → ペース 1.13 = 月末に超える見込み
    assert b["status"] == "warning"
    assert b["projected_spent"] > b["variable_budget"]
    assert b["fixed_charged"] == 90000


def test_budget_status_warning_and_over():
    settings = {"monthly_income": 100000, "cycle_start_day": 1, "savings_goal": 0}
    b = finance.budget_summary(settings, [], [tx("2026-10-02", 10000)], date(2026, 10, 5))
    assert b["status"] == "ok"
    b = finance.budget_summary(settings, [], [tx("2026-10-02", 50000)], date(2026, 10, 5))
    assert b["status"] == "warning"
    b = finance.budget_summary(settings, [], [tx("2026-10-02", 120000)], date(2026, 10, 5))
    assert b["status"] == "over" and b["remaining"] == -20000


def test_today_spent_is_part_of_today_allowance():
    settings = {"monthly_income": 31000, "cycle_start_day": 1}
    b = finance.budget_summary(settings, [], [tx("2026-10-01", 400)], date(2026, 10, 1))
    assert b["daily_allowance"] == 1000
    assert b["today_remaining"] == 600


def test_category_budget():
    settings = {"monthly_income": 300000, "category_budgets": {"食費": 30000, "外食": 10000}}
    b = finance.budget_summary(settings, [], [tx("2026-10-02", 12000, category="外食")], date(2026, 10, 10))
    cats = {c["category"]: c for c in b["categories"]}
    assert cats["外食"]["remaining"] == -2000
    assert cats["食費"]["spent"] == 0


def test_card_cycle_month_end_closing():
    # 月末締め・翌月27日払い。10/12 時点: 9月分は 10/27 払い（確定）、10月分は利用中
    card = {"id": 7, "name": "楽天", "closing_day": 31, "payment_day": 27, "card_limit": 100000}
    txs = [tx("2026-09-03", 20000, account_id=7), tx("2026-09-30", 5000, account_id=7),
           tx("2026-10-01", 3000, account_id=7), tx("2026-10-12", 1000, account_id=7),
           tx("2026-10-05", 999, account_id=8)]
    s = finance.card_status(card, txs, date(2026, 10, 12))
    assert s["next_payment"] == {"date": "2026-10-27", "amount": 25000, "confirmed": True, "source": "estimate"}
    assert s["current_cycle"]["amount"] == 4000
    assert s["unpaid_total"] == 29000
    assert s["limit_usage"] == 0.29


def test_card_cycle_after_payment_day():
    # 15日締め・翌月10日払い。10/12 時点: 9/16-10/15 は利用中、8/16-9/15 分は 10/10 に支払済み
    card = {"id": 1, "name": "三井住友", "closing_day": 15, "payment_day": 10}
    txs = [tx("2026-09-10", 8000, account_id=1), tx("2026-09-20", 2000, account_id=1)]
    s = finance.card_status(card, txs, date(2026, 10, 12))
    assert s["current_cycle"]["start"] == "2026-09-16"
    assert s["next_payment"] == {"date": "2026-11-10", "amount": 2000, "confirmed": False, "source": "estimate"}
    assert s["unpaid_total"] == 2000


def test_card_uses_emailed_bill_even_when_payment_day_shifts():
    # 27日払いが休日で 28日に。今日 10/27 でもまだ未払いとして扱い、明細より請求額を優先
    card = {"id": 7, "name": "楽天", "closing_day": 31, "payment_day": 27}
    txs = [tx("2026-09-10", 20000, account_id=7), tx("2026-10-02", 3000, account_id=7)]
    bills = [{"payment_date": "2026-09-28", "amount": 99999, "confirmed": 1},   # 先月分（支払済み）
             {"payment_date": "2026-10-28", "amount": 150000, "confirmed": 1}]
    s = finance.card_status(card, txs, date(2026, 10, 27), bills)
    assert s["next_payment"]["amount"] == 150000
    assert s["next_payment"]["date"] == "2026-10-28"
    assert s["next_payment"]["source"] == "email"
    assert s["next_payment"]["tracked_amount"] == 20000
    assert s["unpaid_total"] == 150000 + 3000


def test_net_worth_separates_locked_pension():
    accounts = [
        {"id": 1, "kind": "bank", "name": "銀行", "balance": 500000},
        {"id": 2, "kind": "nisa", "name": "NISA", "balance": 1100000, "contributed": 1000000},
        {"id": 3, "kind": "ideco", "name": "iDeCo", "balance": 800000, "contributed": 900000},
        {"id": 4, "kind": "loan", "name": "奨学金", "balance": 200000},
        {"id": 5, "kind": "card", "name": "カード", "balance": 0},
    ]
    cards = [{"unpaid_total": 50000}]
    w = finance.net_worth(accounts, cards)
    assert w["liquid"] == 500000 and w["invest"] == 1100000 and w["pension"] == 800000
    assert w["liability"] == 250000
    assert w["net_worth"] == 2400000 - 250000
    assert w["spendable"] == 450000
    ideco = next(i for i in w["investments"] if i["kind"] == "ideco")
    assert ideco["locked"] and ideco["gain"] == -100000


def test_payment_shortfall():
    accounts = [{"id": 1, "kind": "bank", "name": "給与口座", "balance": 30000},
                {"id": 2, "kind": "card", "name": "カード", "balance": 0}]
    cards = [{"payment_account_id": 1, "next_payment": {"date": "2026-10-27", "amount": 40000}}]
    recurring = [{"name": "家賃", "amount": 80000, "cycle": "monthly", "billing_day": 27, "account_id": 1, "active": 1},
                 {"name": "Netflix", "amount": 1590, "cycle": "monthly", "billing_day": 3, "account_id": 2, "active": 1}]
    out = finance.payment_shortfalls(accounts, cards, recurring, date(2026, 10, 12), horizon_days=20)
    assert out == [{"account_id": 1, "account": "給与口座", "balance": 30000, "due_amount": 120000, "shortfall": 90000}]


def test_wishlist_verdicts():
    budget = {"fixed_monthly": 100000, "avg_variable_spent": 100000, "variable_budget": 120000,
              "projected_spent": 100000, "income": 250000, "investment_monthly": 0, "remaining": 30000}
    worth = {"spendable": 1500000}
    items = [{"id": 1, "name": "イヤホン", "price": 20000, "saved": 0, "priority": 2},
             {"id": 2, "name": "PC", "price": 300000, "saved": 0, "priority": 1},
             {"id": 3, "name": "車", "price": 2000000, "saved": 0, "priority": 3}]
    res = {r["name"]: r for r in finance.wishlist_analysis(items, budget, worth, 6)}
    assert res["イヤホン"]["verdict"] == "buy_ok"
    assert res["PC"]["verdict"] == "buy_from_savings"   # 防衛資金 120 万を残しても買える
    assert res["PC"]["months_to_save"] == 6             # 余剰 5 万/月
    assert res["車"]["verdict"] == "wait"
