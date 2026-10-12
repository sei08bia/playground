from datetime import date, datetime
from email.message import EmailMessage

import pytest
from fastapi.testclient import TestClient

from app import advisor, db, gmail_sync, mail_parser

# 楽天カードの「ご請求金額のご案内」と同じ書式（金額・口座は架空）
RAKUTEN_BILL = """━━━━━━━━━━
ご請求金額のご案内
━━━━━━━━━━
いつも 楽天カード（Mastercard） をご利用いただきありがとうございます。
2026年9月分のご請求金額をご案内いたします。

[ご利用カード]
楽天カード（Mastercard）

[お支払い日]
2026/09/28

[お支払い方法]
口座振替

[ご請求口座]
テスト銀行

[ご請求金額]
123,456円（確定）

●ご利用明細は楽天e-NAVI「ご請求金額の照会」にてご確認ください。
"""

# 「ご請求金額が多い会員様へ」の案内。金額が書かれていないので請求額として扱わない
RAKUTEN_NOTICE = """本メールは、当月のご請求金額が過去平均より多くなった会員様へお送りしております。
■お支払い金額調整サービス
今月の楽天カードの口座振替日は2026年09月28日(月)です。
お支払い金額が多い場合は、事前にご調整のうえお支払いいただきますようお願いいたします。"""

SMBC_NOTICE = """いつも三井住友カードをご利用頂きありがとうございます。
お客様のカードご利用内容をお知らせいたします。

ご利用カード：三井住友カード（NL）

◇利用日：2026/10/05 12:34
◇利用先：セブン－イレブン　渋谷店
◇利用取引：買物
◇利用金額：１，２８０円
"""

JCB_NOTICE = """JCBカードをご利用いただき、ありがとうございます。
【ご利用日時(日本時間)】 2026/10/06 19:02
【ご利用金額】 4,980円
【ご利用先】 AMAZON.CO.JP
"""

RAKUTEN_LEGACY = """■利用日: 2026/10/07
■利用先: ライフ　中野店
■利用者: 本人
■支払方法: 1回
■利用金額: 2,345 円
"""


def test_rakuten_bill():
    p = mail_parser.parse_mail("楽天カード <info@mail.rakuten-card.co.jp>", "【楽天カード】カードご請求金額のご案内", RAKUTEN_BILL)
    assert p.kind == "bill"
    assert p.issuer == "楽天カード"
    assert p.card_label == "楽天カード(Mastercard)"
    assert (p.amount, p.payment_date, p.confirmed) == (123456, "2026-09-28", True)


def test_rakuten_notice_without_amount_is_ignored():
    p = mail_parser.parse_mail("info@mail.rakuten-card.co.jp",
                               "【お知らせ】今月のご請求金額とお支払い金額調整サービスのご案内", RAKUTEN_NOTICE)
    assert p.kind == "ignored"


@pytest.mark.parametrize("sender,subject,body,expected", [
    ("vpass@vpass.ne.jp", "ご利用のお知らせ【三井住友カード】", SMBC_NOTICE, ("2026-10-05", 1280, "セブン-イレブン 渋谷店")),
    ("mail@qa.jcb.co.jp", "JCBカード/ショッピングご利用のお知らせ", JCB_NOTICE, ("2026-10-06", 4980, "AMAZON.CO.JP")),
    ("info@mail.rakuten-card.co.jp", "カード利用のお知らせ(本人ご利用分)", RAKUTEN_LEGACY, ("2026-10-07", 2345, "ライフ 中野店")),
])
def test_usage_notifications(sender, subject, body, expected):
    p = mail_parser.parse_mail(sender, subject, body)
    assert p.kind == "transaction"
    assert (p.date, p.amount, p.description) == expected
    assert not p.refund


def test_html_body_and_cancellation():
    html = "<table><tr><td>ご利用日</td><td>2026年10月8日</td></tr><tr><td>ご利用先</td><td>ユニクロ</td></tr>" \
           "<tr><td>ご利用金額</td><td>&yen;3,990円</td></tr></table>"
    p = mail_parser.parse_mail("info@eposcard.co.jp", "【エポスカード】ご利用取消のお知らせ", html)
    assert p.kind == "transaction" and p.refund and p.amount == 3990 and p.description == "ユニクロ"


@pytest.mark.parametrize("sender,subject", [
    ("info@mail.rakuten-card.co.jp", "【楽天ポイント進呈のお知らせ】カード利用による09月獲得ポイント"),
    ("info@mail.rakuten-card.co.jp", "楽天カードご利用で、いつものお買い物をもっとお得に！"),
    ("info@mail.rakuten-card.co.jp", "【重要】カードのご利用確認に関するお願い"),
    ("yoyaku@hotpepper.jp", "【スマート支払いご利用のお知らせ】"),   # カード会社以外は取り込まない（カード明細と二重になる）
])
def test_non_usage_mails_are_ignored(sender, subject):
    assert mail_parser.parse_mail(sender, subject, "ご利用金額：1,000円 ご利用日：2026/10/01").kind == "ignored"


