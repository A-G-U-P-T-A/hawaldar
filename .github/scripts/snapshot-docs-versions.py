#!/usr/bin/env python3
"""Copy current docs to /vX.Y.Z-beta.N/ and snapshot older tagged docs."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DOCS = ROOT / "docs"
PKG = ROOT / "hawaldar-app" / "package.json"


def git(*args: str) -> str:
    return subprocess.check_output(
        ["git", *args], cwd=ROOT, text=True, encoding="utf-8"
    ).strip()


def inject_script(html_path: Path) -> None:
    text = html_path.read_text(encoding="utf-8")
    if "site.js" in text:
        return
    snippet = '  <script src="site.js" defer></script>\n'
    if "</head>" in text:
        text = text.replace("</head>", snippet + "</head>", 1)
    elif "</body>" in text:
        text = text.replace("</body>", snippet + "</body>", 1)
    else:
        text += snippet
    html_path.write_text(text, encoding="utf-8")


def copy_shared(dest: Path) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    for name in ("site.js", "site.css", "versions.json"):
        src = DOCS / name
        if src.is_file():
            shutil.copy2(src, dest / name)


def top_level_docs() -> list[Path]:
    files: list[Path] = []
    for path in DOCS.iterdir():
        if path.is_file() and path.name not in {".DS_Store"}:
            files.append(path)
    return files


def main() -> int:
    pkg = json.loads(PKG.read_text(encoding="utf-8"))
    latest = "v" + str(pkg["version"])
    try:
        tags = [line for line in git("tag", "-l", "v*", "--sort=-v:refname").splitlines() if line]
    except subprocess.CalledProcessError:
        tags = []
    ordered: list[str] = []
    for tag in [latest, *tags]:
        if tag not in ordered:
            ordered.append(tag)
    payload = {
        "latest": latest,
        "versions": [
            {
                "id": tag,
                "label": f"{tag} (latest)" if tag == latest else tag,
                "path": "" if tag == latest else f"{tag}/",
            }
            for tag in ordered
        ],
    }
    (DOCS / "versions.json").write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    latest_dir = DOCS / latest
    latest_dir.mkdir(parents=True, exist_ok=True)
    for src in top_level_docs():
        shutil.copy2(src, latest_dir / src.name)

    for tag in tags:
        if tag == latest:
            continue
        dest = DOCS / tag
        dest.mkdir(parents=True, exist_ok=True)
        try:
            listing = git("ls-tree", "--name-only", tag, "docs/")
        except subprocess.CalledProcessError:
            continue
        for path in listing.splitlines():
            name = Path(path).name
            if not (name.endswith(".html") or name.endswith(".css") or name == ".nojekyll"):
                continue
            try:
                content = git("show", f"{tag}:{path}")
            except subprocess.CalledProcessError:
                continue
            (dest / name).write_text(content.replace("\r\n", "\n"), encoding="utf-8")
        copy_shared(dest)
        for html in dest.glob("*.html"):
            inject_script(html)

    copy_shared(latest_dir)
    for html in latest_dir.glob("*.html"):
        inject_script(html)
    print(f"Pages versions: latest={latest} tags={', '.join(ordered) or '(none)'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
