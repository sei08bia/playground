"""お金の見える化アプリ — FastAPI エントリポイント。

起動: uvicorn app.main:app --reload  →  http://localhost:8000
"""
from __future__ import annotations

from collections import Counter
from datetime import date
from pathlib import Path
from typing import Literal, Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import advisor, csv_import, db, service

STATIC = Path(__file__).resolve().parent.parent / "static"
app = FastAPI(title="お金の見える化")

AccountKind = Literal["bank", "cash", "emoney", "card", "securities", "nisa", "ideco", "dc", "loan", "other"]


class AccountIn(BaseModel):
    name: str
    kind: AccountKind
    institution: str = ""
    balance: int = 0
    contributed: Optional[int] = None
    closing_day: Optional[int] = Field(None, ge=1, le=31)
    payment_day: Optional[int] = Field(None, ge=1, le=31)
    payment_account_id: Optional[int] = None
    card_limit: Optional[int] = None
    note: str = ""


class TransactionIn(BaseModel):
    date: date
    amount: int = Field(gt=0)
    type: Literal["expense", "income", "transfer"] = "expense"
    category: str = "未分類"
    account_id: Optional[int] = None
    description: str = ""
    memo: str = ""
    recurring_id: Optional[int] = None


class RecurringIn(BaseModel):
    name: str
    kind: Literal["subscription", "utility", "fixed", "investment"]
    amount: int = Field(ge=0)
    cycle: Literal["monthly", "yearly", "weekly"] = "monthly"
    billing_day: Optional[int] = Field(None, ge=0, le=31)
    billing_month: Optional[int] = Field(None, ge=1, le=12)
    account_id: Optional[int] = None
    category: str = ""
    match_keyword: str = ""
    variable: bool = False
    active: bool = True
    note: str = ""


class WishIn(BaseModel):
    name: str
    price: int = Field(gt=0)
    priority: int = Field(2, ge=1, le=3)
    saved: int = 0
    target_date: Optional[date] = None
    url: str = ""
    status: Literal["want", "bought", "dropped"] = "want"
    note: str = ""


class AdviceIn(BaseModel):
    question: Optional[str] = None


def _insert(conn, table: str, data: dict) -> int:
    cols = ", ".join(data)
    marks = ", ".join("?" for _ in data)
    cur = conn.execute(f"INSERT INTO {table} ({cols}) VALUES ({marks})", list(data.values()))
    return cur.lastrowid


def _update(conn, table: str, item_id: int, data: dict) -> None:
    sets = ", ".join(f"{k} = ?" for k in data)
    cur = conn.execute(f"UPDATE {table} SET {sets} WHERE id = ?", [*data.values(), item_id])
    if cur.rowcount == 0:
        raise HTTPException(404, f"{table} {item_id} が見つかりません")


def _get(conn, table: str, item_id: int) -> dict:
    r = conn.execute(f"SELECT * FROM {table} WHERE id = ?", (item_id,)).fetchone()
    if not r:
        raise HTTPException(404, f"{table} {item_id} が見つかりません")
    return dict(r)


def _delete(conn, table: str, item_id: int) -> dict:
    cur = conn.execute(f"DELETE FROM {table} WHERE id = ?", (item_id,))
    if cur.rowcount == 0:
        raise HTTPException(404, f"{table} {item_id} が見つかりません")
    return {"ok": True}


def _dump(model: BaseModel) -> dict:
    out = model.model_dump()
    for k, v in out.items():
        if isinstance(v, date):
            out[k] = v.isoformat()
        elif isinstance(v, bool):
            out[k] = int(v)
    return out


# ------------------------------------------------------------------ ダッシュボード

@app.get("/api/dashboard")
def get_dashboard(today: Optional[date] = None):
    with db.session() as conn:
        return service.dashboard(conn, today)


@app.post("/api/advice")
def post_advice(body: AdviceIn):
    with db.session() as conn:
        dash = service.dashboard(conn)
    result = advisor.advise(dash, (body.question or "").strip() or None)
    with db.session() as conn:
        _insert(conn, "advice_log", {"question": body.question, "answer": result["answer"], "mode": result["mode"]})
    return result


@app.get("/api/advice/history")
def advice_history():
    with db.session() as conn:
        return db.rows(conn, "SELECT * FROM advice_log ORDER BY id DESC LIMIT 20")


@app.get("/api/advice/status")
def advice_status():
    return {"ai_enabled": advisor.has_credentials(), "model": advisor.MODEL}


# ------------------------------------------------------------------ 口座・資産

@app.get("/api/accounts")
def list_accounts():
    with db.session() as conn:
        return db.rows(conn, "SELECT * FROM accounts WHERE archived = 0 ORDER BY kind, id")


@app.post("/api/accounts")
def create_account(body: AccountIn):
    with db.session() as conn:
        new_id = _insert(conn, "accounts", _dump(body))
        if body.kind != "card":
            service.record_snapshot(conn, new_id, body.balance, body.contributed)
        return _get(conn, "accounts", new_id)


@app.put("/api/accounts/{account_id}")
def update_account(account_id: int, body: AccountIn):
    with db.session() as conn:
        data = _dump(body)
        data["updated_at"] = date.today().isoformat()
        _update(conn, "accounts", account_id, data)
        if body.kind != "card":
            service.record_snapshot(conn, account_id, body.balance, body.contributed)
        return _get(conn, "accounts", account_id)


@app.delete("/api/accounts/{account_id}")
def delete_account(account_id: int):
    with db.session() as conn:
        _update(conn, "accounts", account_id, {"archived": 1})
        return {"ok": True}


