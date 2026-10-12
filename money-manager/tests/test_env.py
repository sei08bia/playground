import os

from app.env import load_env


def test_load_env(tmp_path, monkeypatch):
    f = tmp_path / ".env"
    f.write_text('# comment\nGMAIL_ADDRESS=me@gmail.com\nexport GMAIL_APP_PASSWORD="abcd efgh"\n'
                 "ANTHROPIC_API_KEY=\nALREADY=from-file\n", encoding="utf-8")
    for k in ("GMAIL_ADDRESS", "GMAIL_APP_PASSWORD", "ANTHROPIC_API_KEY"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("ALREADY", "from-env")
    load_env(f)
    assert os.environ["GMAIL_ADDRESS"] == "me@gmail.com"
    assert os.environ["GMAIL_APP_PASSWORD"] == "abcd efgh"
    assert "ANTHROPIC_API_KEY" not in os.environ      # 空欄は設定しない
    assert os.environ["ALREADY"] == "from-env"         # 既存の環境変数を優先
    for k in ("GMAIL_ADDRESS", "GMAIL_APP_PASSWORD"):
        monkeypatch.delenv(k)


def test_missing_file_is_fine(tmp_path):
    load_env(tmp_path / "none")
