"""AI アドバイス。

ANTHROPIC_API_KEY（または `ant auth login` のプロファイル）があれば Claude に家計の集計値を渡して
アドバイスをもらう。認証情報が無い・API が失敗したときはルールベースの簡易アドバイスを返す。

Claude に送るのは集計値（予算・残高・固定費の一覧など）で、個々の取引明細の生データは送らない。
"""
from __future__ import annotations

import json
import os
from typing import Any

MODEL = os.environ.get("MONEY_ADVISOR_MODEL", "claude-opus-5-5")

SYSTEM_PROMPT = """あなたはユーザー専属の家計アドバイザーです。ユーザーの家計データ（JSON）を読み、日本語で具体的に助言します。

方針:
- 最初に「今月の状況」を一言で（使いすぎ／順調／余裕あり など）伝え、「今日あといくら」「今月あといくら」使えるかを金額で示す。
- 数字は JSON の値から計算し、推測した数字には「見込み」と書く。データにない事実を作らない。
- 指摘は優先度の高い順に最大 5 つ。それぞれ「何を」「いくら」「どうする」が分かるように。
- サブスク・インフラ（通信・電気など）は、見直し余地がありそうなものを具体名で挙げる。
- カードの引き落とし予定と口座残高を照らし合わせ、残高不足のおそれがあれば最優先で警告する。
- NISA・iDeCo・企業型DC は「すぐには使えないお金」として生活費とは分けて扱う。iDeCo/DC は原則 60 歳まで引き出せない点に注意。
- ほしいものリストは、今買ってよいか・いつなら買えるかを判断する。
- 個別銘柄の売買推奨はしない。制度（NISA の非課税枠、iDeCo の所得控除など）の一般的な説明は可。
- 見出しと箇条書きで簡潔に。全体で 600 字程度を目安に。質問があればそれに最優先で答える。"""


def build_context(dash: dict[str, Any]) -> dict[str, Any]:
    """Claude に渡す家計サマリー（個々の明細は送らない）。"""
    b = dash["budget"]
    w = dash["net_worth"]
    return {
        "today": dash["today"],
        "period": b["period"],
        "budget": {k: b[k] for k in (
            "income", "fixed_monthly", "investment_monthly", "savings_goal", "variable_budget", "spent",
            "today_spent", "remaining", "daily_allowance", "today_remaining", "expected_by_now", "pace_ratio",
            "projected_spent", "projected_surplus", "status", "avg_variable_spent")},
        "past_periods_variable_spent": b["history"],
        "categories": b["categories"],
        "recurring": [
            {"name": r["name"], "kind": r["kind"], "amount": r["amount"], "cycle": r["cycle"],
             "variable": bool(r["variable"]), "note": r.get("note") or ""}
            for r in dash["recurring"] if r["active"]
        ],
        "recurring_monthly_by_kind": b["recurring"]["monthly_by_kind"],
        "upcoming_bills_next_31_days": b["recurring"]["upcoming"],
        "cards": [{k: c[k] for k in ("name", "current_cycle", "next_payment", "unpaid_total", "limit", "limit_usage")}
                  for c in dash["cards"]],
        "payment_checks": dash["payment_checks"],
        "net_worth": {k: w[k] for k in ("liquid", "invest", "pension", "other", "liability", "card_unpaid",
                                        "total_assets", "net_worth", "spendable")},
        "investments": w["investments"],
        "emergency_fund": dash["emergency_fund"],
        "wishlist": [{k: it.get(k) for k in ("name", "price", "priority", "saved", "need", "target_date",
                                             "months_to_save", "fits_this_month", "keeps_emergency_fund", "verdict")}
                     for it in dash["wishlist"]],
    }


def ask_claude(context: dict[str, Any], question: str | None) -> str:
    import anthropic

    client = anthropic.Anthropic()
    user = "## 家計データ\n```json\n" + json.dumps(context, ensure_ascii=False, indent=1) + "\n```\n\n"
    user += f"## 質問\n{question}" if question else "今の家計の状況を診断して、今月どう過ごせばいいかアドバイスしてください。"

    response = client.beta.messages.create(
        model=MODEL,
        max_tokens=16000,
        system=SYSTEM_PROMPT,
        output_config={"effort": "medium"},
        # 安全分類器で断られた場合はサーバー側で推奨モデルに自動フォールバック
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        messages=[{"role": "user", "content": user}],
    )
    if response.stop_reason == "refusal":
        raise RuntimeError("AI が回答を控えました。質問の言い方を変えてみてください。")
    text = "".join(block.text for block in response.content if block.type == "text").strip()
    if not text:
        raise RuntimeError(f"AI の応答が空でした (stop_reason={response.stop_reason})")
    return text


