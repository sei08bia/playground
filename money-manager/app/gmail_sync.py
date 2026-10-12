"""Gmail からカード会社のメールを読み、明細と確定請求額を取り込む。

接続は IMAP（読み取り専用で開き、既読にもしない）。認証は Google アカウントの「アプリ パスワード」:
    GMAIL_ADDRESS=you@gmail.com
    GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx
（OAuth のテスト用アプリは更新トークンが 7 日で切れて定期取り込みが止まるため、IMAP にしている）
"""
from __future__ import annotations

import email
import email.policy
import hashlib
import imaplib
import logging
import os
import re
import sqlite3
import threading
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from email.utils import parsedate_to_datetime
from typing import Callable, Iterable

from . import csv_import, db, mail_parser, service

log = logging.getLogger(__name__)
IMAP_HOST = "imap.gmail.com"
MAX_PER_SYNC = 300
_lock = threading.Lock()


@dataclass
class Mail:
    message_id: str
    received: datetime | None
    sender: str
    subject: str
    body: str


def credentials() -> tuple[str, str] | None:
    addr = os.environ.get("GMAIL_ADDRESS", "").strip()
    pw = os.environ.get("GMAIL_APP_PASSWORD", "").replace(" ", "").strip()
    return (addr, pw) if addr and pw else None


# ------------------------------------------------------------------ メールの読み込み

def mail_from_bytes(raw: bytes, message_id: str | None = None) -> Mail:
    msg = email.message_from_bytes(raw, policy=email.policy.default)
    part = msg.get_body(preferencelist=("plain", "html"))
    try:
        body = part.get_content() if part is not None else ""
    except (LookupError, UnicodeDecodeError):
        payload = part.get_payload(decode=True) or b""
        body = csv_import.decode_bytes(payload)
    try:
        received = parsedate_to_datetime(msg["date"]) if msg["date"] else None
    except (TypeError, ValueError):
        received = None
    mid = message_id or (msg["message-id"] or "").strip() or "sha:" + hashlib.sha256(raw).hexdigest()[:32]
    return Mail(mid, received, str(msg["from"] or ""), str(msg["subject"] or ""), body)


def _all_mail_box(conn: imaplib.IMAP4) -> str:
    """「すべてのメール」フォルダ（表示言語で名前が変わるので \\All 属性で探す）。"""
    typ, boxes = conn.list()
    for line in boxes or []:
        text = line.decode(errors="replace") if isinstance(line, bytes) else str(line)
        if "\\All" in text:
            m = re.search(r'"([^"]+)"\s*$', text) or re.search(r"(\S+)\s*$", text)
            if m:
                return m.group(1)
    return "INBOX"


def fetch_mails(address: str, password: str, since: date, seen: set[str],
                imap_factory: Callable[[str], imaplib.IMAP4] | None = None) -> list[Mail]:
    conn = (imap_factory or (lambda host: imaplib.IMAP4_SSL(host, timeout=30)))(IMAP_HOST)
    try:
        conn.login(address, password)
        conn.select(f'"{_all_mail_box(conn)}"', readonly=True)
        query = "{" + " ".join(f"from:{d}" for d in mail_parser.search_domains()) + "}" + \
                f" after:{since.strftime('%Y/%m/%d')}"
        typ, data = conn.uid("SEARCH", "X-GM-RAW", f'"{query}"')
        uids = (data[0] or b"").split() if data else []
        out: list[Mail] = []
        for uid in uids[-MAX_PER_SYNC:]:
            typ, meta = conn.uid("FETCH", uid, "(X-GM-MSGID)")
            m = re.search(rb"X-GM-MSGID (\d+)", meta[0] if meta and isinstance(meta[0], bytes) else b"")
            mid = f"gm:{m.group(1).decode()}" if m else None
            if mid and mid in seen:
                continue
            typ, msg = conn.uid("FETCH", uid, "(BODY.PEEK[])")
            raw = next((p[1] for p in msg or [] if isinstance(p, tuple)), None)
            if raw:
                out.append(mail_from_bytes(raw, mid))
        return out
    finally:
        try:
            conn.logout()
        except Exception:  # noqa: BLE001 - 切断時のエラーは無視してよい
            pass


