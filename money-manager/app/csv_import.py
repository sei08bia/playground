"""カード・銀行の利用明細 CSV の取り込み。

各社のフォーマットは列名がバラバラなので、ヘッダー行を探して
「日付」「金額」「内容」に当たる列を推定する。マネーフォワード ME のエクスポートや
主要カード会社の明細 CSV（Shift_JIS / UTF-8）を想定。
"""
from __future__ import annotations

import csv
import hashlib
import io
import re
from datetime import date

DATE_COLS = ["利用日", "ご利用日", "利用年月日", "ご利用年月日", "取引日", "日付", "年月日", "date"]
AMOUNT_COLS = ["利用金額", "ご利用金額", "金額（円）", "金額(円)", "金額", "支払金額", "支払総額", "請求金額", "amount"]
DESC_COLS = ["利用店名", "ご利用店名", "利用店名・商品名", "ご利用先", "利用先", "内容", "摘要", "取引内容", "店名", "description"]
WITHDRAW_COLS = ["出金", "出金額", "お引出し", "支払い金額", "引出額"]
DEPOSIT_COLS = ["入金", "入金額", "お預入れ", "預入額"]
CATEGORY_COLS = ["大項目", "カテゴリ", "category"]

# 内容のキーワード → カテゴリ（上から順に評価）
CATEGORY_RULES: list[tuple[str, list[str]]] = [
    ("食費", ["スーパー", "イオン", "西友", "ライフ", "マルエツ", "業務スーパー", "OK", "成城石井", "まいばすけっと", "生協", "コープ"]),
    ("コンビニ", ["セブン", "ローソン", "ファミリーマート", "ファミマ", "ミニストップ", "デイリーヤマザキ"]),
    ("外食", ["マクドナルド", "スターバックス", "スタバ", "すき家", "吉野家", "松屋", "ガスト", "サイゼリヤ", "UBER EATS", "UBEREATS", "出前館", "レストラン", "カフェ", "居酒屋", "ドトール", "タリーズ"]),
    ("日用品", ["マツモトキヨシ", "ウエルシア", "ツルハ", "スギ薬局", "ダイソー", "無印", "ニトリ", "ドラッグ", "カインズ"]),
    ("交通", ["JR", "モバイルSUICA", "SUICA", "PASMO", "メトロ", "タクシー", "GO", "鉄道", "バス", "ETC", "高速"]),
    ("ネットショッピング", ["AMAZON", "アマゾン", "楽天市場", "ヤフーショッピング", "ZOZO", "メルカリ"]),
    ("サブスク", ["NETFLIX", "SPOTIFY", "APPLE.COM", "ITUNES", "GOOGLE", "YOUTUBE", "AMAZON PRIME", "プライム", "DISNEY", "U-NEXT", "ADOBE", "CHATGPT", "OPENAI", "ANTHROPIC", "CLAUDE"]),
    ("通信", ["DOCOMO", "ドコモ", "AU", "ソフトバンク", "SOFTBANK", "楽天モバイル", "AHAMO", "POVO", "LINEMO", "UQ", "NURO", "光"]),
    ("水道・光熱", ["電力", "でんき", "電気", "ガス", "水道", "ENEOS", "TEPCO", "東京電力", "関西電力"]),
    ("医療", ["病院", "クリニック", "医院", "歯科", "薬局"]),
    ("趣味・娯楽", ["映画", "TOHO", "書店", "紀伊國屋", "STEAM", "NINTENDO", "任天堂", "PLAYSTATION", "ゲーム"]),
    ("衣服・美容", ["ユニクロ", "UNIQLO", "GU", "ZARA", "H&M", "美容", "ヘア", "サロン"]),
]


def guess_category(description: str) -> str:
    text = (description or "").upper()
    for category, words in CATEGORY_RULES:
        for w in words:
            if w.upper() in text:
                return category
    return "未分類"


