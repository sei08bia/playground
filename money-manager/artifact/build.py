"""claude.ai 版を 1 枚の HTML にまとめる:  python artifact/build.py [出力先]"""
import sys
from pathlib import Path

here = Path(__file__).resolve().parent
css = (here.parent / "static" / "style.css").read_text(encoding="utf-8")
extra = """
.topbar { top: env(safe-area-inset-top, 0px); }
.inline-legend { grid-template-columns: repeat(auto-fit, minmax(120px, max-content)); gap: 6px 18px; margin-top: 8px; }
.inline-legend .item { grid-template-columns: 12px auto; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; } }
"""
page = "\n".join([
    "<title>お金の見える化</title>",
    "<style>\n" + css + extra + "</style>",
    (here / "markup.html").read_text(encoding="utf-8"),
    "<script>\n" + (here / "app.js").read_text(encoding="utf-8") + "</script>",
])
out = Path(sys.argv[1]) if len(sys.argv) > 1 else here / "dist" / "okane.html"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(page, encoding="utf-8")
print(out, len(page.encode()), "bytes")