@app.get("/api/accounts/{account_id}/snapshots")
def account_snapshots(account_id: int):
    with db.session() as conn:
        return db.rows(conn, "SELECT * FROM balance_snapshots WHERE account_id = ? ORDER BY date", (account_id,))


# ------------------------------------------------------------------ 取引

@app.get("/api/transactions")
def list_transactions(start: Optional[date] = None, end: Optional[date] = None, account_id: Optional[int] = None,
                      category: Optional[str] = None, limit: int = 500):
    sql, params = "SELECT * FROM transactions WHERE 1=1", []
    if start:
        sql += " AND date >= ?"; params.append(start.isoformat())
    if end:
        sql += " AND date <= ?"; params.append(end.isoformat())
    if account_id:
        sql += " AND account_id = ?"; params.append(account_id)
    if category:
        sql += " AND category = ?"; params.append(category)
    sql += " ORDER BY date DESC, id DESC LIMIT ?"
    params.append(min(limit, 5000))
    with db.session() as conn:
        return db.rows(conn, sql, params)


@app.post("/api/transactions")
def create_transaction(body: TransactionIn):
    with db.session() as conn:
        data = _dump(body)
        if data["recurring_id"] is None and data["type"] == "expense":
            data["recurring_id"] = service.match_recurring(conn, data["description"])
        return _get(conn, "transactions", _insert(conn, "transactions", data))


@app.put("/api/transactions/{tx_id}")
def update_transaction(tx_id: int, body: TransactionIn):
    with db.session() as conn:
        _update(conn, "transactions", tx_id, _dump(body))
        return _get(conn, "transactions", tx_id)


@app.delete("/api/transactions/{tx_id}")
def delete_transaction(tx_id: int):
    with db.session() as conn:
        return _delete(conn, "transactions", tx_id)


@app.get("/api/categories")
def categories():
    with db.session() as conn:
        used = [r["category"] for r in db.rows(conn, "SELECT DISTINCT category FROM transactions")]
        budgets = list((db.get_settings(conn).get("category_budgets") or {}).keys())
    base = [c for c, _ in csv_import.CATEGORY_RULES] + ["住居", "保険", "教育", "交際費", "特別な支出", "その他", "未分類"]
    return sorted(set(base) | set(used) | set(budgets), key=lambda c: (c == "未分類", c))


@app.post("/api/import/csv")
async def import_csv(file: UploadFile = File(...), account_id: Optional[int] = Form(None),
                     dry_run: bool = Form(False)):
    data = await file.read()
    items = csv_import.parse_csv(data)
    if not items:
        raise HTTPException(400, "明細を読み取れませんでした。日付・金額・内容の列がある CSV か確認してください。")
    inserted = skipped = 0
    seen: Counter = Counter()
    with db.session() as conn:
        for it in items:
            key = (it["date"], it["amount"], it["type"], it["description"])
            h = csv_import.import_hash(account_id, it, seen[key])
            seen[key] += 1
            if conn.execute("SELECT 1 FROM transactions WHERE import_hash = ?", (h,)).fetchone():
                skipped += 1
                continue
            rec_id = service.match_recurring(conn, it["description"]) if it["type"] == "expense" else None
            if not dry_run:
                _insert(conn, "transactions", {**it, "account_id": account_id, "recurring_id": rec_id,
                                               "source": "csv", "import_hash": h})
            inserted += 1
        if dry_run:
            conn.rollback()
    return {"parsed": len(items), "inserted": inserted, "skipped_duplicates": skipped,
            "preview": items[:10], "dry_run": dry_run}


# ------------------------------------------------------------------ 固定費・サブスク

@app.get("/api/recurring")
def list_recurring():
    with db.session() as conn:
        return db.rows(conn, "SELECT * FROM recurring ORDER BY active DESC, kind, amount DESC")


@app.post("/api/recurring")
def create_recurring(body: RecurringIn):
    with db.session() as conn:
        return _get(conn, "recurring", _insert(conn, "recurring", _dump(body)))


@app.put("/api/recurring/{rec_id}")
def update_recurring(rec_id: int, body: RecurringIn):
    with db.session() as conn:
        _update(conn, "recurring", rec_id, _dump(body))
        return _get(conn, "recurring", rec_id)


@app.delete("/api/recurring/{rec_id}")
def delete_recurring(rec_id: int):
    with db.session() as conn:
        return _delete(conn, "recurring", rec_id)


# ------------------------------------------------------------------ ほしいもの

@app.get("/api/wishlist")
def list_wishlist():
    with db.session() as conn:
        return db.rows(conn, "SELECT * FROM wishlist ORDER BY status = 'want' DESC, priority, created_at")


@app.post("/api/wishlist")
def create_wish(body: WishIn):
    with db.session() as conn:
        return _get(conn, "wishlist", _insert(conn, "wishlist", _dump(body)))


@app.put("/api/wishlist/{wish_id}")
def update_wish(wish_id: int, body: WishIn):
    with db.session() as conn:
        _update(conn, "wishlist", wish_id, _dump(body))
        return _get(conn, "wishlist", wish_id)


@app.delete("/api/wishlist/{wish_id}")
def delete_wish(wish_id: int):
    with db.session() as conn:
        return _delete(conn, "wishlist", wish_id)


# ------------------------------------------------------------------ 設定

@app.get("/api/settings")
def get_settings():
    with db.session() as conn:
        return db.get_settings(conn)


@app.put("/api/settings")
def put_settings(body: dict):
    with db.session() as conn:
        db.save_settings(conn, body)
        return db.get_settings(conn)


# ------------------------------------------------------------------ フロントエンド

app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")