# ------------------------------------------------------------------ DB への反映

def match_card(conn: sqlite3.Connection, parsed: mail_parser.ParsedMail) -> int | None:
    cards = db.rows(conn, "SELECT id, name, institution, email_keyword FROM accounts "
                          "WHERE kind = 'card' AND archived = 0 ORDER BY id")
    label = parsed.card_label or ""
    # 1. 口座に設定した照合キーワードがメールのカード名に含まれる
    for c in cards:
        kws = [k.strip() for k in (c.get("email_keyword") or "").split(",") if k.strip()]
        if any(k in label or k == parsed.issuer for k in kws):
            return c["id"]
    # 2. カード会社名が口座名・金融機関名に含まれる（キーワード未設定のカードだけ）
    issuer = parsed.issuer or ""
    short = issuer.replace("カード", "")
    candidates = [c for c in cards if not c.get("email_keyword") and short and
                  (short in c["name"] or short in (c["institution"] or ""))]
    return candidates[0]["id"] if candidates else None


def _record(conn, mail: Mail, status: str, detail: str = "", tx_id: int | None = None) -> None:
    conn.execute(
        "INSERT INTO email_imports(message_id, received_at, sender, subject, status, detail, transaction_id) "
        "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(message_id) DO UPDATE SET status = excluded.status, "
        "detail = excluded.detail, transaction_id = excluded.transaction_id",
        (mail.message_id, mail.received.isoformat() if mail.received else None, mail.sender[:200],
         mail.subject[:300], status, detail, tx_id))


def find_duplicate(conn, account_id: int | None, d: str, amount: int, ttype: str,
                   sources: Iterable[str]) -> dict | None:
    """同じカード・同じ金額・日付が ±3 日の明細（利用日と計上日のずれを吸収）。"""
    marks = ",".join("?" for _ in sources)
    rows = db.rows(conn, f"""
        SELECT t.* FROM transactions t
        WHERE t.amount = ? AND t.type = ? AND t.account_id IS ? AND t.source IN ({marks})
          AND abs(julianday(t.date) - julianday(?)) <= 3
          AND NOT EXISTS (SELECT 1 FROM email_imports e WHERE e.transaction_id = t.id)
        ORDER BY abs(julianday(t.date) - julianday(?)) LIMIT 1""",
        (amount, ttype, account_id, *sources, d, d))
    return rows[0] if rows else None


def ingest(conn: sqlite3.Connection, mails: Iterable[Mail]) -> dict:
    summary = {"checked": 0, "imported": 0, "merged": 0, "bills": 0, "ignored": 0, "no_account": 0}
    for mail in mails:
        summary["checked"] += 1
        p = mail_parser.parse_mail(mail.sender, mail.subject, mail.body, mail.received)
        if p.kind == "ignored":
            summary["ignored"] += 1
            _record(conn, mail, "ignored", p.reason)
            continue
        account_id = match_card(conn, p)

        if p.kind == "bill":
            if account_id is None:
                summary["no_account"] += 1
                _record(conn, mail, "no_account",
                        f"{p.issuer} {p.amount:,}円 {p.payment_date}払い（このカードを口座に登録すると反映されます）")
                continue
            conn.execute(
                "INSERT INTO card_bills(account_id, payment_date, amount, confirmed, source) VALUES (?, ?, ?, ?, 'gmail') "
                "ON CONFLICT(account_id, payment_date) DO UPDATE SET amount = excluded.amount, confirmed = excluded.confirmed",
                (account_id, p.payment_date, p.amount, int(p.confirmed)))
            summary["bills"] += 1
            _record(conn, mail, "bill", f"{p.amount:,}円 {p.payment_date}払い{'（確定）' if p.confirmed else '（予定）'}")
            continue

        ttype = "income" if p.refund else "expense"
        dup = find_duplicate(conn, account_id, p.date, p.amount, ttype, ("csv", "manual"))
        if dup:
            summary["merged"] += 1
            _record(conn, mail, "merged", f"既存の明細と同じ: {dup['date']} {dup['description']}", dup["id"])
            continue
        category = "収入・返金" if p.refund else csv_import.guess_category(p.description)
        rec_id = service.match_recurring(conn, p.description) if ttype == "expense" else None
        cur = conn.execute(
            "INSERT INTO transactions(date, amount, type, category, account_id, description, recurring_id, source, import_hash) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, 'gmail', ?)",
            (p.date, p.amount, ttype, category, account_id, p.description, rec_id,
             "gmail:" + hashlib.sha256(mail.message_id.encode()).hexdigest()[:32]))
        summary["imported"] += 1
        _record(conn, mail, "imported", "" if account_id else "カード未登録のため口座なしで記録", cur.lastrowid)
    return summary