def decode_bytes(data: bytes) -> str:
    for enc in ("utf-8-sig", "cp932", "euc-jp"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def _norm(s: str) -> str:
    return re.sub(r"\s+", "", (s or "").strip().strip('"')).lower()


def _find(header: list[str], candidates: list[str]) -> int | None:
    normed = [_norm(h) for h in header]
    for cand in candidates:
        c = _norm(cand)
        for i, h in enumerate(normed):
            if h == c:
                return i
    for cand in candidates:
        c = _norm(cand)
        for i, h in enumerate(normed):
            if c in h:
                return i
    return None


def parse_amount(value: str) -> int | None:
    s = (value or "").strip().replace(",", "").replace("円", "").replace("¥", "").replace("￥", "")
    s = s.replace("−", "-").replace("ー", "-").replace("△", "-").replace("▲", "-")
    if not s or s == "-":
        return None
    try:
        return round(float(s))
    except ValueError:
        return None


def parse_date(value: str) -> date | None:
    s = (value or "").strip()
    m = re.match(r"^(\d{4})[/\-.年](\d{1,2})[/\-.月](\d{1,2})", s)
    if m:
        y, mo, d = map(int, m.groups())
    else:
        m = re.match(r"^(\d{2})[/\-.](\d{1,2})[/\-.](\d{1,2})", s)       # 24/10/05
        if m:
            y, mo, d = map(int, m.groups())
            y += 2000
        else:
            m = re.match(r"^(\d{4})(\d{2})(\d{2})$", s)                   # 20241005
            if not m:
                return None
            y, mo, d = map(int, m.groups())
    try:
        return date(y, mo, d)
    except ValueError:
        return None


def parse_csv(data: bytes) -> list[dict]:
    """CSV を {date, amount, type, description, category} のリストにする。"""
    text = decode_bytes(data)
    reader = list(csv.reader(io.StringIO(text)))
    header_idx = None
    for i, row in enumerate(reader[:30]):
        if _find(row, DATE_COLS) is not None and (
            _find(row, AMOUNT_COLS) is not None or _find(row, WITHDRAW_COLS) is not None
        ):
            header_idx = i
            break

    out: list[dict] = []
    if header_idx is None:
        # ヘッダー無し: 「日付, 内容, 金額」の並びの行を拾う（一部カード会社の形式）
        for row in reader:
            if len(row) < 3:
                continue
            d = parse_date(row[0])
            amt = next((parse_amount(c) for c in row[2:] if parse_amount(c) is not None), None)
            if d and amt is not None:
                out.append(_item(d, amt, row[1].strip(), None))
        return out

    header = reader[header_idx]
    i_date = _find(header, DATE_COLS)
    i_amt = _find(header, AMOUNT_COLS)
    i_desc = _find(header, DESC_COLS)
    i_out = _find(header, WITHDRAW_COLS)
    i_in = _find(header, DEPOSIT_COLS)
    i_cat = _find(header, CATEGORY_COLS)

    for row in reader[header_idx + 1:]:
        if not row or i_date is None or i_date >= len(row):
            continue
        d = parse_date(row[i_date])
        if not d:
            continue
        desc = row[i_desc].strip() if i_desc is not None and i_desc < len(row) else ""
        cat = row[i_cat].strip() if i_cat is not None and i_cat < len(row) else None
        if i_out is not None or i_in is not None:
            w = parse_amount(row[i_out]) if i_out is not None and i_out < len(row) else None
            dep = parse_amount(row[i_in]) if i_in is not None and i_in < len(row) else None
            if w:
                out.append(_item(d, w, desc, cat))
            elif dep:
                out.append(_item(d, -dep, desc, cat))
            continue
        amt = parse_amount(row[i_amt]) if i_amt is not None and i_amt < len(row) else None
        if amt is None or amt == 0:
            continue
        # マネーフォワード形式は支出がマイナス。カード明細は支出がプラス。
        if _norm(header[i_amt]) in ("金額（円）", "金額(円)"):
            amt = -amt
        out.append(_item(d, amt, desc, cat))
    return out


def _item(d: date, signed_amount: int, desc: str, category: str | None) -> dict:
    """signed_amount: 正 = 支出、負 = 入金・返金。"""
    if signed_amount >= 0:
        ttype, amount = "expense", signed_amount
    else:
        ttype, amount = "income", -signed_amount
    cat = category if category and category != "未分類" else guess_category(desc)
    if ttype == "income" and cat in ("未分類",):
        cat = "収入・返金"
    return {"date": d.isoformat(), "amount": amount, "type": ttype, "description": desc, "category": cat}


def import_hash(account_id: int | None, item: dict, occurrence: int) -> str:
    """同じ CSV を二重に取り込まないためのキー。同日・同額・同内容が複数ある場合は occurrence で区別。"""
    key = f"{account_id}|{item['date']}|{item['amount']}|{item['type']}|{item['description']}|{occurrence}"
    return hashlib.sha256(key.encode()).hexdigest()[:32]