# ------------------------------------------------------------------ DB への取り込み

def mail(mid, sender, subject, body, received=datetime(2026, 10, 10, 9, 0)):
    return gmail_sync.Mail(mid, received, sender, subject, body)


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setenv("MONEY_DB", str(tmp_path / "t.db"))
    c = db.connect()
    db.init_db(c)
    yield c
    c.close()


def add_card(conn, name, institution="", keyword=""):
    return conn.execute("INSERT INTO accounts(name, kind, institution, closing_day, payment_day, email_keyword) "
                        "VALUES (?, 'card', ?, 31, 27, ?)", (name, institution, keyword)).lastrowid


def test_ingest_bill_and_usage(conn):
    rakuten = add_card(conn, "メインカード", "楽天カード")
    smbc = add_card(conn, "サブ", "三井住友カード")
    s = gmail_sync.ingest(conn, [
        mail("a", "info@mail.rakuten-card.co.jp", "【楽天カード】カードご請求金額のご案内", RAKUTEN_BILL),
        mail("b", "vpass@vpass.ne.jp", "ご利用のお知らせ【三井住友カード】", SMBC_NOTICE),
        mail("c", "info@mail.rakuten-card.co.jp", "楽天カード通信", "キャンペーン"),
    ])
    assert s == {"checked": 3, "imported": 1, "merged": 0, "bills": 1, "ignored": 1, "no_account": 0}
    bill = db.rows(conn, "SELECT * FROM card_bills")[0]
    assert (bill["account_id"], bill["amount"], bill["payment_date"]) == (rakuten, 123456, "2026-09-28")
    tx = db.rows(conn, "SELECT * FROM transactions")[0]
    assert (tx["account_id"], tx["amount"], tx["category"], tx["source"]) == (smbc, 1280, "コンビニ", "gmail")


def test_keyword_picks_between_two_cards_of_same_issuer(conn):
    add_card(conn, "楽天カード(JCB)", "楽天カード", keyword="JCB")
    master = add_card(conn, "楽天カード(Master)", "楽天カード", keyword="Mastercard")
    gmail_sync.ingest(conn, [mail("a", "info@mail.rakuten-card.co.jp", "カードご請求金額のご案内", RAKUTEN_BILL)])
    assert db.rows(conn, "SELECT account_id FROM card_bills")[0]["account_id"] == master


def test_bill_without_card_is_retried_after_registering(conn):
    m = mail("a", "info@mail.rakuten-card.co.jp", "カードご請求金額のご案内", RAKUTEN_BILL)
    assert gmail_sync.ingest(conn, [m])["no_account"] == 1
    assert "a" not in gmail_sync.seen_message_ids(conn)
    add_card(conn, "楽天", "楽天カード")
    assert gmail_sync.ingest(conn, [m])["bills"] == 1
    assert "a" in gmail_sync.seen_message_ids(conn)


def test_email_after_csv_is_merged_not_duplicated(conn):
    card = add_card(conn, "サブ", "三井住友カード")
    conn.execute("INSERT INTO transactions(date, amount, type, category, account_id, description, source) "
                 "VALUES ('2026-10-06', 1280, 'expense', 'コンビニ', ?, 'ｾﾌﾞﾝｲﾚﾌﾞﾝ', 'csv')", (card,))
    s = gmail_sync.ingest(conn, [mail("b", "vpass@vpass.ne.jp", "ご利用のお知らせ【三井住友カード】", SMBC_NOTICE)])
    assert s["merged"] == 1 and s["imported"] == 0
    assert conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0] == 1


class FakeIMAP:
    """Gmail IMAP の最低限の振る舞い。"""
    instances = []

    def __init__(self, host):
        self.host, self.calls, self.readonly = host, [], None
        msg = EmailMessage()
        msg["From"] = "vpass@vpass.ne.jp"
        msg["Subject"] = "ご利用のお知らせ【三井住友カード】"
        msg["Date"] = "Mon, 05 Oct 2026 12:40:00 +0900"
        msg["Message-ID"] = "<x@vpass>"
        msg.set_content(SMBC_NOTICE.replace("－", "ー"), charset="iso-2022-jp")  # 日本語メールに多い JIS
        self.raw = msg.as_bytes()
        FakeIMAP.instances.append(self)

    def login(self, user, pw):
        self.calls.append(("login", user, pw))

    def list(self):
        return "OK", [b'(\\HasNoChildren \\All) "/" "[Gmail]/&MFkweTBmMG4w4TD8MOs-"', b'(\\HasNoChildren) "/" "INBOX"']

    def select(self, box, readonly=False):
        self.calls.append(("select", box))
        self.readonly = readonly
        return "OK", [b"1"]

    def uid(self, cmd, *args):
        self.calls.append(("uid", cmd) + args)
        if cmd == "SEARCH":
            return "OK", [b"11 12"]
        if args[1] == "(X-GM-MSGID)":
            return "OK", [b"%s (X-GM-MSGID 99%s UID %s)" % (args[0], args[0], args[0])]
        return "OK", [(b"1 (BODY[] {100}", self.raw), b")"]

    def logout(self):
        pass


