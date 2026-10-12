"""DB から読み出して finance の集計をまとめる層。"""
from __future__ import annotations

import sqlite3
from datetime import date
from typing import Any

from . import db, finance


def match_recurring(conn: sqlite3.Connection, description: str) -> int | None:
    """明細の内容が固定費の match_keyword を含めば、その固定費の id を返す。"""
    text = (description or "").upper()
    for r in db.rows(conn, "SELECT id, match_keyword FROM recurring WHERE active = 1 AND match_keyword != ''"):
        for kw in r["match_keyword"].split(","):
            kw = kw.strip().upper()
            if kw and kw in text:
                return r["id"]
    return None


def dashboard(conn: sqlite3.Connection, today: date | None = None) -> dict[str, Any]:
    today = today or date.today()
    settings = db.get_settings(conn)
    accounts = db.rows(conn, "SELECT * FROM accounts WHERE archived = 0 ORDER BY id")
    recurring = db.rows(conn, "SELECT * FROM recurring ORDER BY kind, amount DESC")
    # 直近 5 期分あれば集計には十分
    transactions = db.rows(
        conn, "SELECT * FROM transactions WHERE date >= date(?, '-200 days') ORDER BY date DESC, id DESC",
        (today.isoformat(),))
    wishlist = db.rows(conn, "SELECT * FROM wishlist ORDER BY priority, created_at")

    budget = finance.budget_summary(settings, recurring, transactions, today)
    cards = [finance.card_status(a, transactions, today) for a in accounts if a["kind"] == "card"]
    worth = finance.net_worth(accounts, cards)
    shortfalls = finance.payment_shortfalls(accounts, cards, recurring, today)
    wishes = finance.wishlist_analysis(wishlist, budget, worth, settings.get("emergency_fund_months", 6))
    emergency = finance.emergency_fund(worth, budget, settings.get("emergency_fund_months", 6))

    return {
        "today": today.isoformat(),
        "settings": settings,
        "budget": budget,
        "cards": cards,
        "net_worth": worth,
        "net_worth_history": net_worth_history(conn),
        "payment_checks": shortfalls,
        "wishlist": wishes,
        "emergency_fund": emergency,
        "accounts": accounts,
        "recurring": recurring,
        "recent_transactions": transactions[:15],
    }


def net_worth_history(conn: sqlite3.Connection) -> list[dict]:
    """月末時点の各口座の最新スナップショットを積み上げた純資産推移（カード未払いは含まない）。"""
    snaps = db.rows(conn, """
        SELECT s.account_id, s.date, s.balance, a.kind FROM balance_snapshots s
        JOIN accounts a ON a.id = s.account_id WHERE a.archived = 0 AND a.kind != 'card'
        ORDER BY s.date""")
    if not snaps:
        return []
    months = sorted({s["date"][:7] for s in snaps})
    latest: dict[int, dict] = {}
    out = []
    i = 0
    for ym in months:
        while i < len(snaps) and snaps[i]["date"][:7] <= ym:
            latest[snaps[i]["account_id"]] = snaps[i]
            i += 1
        point = {"month": ym, "liquid": 0, "invest": 0, "pension": 0, "other": 0, "liability": 0}
        for s in latest.values():
            k = s["kind"]
            key = ("liquid" if k in finance.LIQUID_KINDS else "invest" if k in finance.INVEST_KINDS
                   else "pension" if k in finance.PENSION_KINDS else "liability" if k in finance.LIABILITY_KINDS
                   else "other")
            point[key] += int(s["balance"])
        point["net_worth"] = point["liquid"] + point["invest"] + point["pension"] + point["other"] - point["liability"]
        out.append(point)
    return out[-24:]


def record_snapshot(conn: sqlite3.Connection, account_id: int, balance: int, contributed: int | None,
                    on: date | None = None) -> None:
    on = on or date.today()
    conn.execute(
        "INSERT INTO balance_snapshots(account_id, date, balance, contributed) VALUES (?, ?, ?, ?) "
        "ON CONFLICT(account_id, date) DO UPDATE SET balance = excluded.balance, contributed = excluded.contributed",
        (account_id, on.isoformat(), balance, contributed))
