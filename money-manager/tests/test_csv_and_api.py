from datetime import date

import pytest
from fastapi.testclient import TestClient

from app import advisor, csv_import


def test_parse_card_csv_shift_jis():
    raw = ("利用日,利用店名・商品名,利用者,支払方法,利用金額,支払手数料,支払総額\n"
           "2026/10/01,セブン-イレブン 渋谷店,本人,1回払い,450,0,450\n"
           "2026/10/03,NETFLIX.COM,本人,1回払い,\"1,590\",0,\"1,590\"\n"
           "2026/10/04,返品 AMAZON,本人,1回払い,-2000,0,-2000\n").encode("cp932")
    items = csv_import.parse_csv(raw)
    assert [i["amount"] for i in items] == [450, 1590, 2000]
    assert items[0]["category"] == "コンビニ"
    assert items[1]["category"] == "サブスク"
    assert items[2]["type"] == "income"


def test_parse_moneyforward_csv():
    raw = ("\"計算対象\",\"日付\",\"内容\",\"金額（円）\",\"保有金融機関\",\"大項目\",\"中項目\",\"メモ\",\"振替\",\"ID\"\n"
           "\"1\",\"2026/10/05\",\"ライフ\",\"-3200\",\"楽天カード\",\"食費\",\"食料品\",\"\",\"0\",\"a\"\n"
           "\"1\",\"2026/10/25\",\"給与\",\"300000\",\"三井住友銀行\",\"収入\",\"給与\",\"\",\"0\",\"b\"\n").encode("utf-8")
    items = csv_import.parse_csv(raw)
    assert items[0] == {"date": "2026-10-05", "amount": 3200, "type": "expense", "description": "ライフ", "category": "食費"}
    assert items[1]["type"] == "income" and items[1]["amount"] == 300000


def test_parse_bank_withdraw_deposit_columns():
    raw = ("日付,摘要,出金,入金,残高\n20261001,カ）ラクテンカード,52000,,300000\n20261025,給与,,280000,580000\n").encode()
    items = csv_import.parse_csv(raw)
    assert items[0]["type"] == "expense" and items[0]["amount"] == 52000
    assert items[1]["type"] == "income" and items[1]["amount"] == 280000


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("MONEY_DB", str(tmp_path / "test.db"))
    monkeypatch.setattr(advisor, "has_credentials", lambda: False)
    from app.main import app
    return TestClient(app)


def test_end_to_end_flow(client):
    client.put("/api/settings", json={"monthly_income": 250000, "category_budgets": {"食費": 30000}})
    bank = client.post("/api/accounts", json={"name": "銀行", "kind": "bank", "balance": 200000}).json()
    card = client.post("/api/accounts", json={"name": "カード", "kind": "card", "closing_day": 31, "payment_day": 27,
                                              "payment_account_id": bank["id"]}).json()
    client.post("/api/accounts", json={"name": "iDeCo", "kind": "ideco", "balance": 500000, "contributed": 450000})
    sub = client.post("/api/recurring", json={"name": "Netflix", "kind": "subscription", "amount": 1590,
                                              "billing_day": 3, "account_id": card["id"],
                                              "match_keyword": "NETFLIX"}).json()

    csv = "利用日,利用店名,利用金額\n2026/10/01,ライフ,3000\n2026/10/03,NETFLIX.COM,1590\n2026/10/03,ライフ,3000\n"
    files = {"file": ("card.csv", csv.encode(), "text/csv")}
    r = client.post("/api/import/csv", files=files, data={"account_id": str(card["id"])}).json()
    assert r["inserted"] == 3
    r = client.post("/api/import/csv", files=files, data={"account_id": str(card["id"])}).json()
    assert r["inserted"] == 0 and r["skipped_duplicates"] == 3

    txs = client.get("/api/transactions").json()
    netflix = next(t for t in txs if "NETFLIX" in t["description"])
    assert netflix["recurring_id"] == sub["id"]

    d = client.get("/api/dashboard", params={"today": "2026-10-10"}).json()
    assert d["budget"]["spent"] == 6000                  # Netflix は固定費扱い
    assert d["budget"]["variable_budget"] == 250000 - 1590
    assert d["net_worth"]["pension"] == 500000
    assert d["cards"][0]["unpaid_total"] == 7590

    adv = client.post("/api/advice", json={"question": "今月あといくら使える？"}).json()
    assert adv["mode"] == "rules" and "今月あと" in adv["answer"]
    assert len(client.get("/api/advice/history").json()) == 1


def test_build_context_has_no_raw_transactions(client):
    client.put("/api/settings", json={"monthly_income": 200000})
    client.post("/api/transactions", json={"date": date.today().isoformat(), "amount": 1234,
                                           "description": "秘密のお店"})
    from app import db, service
    with db.session() as conn:
        ctx = advisor.build_context(service.dashboard(conn))
    assert "秘密のお店" not in str(ctx)
    assert ctx["budget"]["spent"] == 1234


def test_ask_claude_request_shape(monkeypatch):
    import anthropic
    from types import SimpleNamespace

    captured = {}

    class FakeMessages:
        def create(self, **kw):
            captured.update(kw)
            return SimpleNamespace(stop_reason="end_turn",
                                   content=[SimpleNamespace(type="thinking", thinking=""),
                                            SimpleNamespace(type="text", text="## 今月の状況: 順調")])

    class FakeClient:
        def __init__(self, *a, **kw):
            self.beta = SimpleNamespace(messages=FakeMessages())

    monkeypatch.setattr(anthropic, "Anthropic", FakeClient)
    answer = advisor.ask_claude({"budget": {"remaining": 1000}}, "あといくら？")
    assert answer == "## 今月の状況: 順調"
    assert captured["model"] == advisor.MODEL
    assert captured["fallbacks"] == "default"
    assert "server-side-fallback-2026-07-01" in captured["betas"]
    assert "あといくら？" in captured["messages"][0]["content"]
    assert "thinking" not in captured   # Opus 5.5 は adaptive が既定
