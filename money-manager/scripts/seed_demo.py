"""デモデータを投入する。  python -m scripts.seed_demo [--reset]

MONEY_DB で別ファイルを指定すれば本番データを汚さずに試せる:
    MONEY_DB=data/demo.db python -m scripts.seed_demo --reset
"""
from __future__ import annotations

import random
import sys
from datetime import date, timedelta

from app import db, service


def seed(conn, today: date | None = None) -> None:
    today = today or date.today()
    rnd = random.Random(42)
    db.save_settings(conn, {
        "monthly_income": 350000, "cycle_start_day": 25, "savings_goal": 20000, "emergency_fund_months": 6,
        "category_budgets": {"食費": 40000, "外食": 15000, "コンビニ": 5000, "日用品": 8000,
                             "交通": 8000, "趣味・娯楽": 15000, "ネットショッピング": 10000},
    })

    def acc(**kw):
        cur = conn.execute(f"INSERT INTO accounts ({', '.join(kw)}) VALUES ({', '.join('?' * len(kw))})",
                           list(kw.values()))
        return cur.lastrowid

    bank = acc(name="給与口座", kind="bank", institution="三井住友銀行", balance=412000)
    acc(name="貯金用", kind="bank", institution="楽天銀行", balance=850000)
    acc(name="財布", kind="cash", balance=18000)
    acc(name="モバイルSuica", kind="emoney", balance=4200)
    card1 = acc(name="メインカード", kind="card", institution="楽天カード", closing_day=31, payment_day=27,
                payment_account_id=bank, card_limit=500000)
    card2 = acc(name="サブカード", kind="card", institution="三井住友カード", closing_day=15, payment_day=10,
                payment_account_id=bank, card_limit=300000)
    acc(name="新NISA（つみたて投資枠）", kind="nisa", institution="SBI証券", balance=1380000, contributed=1200000)
    acc(name="特定口座", kind="securities", institution="SBI証券", balance=520000, contributed=450000)
    acc(name="iDeCo", kind="ideco", institution="SBI証券", balance=960000, contributed=828000,
                note="原則60歳まで引き出し不可")
    acc(name="企業型DC", kind="dc", institution="会社", balance=1250000, contributed=1100000)

    # 過去 12 か月の残高推移
    for i in range(12, -1, -1):
        y, m = today.year, today.month - i
        while m <= 0:
            y, m = y - 1, m + 12
        d = date(y, m, 1)
        growth = 1 - i * 0.03
        for a_id, base, contrib in conn.execute(
                "SELECT id, balance, contributed FROM accounts WHERE kind NOT IN ('card', 'cash', 'emoney')").fetchall():
            noise = rnd.uniform(0.97, 1.03) if contrib else 1
            service.record_snapshot(conn, a_id, round(base * growth * noise),
                                    round(contrib * growth) if contrib else None, d)

    for a in conn.execute("SELECT id, balance, contributed FROM accounts WHERE kind != 'card'").fetchall():
        service.record_snapshot(conn, a[0], a[1], a[2], today)

    def rec(**kw):
        cur = conn.execute(f"INSERT INTO recurring ({', '.join(kw)}) VALUES ({', '.join('?' * len(kw))})",
                           list(kw.values()))
        return cur.lastrowid

    recs = {
        "家賃": rec(name="家賃", kind="fixed", amount=85000, billing_day=27, account_id=bank, category="住居"),
        "電気": rec(name="電気（東京電力）", kind="utility", amount=7800, billing_day=20, account_id=card1,
                  category="水道・光熱", match_keyword="東京電力", variable=1),
        "ガス": rec(name="ガス", kind="utility", amount=4200, billing_day=22, account_id=card1, category="水道・光熱",
                  match_keyword="東京ガス", variable=1),
        "水道": rec(name="水道", kind="utility", amount=2500, billing_day=10, account_id=bank, category="水道・光熱", variable=1),
        "スマホ": rec(name="スマホ（ahamo）", kind="utility", amount=2970, billing_day=5, account_id=card1,
                   category="通信", match_keyword="AHAMO,ドコモ"),
        "光回線": rec(name="光回線", kind="utility", amount=5280, billing_day=5, account_id=card1, category="通信",
                   match_keyword="NURO"),
        "Netflix": rec(name="Netflix", kind="subscription", amount=1590, billing_day=3, account_id=card1,
                       category="サブスク", match_keyword="NETFLIX"),
        "Spotify": rec(name="Spotify", kind="subscription", amount=1080, billing_day=12, account_id=card1,
                       category="サブスク", match_keyword="SPOTIFY"),
        "Prime": rec(name="Amazonプライム（年額）", kind="subscription", amount=5900, cycle="yearly", billing_day=8,
                     billing_month=3, account_id=card1, category="サブスク", match_keyword="AMAZON PRIME"),
        "iCloud": rec(name="iCloud+", kind="subscription", amount=400, billing_day=18, account_id=card2,
                      category="サブスク", match_keyword="APPLE.COM"),
        "ジム": rec(name="ジム", kind="subscription", amount=7700, billing_day=1, account_id=card2,
                   category="趣味・娯楽", match_keyword="ANYTIME", note="最近月2回くらいしか行っていない"),
        "保険": rec(name="医療保険", kind="fixed", amount=3200, billing_day=27, account_id=bank, category="保険"),
    }
    rec(name="NISA積立", kind="investment", amount=50000, billing_day=1, account_id=card1, category="投資",
        match_keyword="SBI証券")
    rec(name="iDeCo掛金", kind="investment", amount=23000, billing_day=26, account_id=bank, category="投資")

    # 変動費の明細（過去 ~120 日）
    shops = [
        ("食費", ["ライフ", "まいばすけっと", "成城石井", "業務スーパー"], (800, 4500), 0.55),
        ("コンビニ", ["セブン-イレブン", "ファミリーマート", "ローソン"], (200, 900), 0.45),
        ("外食", ["スターバックス", "サイゼリヤ", "UBER EATS", "松屋", "居酒屋 和民"], (500, 4800), 0.3),
        ("日用品", ["マツモトキヨシ", "ダイソー", "ニトリ"], (300, 3500), 0.1),
        ("交通", ["モバイルSUICA チャージ", "GO タクシー"], (1000, 3000), 0.08),
        ("ネットショッピング", ["AMAZON.CO.JP", "楽天市場"], (1200, 9800), 0.12),
        ("趣味・娯楽", ["TOHOシネマズ", "紀伊國屋書店", "STEAM"], (1200, 6000), 0.07),
    ]
    rows = []
    for back in range(120, -1, -1):
        d = today - timedelta(days=back)
        heavy = 1.35 if back < 18 else 1.0   # 直近は少し使いすぎ気味にしてアドバイスが出るように
        for cat, names, (lo, hi), p in shops:
            if rnd.random() < p * heavy:
                rows.append((d, rnd.randrange(lo, hi, 10), cat, rnd.choice(names), rnd.choice([card1, card1, card2])))
    for d, amount, cat, desc, card in rows:
        conn.execute("INSERT INTO transactions(date, amount, type, category, account_id, description, source) "
                     "VALUES (?, ?, 'expense', ?, ?, ?, 'demo')", (d.isoformat(), amount, cat, card, desc))
    # 固定費の明細（カード払いのもの）
    for back_m in range(4, -1, -1):
        y, m = today.year, today.month - back_m
        while m <= 0:
            y, m = y - 1, m + 12
        for key, desc, amount, day, card in (("Netflix", "NETFLIX.COM", 1590, 3, card1),
                                             ("Spotify", "SPOTIFY", 1080, 12, card1),
                                             ("スマホ", "AHAMO利用料", 2970, 5, card1),
                                             ("電気", "東京電力エナジーパートナー", rnd.randrange(6500, 9800, 10), 20, card1),
                                             ("ジム", "ANYTIME FITNESS", 7700, 1, card2)):
            d = date(y, m, day)
            if d <= today:
                conn.execute("INSERT INTO transactions(date, amount, type, category, account_id, description, "
                             "recurring_id, source) VALUES (?, ?, 'expense', (SELECT category FROM recurring WHERE id = ?), "
                             "?, ?, ?, 'demo')", (d.isoformat(), amount, recs[key], card, desc, recs[key]))

    for name, price, prio, saved, note in (("ワイヤレスイヤホン", 39800, 2, 10000, ""),
                                          ("ロードバイク", 180000, 3, 30000, "来年の春までに"),
                                          ("ふるさと納税（年内）", 60000, 1, 0, "12月までに")):
        conn.execute("INSERT INTO wishlist(name, price, priority, saved, note) VALUES (?, ?, ?, ?, ?)",
                     (name, price, prio, saved, note))


def main() -> None:
    conn = db.connect()
    if "--reset" in sys.argv:
        for t in ("transactions", "balance_snapshots", "recurring", "wishlist", "accounts", "advice_log", "settings"):
            conn.execute(f"DROP TABLE IF EXISTS {t}")
    db.init_db(conn)
    if conn.execute("SELECT COUNT(*) FROM accounts").fetchone()[0]:
        print("既にデータがあります。上書きする場合は --reset を付けてください。")
        return
    seed(conn)
    conn.commit()
    print(f"デモデータを投入しました: {db.db_path()}")


if __name__ == "__main__":
    main()