def seen_message_ids(conn) -> set[str]:
    # 口座が見つからなかったメールはカード登録後に再処理したいので「既読」に含めない
    return {r["message_id"] for r in db.rows(conn, "SELECT message_id FROM email_imports WHERE status != 'no_account'")}


def sync(fetcher: Callable[..., list[Mail]] | None = None) -> dict:
    """Gmail から取り込む。結果は settings.gmail_last_sync にも残す。"""
    fetcher = fetcher or fetch_mails
    creds = credentials()
    if not creds:
        raise RuntimeError("GMAIL_ADDRESS と GMAIL_APP_PASSWORD が設定されていません")
    if not _lock.acquire(blocking=False):
        raise RuntimeError("取り込み中です。しばらくお待ちください")
    try:
        with db.session() as conn:
            settings = db.get_settings(conn)
            since = date.today() - timedelta(days=int(settings.get("gmail_lookback_days") or 45))
            seen = seen_message_ids(conn)
        started = datetime.now().isoformat(timespec="seconds")
        try:
            mails = fetcher(creds[0], creds[1], since, seen)
            with db.session() as conn:
                mails = [m for m in mails if m.message_id not in seen]
                summary = ingest(conn, mails)
                result = {"at": started, "ok": True, "summary": summary}
                db.save_settings(conn, {"gmail_last_sync": result})
            return result
        except (imaplib.IMAP4.error, OSError) as e:
            msg = str(e)
            if "AUTHENTICATIONFAILED" in msg or "Invalid credentials" in msg:
                msg = "Gmail にログインできません。アプリ パスワードを確認してください"
            elif isinstance(e, OSError):
                msg = f"Gmail（{IMAP_HOST}）に接続できませんでした: {msg}"
            result = {"at": started, "ok": False, "error": msg}
            with db.session() as conn:
                db.save_settings(conn, {"gmail_last_sync": result})
            raise RuntimeError(msg) from e
    finally:
        _lock.release()


def import_raw(raws: Iterable[bytes]) -> dict:
    """.eml ファイルから取り込む（IMAP を使わない場合や動作確認用）。"""
    mails = [mail_from_bytes(r) for r in raws]
    with db.session() as conn:
        seen = seen_message_ids(conn)
        return ingest(conn, [m for m in mails if m.message_id not in seen])


# ------------------------------------------------------------------ 定期取り込み

def _due(settings: dict) -> bool:
    if not settings.get("gmail_auto"):
        return False
    last = (settings.get("gmail_last_sync") or {}).get("at")
    if not last:
        return True
    interval = max(5, int(settings.get("gmail_interval_min") or 30))
    return datetime.now() - datetime.fromisoformat(last) >= timedelta(minutes=interval)


def scheduler_loop(stop: threading.Event, tick_seconds: int = 60) -> None:
    while not stop.is_set():
        try:
            if credentials():
                with db.session() as conn:
                    due = _due(db.get_settings(conn))
                if due:
                    sync()
        except Exception as e:  # noqa: BLE001 - 定期処理は落とさず次回に回す
            log.warning("Gmail 取り込みに失敗: %s", e)
        stop.wait(tick_seconds)


def start_scheduler() -> threading.Event:
    stop = threading.Event()
    threading.Thread(target=scheduler_loop, args=(stop,), daemon=True, name="gmail-sync").start()
    return stop