def test_fetch_mails_over_imap():
    FakeIMAP.instances.clear()
    mails = gmail_sync.fetch_mails("me@gmail.com", "pw", date(2026, 9, 1), seen={"gm:9912"}, imap_factory=FakeIMAP)
    imap = FakeIMAP.instances[0]
    assert imap.readonly is True                                     # 読み取り専用で開く
    assert ("select", '"[Gmail]/&MFkweTBmMG4w4TD8MOs-"') in imap.calls  # 日本語名の「すべてのメール」
    search = next(c for c in imap.calls if c[1] == "SEARCH")
    assert "from:vpass.ne.jp" in search[3] and "after:2026/09/01" in search[3]
    assert not any("(BODY.PEEK[])" in c and c[2] == b"12" for c in imap.calls)   # 取り込み済みは本文を取らない
    assert [m.message_id for m in mails] == ["gm:9911"]
    p = mail_parser.parse_mail(mails[0].sender, mails[0].subject, mails[0].body)
    assert (p.kind, p.amount) == ("transaction", 1280)


# ------------------------------------------------------------------ API

@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("MONEY_DB", str(tmp_path / "api.db"))
    monkeypatch.setenv("MONEY_DISABLE_SCHEDULER", "1")
    monkeypatch.setattr(advisor, "has_credentials", lambda: False)
    from app.main import app
    return TestClient(app)


def test_sync_endpoint_and_dashboard(client, monkeypatch):
    monkeypatch.setenv("GMAIL_ADDRESS", "me@gmail.com")
    monkeypatch.setenv("GMAIL_APP_PASSWORD", "abcd efgh ijkl mnop")
    card = client.post("/api/accounts", json={"name": "楽天", "kind": "card", "institution": "楽天カード",
                                              "closing_day": 31, "payment_day": 27}).json()

    def fake_fetch(addr, pw, since, seen):
        assert (addr, pw) == ("me@gmail.com", "abcdefghijklmnop")
        return [mail("bill-1", "info@mail.rakuten-card.co.jp", "カードご請求金額のご案内",
                     RAKUTEN_BILL.replace("2026/09/28", "2026/10/27"))]

    monkeypatch.setattr(gmail_sync, "fetch_mails", fake_fetch)
    r = client.post("/api/gmail/sync").json()
    assert r["ok"] and r["summary"]["bills"] == 1
    d = client.get("/api/dashboard", params={"today": "2026-10-12"}).json()
    c = next(c for c in d["cards"] if c["id"] == card["id"])
    assert c["next_payment"]["amount"] == 123456 and c["next_payment"]["source"] == "email"
    assert d["gmail"]["configured"] and d["gmail"]["last_sync"]["ok"]
    assert client.get("/api/gmail/log").json()[0]["status"] == "bill"


def test_sync_without_credentials(client, monkeypatch):
    monkeypatch.delenv("GMAIL_ADDRESS", raising=False)
    assert client.post("/api/gmail/sync").status_code == 400


def test_csv_replaces_gmail_transaction(client, monkeypatch):
    card = client.post("/api/accounts", json={"name": "サブ", "kind": "card", "institution": "三井住友カード"}).json()
    msg = EmailMessage()
    msg["From"], msg["Subject"], msg["Message-ID"] = "vpass@vpass.ne.jp", "ご利用のお知らせ【三井住友カード】", "<m1@x>"
    msg.set_content(SMBC_NOTICE)
    r = client.post("/api/gmail/import-eml", files=[("files", ("a.eml", msg.as_bytes(), "message/rfc822"))]).json()
    assert r["imported"] == 1
    csv = "利用日,利用店名,利用金額\n2026/10/06,ｾﾌﾞﾝｲﾚﾌﾞﾝ ｼﾌﾞﾔ,1280\n".encode()
    r = client.post("/api/import/csv", files={"file": ("c.csv", csv, "text/csv")}, data={"account_id": str(card["id"])}).json()
    assert r["merged_with_gmail"] == 1 and r["inserted"] == 0
    txs = client.get("/api/transactions").json()
    assert len(txs) == 1 and txs[0]["source"] == "csv" and txs[0]["description"] == "ｾﾌﾞﾝｲﾚﾌﾞﾝ ｼﾌﾞﾔ"
    # 同じ CSV をもう一度取り込んでも増えない
    r = client.post("/api/import/csv", files={"file": ("c.csv", csv, "text/csv")}, data={"account_id": str(card["id"])}).json()
    assert r["inserted"] == 0 and r["skipped_duplicates"] == 1


def test_parse_test_endpoint(client):
    r = client.post("/api/gmail/parse-test", json={"sender": "mail@qa.jcb.co.jp", "subject": "ショッピングご利用のお知らせ",
                                                    "body": JCB_NOTICE}).json()
    assert r["kind"] == "transaction" and r["amount"] == 4980 and r["account"] is None