def has_credentials() -> bool:
    if os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"):
        return True
    return os.path.isdir(os.path.expanduser("~/.config/anthropic"))


def advise(dash: dict[str, Any], question: str | None = None) -> dict[str, str]:
    context = build_context(dash)
    if has_credentials():
        import anthropic
        try:
            return {"mode": "ai", "answer": ask_claude(context, question)}
        except anthropic.AuthenticationError:
            note = "API キーが無効です。"
        except anthropic.RateLimitError:
            note = "API のレート制限に達しました。少し待ってから再度お試しください。"
        except anthropic.APIConnectionError:
            note = "AI に接続できませんでした。"
        except anthropic.APIStatusError as e:
            note = f"AI の呼び出しに失敗しました（{e.status_code}）。"
        except RuntimeError as e:
            note = str(e)
        return {"mode": "rules", "answer": f"> {note} 代わりに簡易診断を表示します。\n\n" + rule_based(context)}
    return {"mode": "rules", "answer": "> ANTHROPIC_API_KEY が未設定のため、ルールベースの簡易診断です。\n\n" + rule_based(context)}


def yen(n: float | int | None) -> str:
    if n is None:
        return "-"
    return f"{round(n):,}円"


def rule_based(ctx: dict[str, Any]) -> str:
    b = ctx["budget"]
    lines: list[str] = []
    status_text = {
        "ok": "順調です", "warning": "ペースがやや早めです", "over": "今月の予算を超えています",
        "deficit": "固定費と積立だけで収入を上回っています",
    }[b["status"]]
    lines.append(f"## 今月の状況: {status_text}")
    if b["income"] <= 0:
        lines.append("- 設定画面で手取り月収を入力すると、使える金額を計算できます。")
    else:
        lines.append(f"- 今月あと **{yen(b['remaining'])}**（残り {ctx['period']['days_left']} 日）")
        lines.append(f"- 今日あと **{yen(b['today_remaining'])}**（1日あたり {yen(b['daily_allowance'])}）")
        if b["pace_ratio"]:
            lines.append(f"- 予定ペースの {b['pace_ratio']*100:.0f}% で使っています。このままだと月末の変動費は {yen(b['projected_spent'])}（見込み）。")

    tips: list[str] = []
    for p in ctx["payment_checks"]:
        if p["shortfall"] > 0:
            tips.append(f"⚠️ **{p['account']}** の残高 {yen(p['balance'])} に対し、近く {yen(p['due_amount'])} の引き落とし予定。{yen(p['shortfall'])} 不足します。")
    for c in ctx["categories"]:
        if c["budget"] and c["ratio"] and c["ratio"] > 1:
            tips.append(f"**{c['category']}** が予算 {yen(c['budget'])} を {yen(c['spent'] - c['budget'])} 超過しています。")
        elif c["budget"] and c["pace_ratio"] and c["pace_ratio"] > 1.2:
            tips.append(f"**{c['category']}** のペースが早め（予定の {c['pace_ratio']*100:.0f}%）。")
    subs = [r for r in ctx["recurring"] if r["kind"] == "subscription"]
    if subs:
        total = sum(r["amount"] if r["cycle"] == "monthly" else r["amount"] / 12 for r in subs)
        tips.append(f"サブスクは {len(subs)} 件・月 {yen(total)}（年 {yen(total*12)}）。最近使っていないものがないか確認しましょう。")
    for c in ctx["cards"]:
        if c["limit_usage"] and c["limit_usage"] > 0.7:
            tips.append(f"**{c['name']}** の利用枠を {c['limit_usage']*100:.0f}% 使っています。")
    ef = ctx["emergency_fund"]
    if ef["months_covered"] is not None and ef["months_covered"] < ef["target_months"]:
        tips.append(f"すぐ使えるお金は生活費の {ef['months_covered']:.1f} か月分。目標 {ef['target_months']} か月分（{yen(ef['target_amount'])}）まで、投資より預金を優先しても良いかもしれません。")
    for it in ctx["wishlist"][:3]:
        if it["verdict"] == "buy_ok":
            tips.append(f"ほしいもの「{it['name']}」({yen(it['price'])}) は今月の予算内で買えます。")
        elif it["months_to_save"]:
            tips.append(f"ほしいもの「{it['name']}」はあと {yen(it['need'])}。今のペースなら約 {it['months_to_save']} か月で貯まります。")
    if tips:
        lines.append("\n## 気になる点")
        lines += [f"- {t}" for t in tips[:6]]
    lines.append("\n_AI を有効にすると、サブスクの見直し候補や質問への回答など、より具体的なアドバイスが得られます。_")
    return "\n".join(lines)
