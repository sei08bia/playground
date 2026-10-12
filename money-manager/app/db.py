"""SQLite 永続化。データはローカルの data/money.db にだけ保存される。"""
from __future__ import annotations

import json
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

DEFAULT_DB_PATH = Path(__file__).resolve().parent.parent / "data" / "money.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    -- bank / cash / emoney / card / securities / nisa / ideco / dc / loan / other
    kind TEXT NOT NULL,
    institution TEXT DEFAULT '',
    balance INTEGER NOT NULL DEFAULT 0,      -- 現在残高（評価額）。ローンは残債を正の数で
    contributed INTEGER,                     -- 投資系: 拠出・積立元本の累計
    closing_day INTEGER,                     -- カード: 締め日 (1-31, 31=月末)
    payment_day INTEGER,                     -- カード: 翌月の引き落とし日
    payment_account_id INTEGER,              -- カード: 引き落とし口座
    card_limit INTEGER,                      -- カード: 利用枠
    note TEXT DEFAULT '',
    archived INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (date('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS balance_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    balance INTEGER NOT NULL,
    contributed INTEGER,
    UNIQUE(account_id, date)
);

CREATE TABLE IF NOT EXISTS recurring (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    -- subscription（サブスク） / utility（光熱費・通信などインフラ） / fixed（家賃・保険など） / investment（NISA積立・iDeCo掛金）
    kind TEXT NOT NULL,
    amount INTEGER NOT NULL,
    cycle TEXT NOT NULL DEFAULT 'monthly',   -- monthly / yearly / weekly
    billing_day INTEGER,
    billing_month INTEGER,                   -- yearly の請求月
    account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
    category TEXT DEFAULT '',
    match_keyword TEXT DEFAULT '',           -- 明細の内容にこの文字列が含まれたら固定費として扱う
    variable INTEGER NOT NULL DEFAULT 0,     -- 1 = 金額が毎月変動（電気・ガスなど）
    active INTEGER NOT NULL DEFAULT 1,
    note TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    amount INTEGER NOT NULL,                 -- 常に正の数。向きは type で表す
    type TEXT NOT NULL DEFAULT 'expense',    -- expense / income / transfer
    category TEXT NOT NULL DEFAULT '未分類',
    account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
    description TEXT DEFAULT '',
    memo TEXT DEFAULT '',
    recurring_id INTEGER REFERENCES recurring(id) ON DELETE SET NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    import_hash TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);

CREATE TABLE IF NOT EXISTS wishlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    price INTEGER NOT NULL,
    priority INTEGER NOT NULL DEFAULT 2,     -- 1=高 2=中 3=低
    saved INTEGER NOT NULL DEFAULT 0,        -- この目的で取り分けた額
    target_date TEXT,
    url TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'want',     -- want / bought / dropped
    note TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (date('now', 'localtime'))
);

-- メールで届いた確定請求額（カードの次回引き落とし額の推定より優先する）
CREATE TABLE IF NOT EXISTS card_bills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    payment_date TEXT NOT NULL,
    amount INTEGER NOT NULL,
    confirmed INTEGER NOT NULL DEFAULT 1,
    source TEXT NOT NULL DEFAULT 'gmail',
    UNIQUE(account_id, payment_date)
);

-- 取り込んだメールの記録（二重取り込み防止と、読めなかったメールの確認用）
CREATE TABLE IF NOT EXISTS email_imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL UNIQUE,
    received_at TEXT,
    sender TEXT,
    subject TEXT,
    status TEXT NOT NULL,          -- imported / merged / bill / ignored / no_account
    detail TEXT DEFAULT '',
    transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS advice_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    question TEXT,
    answer TEXT NOT NULL,
    mode TEXT NOT NULL
);
"""

DEFAULT_SETTINGS: dict[str, Any] = {
    "monthly_income": 0,          # 手取り月収
    "cycle_start_day": 1,         # 家計の締め（給料日起点なら 25 など）
    "savings_goal": 0,            # 毎月の先取り貯金（積立投資は固定費の investment に登録）
    "category_budgets": {},       # {"食費": 40000, ...}
    "emergency_fund_months": 6,   # 生活防衛資金の目標（生活費の何か月分）
    "gmail_auto": True,           # Gmail の認証情報があれば定期的に取り込む
    "gmail_interval_min": 30,
    "gmail_lookback_days": 45,
    "gmail_last_sync": None,      # {"at": ..., "ok": bool, "summary": {...}, "error": ...}
}

# 既存 DB に後から足した列
MIGRATIONS = [
    ("accounts", "email_keyword", "TEXT DEFAULT ''"),   # メールのカード名と照合する文字列
]


def db_path() -> Path:
    return Path(os.environ.get("MONEY_DB", DEFAULT_DB_PATH))


def connect(path: Path | None = None) -> sqlite3.Connection:
    path = path or db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    for table, column, decl in MIGRATIONS:
        cols = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
        if column not in cols:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")
    for key, value in DEFAULT_SETTINGS.items():
        conn.execute(
            "INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)",
            (key, json.dumps(value, ensure_ascii=False)),
        )
    conn.commit()


@contextmanager
def session() -> Iterator[sqlite3.Connection]:
    conn = connect()
    try:
        init_db(conn)
        yield conn
        conn.commit()
    finally:
        conn.close()


def rows(conn: sqlite3.Connection, sql: str, params: tuple | list = ()) -> list[dict]:
    return [dict(r) for r in conn.execute(sql, params).fetchall()]


def get_settings(conn: sqlite3.Connection) -> dict[str, Any]:
    out = dict(DEFAULT_SETTINGS)
    for r in conn.execute("SELECT key, value FROM settings"):
        out[r["key"]] = json.loads(r["value"])
    return out


def save_settings(conn: sqlite3.Connection, values: dict[str, Any]) -> None:
    for key, value in values.items():
        if key not in DEFAULT_SETTINGS:
            continue
        conn.execute(
            "INSERT INTO settings(key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, json.dumps(value, ensure_ascii=False)),
        )
