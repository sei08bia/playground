"""カード会社から届くメールの解析。

2 種類を扱う:
- 利用通知（1 回のカード利用ごとに届く「ご利用のお知らせ」）→ 明細 1 件
- 請求額の案内（毎月の「ご請求金額のご案内」）→ そのカードの確定請求額と引き落とし日

カード会社ごとに書式は違うが、多くは「利用日」「利用先」「利用金額」のようなラベル付きの行なので、
ラベルの揺れを吸収する汎用パーサーで読む。楽天カードの請求額メールは実物の書式に合わせてある。
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from datetime import date, datetime
from email.utils import parseaddr
from html import unescape

# 送信元ドメイン → カード会社名（口座との照合と、取り込み対象の判定に使う）
ISSUERS: dict[str, str] = {
    "rakuten-card.co.jp": "楽天カード",
    "vpass.ne.jp": "三井住友カード",
    "smbc-card.com": "三井住友カード",
    "jcb.co.jp": "JCB",
    "paypay-card.co.jp": "PayPayカード",
    "eposcard.co.jp": "エポスカード",
    "aeon.co.jp": "イオンカード",
    "saisoncard.co.jp": "セゾンカード",
    "aexp.com": "アメリカン・エキスプレス",
    "americanexpress.jp": "アメリカン・エキスプレス",
    "cr.mufg.jp": "三菱UFJカード",
    "dcard.docomo.ne.jp": "dカード",
    "kddi-fs.com": "au PAY カード",
    "lifecard.co.jp": "ライフカード",
    "orico.co.jp": "オリコカード",
    "viewcard.co.jp": "ビューカード",
}

DATE_LABELS = r"(?:ご?利用日時?|ご?利用年月日|お取引日時?|取引日時?|決済日時?|承認日時?)"
MERCHANT_LABELS = r"(?:ご?利用先|ご?利用店名?|ご?利用場所|ご?利用加盟店|加盟店名?|店舗名|ご?利用内容|お支払先|支払先)"
AMOUNT_LABELS = r"(?:ご?利用金額|お?取引金額|決済金額|お支払い?金額|ご?請求金額|承認金額)"
BILL_AMOUNT_LABELS = r"(?:合計)?(?:ご?請求(?:予定)?金額|お?支払い?(?:予定)?金額|お引落し?金額|引落金額|ご請求額|お支払額)"
BILL_DATE_LABELS = r"(?:お?支払い?日|お引落し?日|口座振替日|引落日|お支払予定日)"

SEP = r"[\s:：】\]）)]*"   # ラベルと値の間の記号・空白（改行も含む）

NOTIFY_SUBJECT = re.compile(r"(利用|ご利用|決済|承認|速報)")
BILL_SUBJECT = re.compile(r"(ご?請求(予定)?(金額|額)|お支払い?(予定)?金額|お引落し?金額).*(案内|お知らせ|確定)")
CANCEL_WORDS = re.compile(r"(取消|取り消し|キャンセル|返品|売上取消)")
# 利用通知のように見えても取り込まないメール
IGNORE_SUBJECT = re.compile(r"(キャンペーン|ポイント|キャッシュバック|お得|おトク|特典|プレゼント|エントリー|ご案内します|不正|ご利用確認|ご注意|会員ステージ|メンテナンス|サービス終了)")


@dataclass
class ParsedMail:
    kind: str                       # "transaction" / "bill" / "ignored"
    issuer: str | None = None
    card_label: str = ""            # メール中のカード名（例: 楽天カード（Mastercard））
    date: str | None = None
    amount: int | None = None
    description: str = ""
    refund: bool = False
    payment_date: str | None = None
    confirmed: bool = True
    reason: str = ""
    extra: dict = field(default_factory=dict)


def normalize(text: str) -> str:
    """全角数字・記号を半角に寄せ、HTML なら素のテキストにする。"""
    if "<" in text and re.search(r"</(p|div|td|br|table)", text, re.I):
        text = re.sub(r"(?is)<(script|style).*?</\1>", "", text)
        text = re.sub(r"(?i)<br\s*/?>|</(p|div|tr|li|h\d)>", "\n", text)
        text = re.sub(r"(?i)</t[dh]>", "\t", text)
        text = re.sub(r"<[^>]+>", "", text)
        text = unescape(text)
    text = unicodedata.normalize("NFKC", text)
    return text.replace("\r\n", "\n").replace("\r", "\n")


def issuer_for(sender: str) -> str | None:
    addr = parseaddr(sender)[1].lower() or sender.lower()
    domain = addr.split("@")[-1]
    for d, name in ISSUERS.items():
        if domain == d or domain.endswith("." + d):
            return name
    return None


def _amount(s: str) -> int | None:
    m = re.match(r"\s*[-−]?\s*[¥\\]?\s*([0-9][0-9,]*)\s*円", s)
    if not m:
        m = re.match(r"\s*[¥\\]\s*([0-9][0-9,]*)", s)
    if not m:
        return None
    return int(m.group(1).replace(",", ""))


def _date(s: str) -> date | None:
    m = re.search(r"(\d{4})\s*[/\-.年]\s*(\d{1,2})\s*[/\-.月]\s*(\d{1,2})", s)
    if not m:
        return None
    try:
        return date(*map(int, m.groups()))
    except ValueError:
        return None


# ラベルは行頭（「◇」「■」「【」などの飾りの後）にあるものだけを見る。
# 本文中の「ご利用内容をお知らせします」のような文に反応しないため。
LINE_HEAD = r"(?m)^[ \t◇◆■□●○・*＊【\[]*"


def _labels_at_line_head(text: str, labels: str):
    return re.finditer(LINE_HEAD + labels + SEP, text)


def _find_amount(text: str, labels: str) -> int | None:
    for m in _labels_at_line_head(text, labels):
        amt = _amount(text[m.end():m.end() + 30])
        if amt is not None:
            return amt
    return None


def _find_date(text: str, labels: str) -> date | None:
    for m in _labels_at_line_head(text, labels):
        d = _date(text[m.end():m.end() + 30])
        if d:
            return d
    return None


def _find_line(text: str, labels: str) -> str:
    for m in _labels_at_line_head(text, labels):
        val = re.match(r"[^\n\t]+", text[m.end():])
        if val and val.group(0).strip(" 　:："):
            return val.group(0).strip(" 　:：")[:80]
    return ""


def _card_label(text: str) -> str:
    m = re.search(r"(?:\[?ご利用カード\]?|カード名称?)[\s:：】\]]*([^\n]+)", text)
    return m.group(1).strip() if m else ""


def parse_mail(sender: str, subject: str, body: str, received: datetime | None = None) -> ParsedMail:
    issuer = issuer_for(sender)
    subject = unicodedata.normalize("NFKC", subject or "")
    text = normalize(body or "")
    if not issuer:
        return ParsedMail("ignored", reason="カード会社のメールではありません")

    # --- 請求額の案内 ---
    if BILL_SUBJECT.search(subject) or re.search(r"ご請求金額のご案内|お支払い?(予定)?金額のご案内", text[:300]):
        amount = _find_amount(text, BILL_AMOUNT_LABELS)
        pay = _find_date(text, BILL_DATE_LABELS)
        if amount is not None and pay:
            confirmed = not re.search(r"(予定|暫定|速報)", text[:2000]) or "確定" in text[:2000]
            return ParsedMail("bill", issuer=issuer, card_label=_card_label(text), amount=amount,
                              payment_date=pay.isoformat(), confirmed=confirmed)
        return ParsedMail("ignored", issuer=issuer, reason="請求額のメールですが金額か支払い日が読めません")

    if IGNORE_SUBJECT.search(subject) or not NOTIFY_SUBJECT.search(subject):
        return ParsedMail("ignored", issuer=issuer, reason="利用通知ではありません")

    # --- 利用通知 ---
    amount = _find_amount(text, AMOUNT_LABELS)
    if amount is None:
        return ParsedMail("ignored", issuer=issuer, reason="利用金額が見つかりません")
    d = _find_date(text, DATE_LABELS) or (received.date() if received else None)
    if not d:
        return ParsedMail("ignored", issuer=issuer, reason="利用日が見つかりません")
    merchant = _find_line(text, MERCHANT_LABELS)
    refund = bool(CANCEL_WORDS.search(subject))
    return ParsedMail("transaction", issuer=issuer, card_label=_card_label(text), date=d.isoformat(),
                      amount=amount, description=merchant or f"{issuer}のご利用", refund=refund)


def search_domains() -> list[str]:
    return sorted(set(ISSUERS))
