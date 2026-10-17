"""Runs ClearPage's browser tests in headless Chrome and prints the results.

Usage: py tests/run_tests.py [--screenshots]
No dependencies: uses Chrome's --dump-dom / --screenshot modes.
"""
import html
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.parse
from pathlib import Path

HERE = Path(__file__).resolve().parent
CHROME_PATHS = [
    os.environ.get("CHROME_PATH", ""),
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
]
CHROME = next((p for p in CHROME_PATHS if p and Path(p).exists()), None)


def chrome(args, url):
    with tempfile.TemporaryDirectory() as profile:
        cmd = [CHROME, "--headless", "--disable-gpu", "--allow-file-access-from-files", "--no-first-run",
               f"--user-data-dir={profile}", "--virtual-time-budget=5000", *args, url]
        return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", timeout=120).stdout


def run(page, query=""):
    url = (HERE / page).as_uri() + query
    dom = chrome(["--dump-dom"], url)
    title = re.search(r"<title>(.*?)</title>", dom)
    pre = re.search(r'<pre id="results">(.*?)</pre>', dom, re.S)
    print(f"\n=== {page} : {title.group(1) if title else 'no title'} ===")
    print(html.unescape(pre.group(1)) if pre else dom[:2000])
    return bool(title and title.group(1).startswith("PASS"))


def screenshot(name, settings, out_dir):
    query = "?settings=" + urllib.parse.quote(json.dumps(settings))
    path = out_dir / f"{name}.png"
    chrome([f"--screenshot={path}", "--window-size=1000,760", "--hide-scrollbars"], (HERE / "sample-page.html").as_uri() + query)
    print("screenshot:", path)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    if not CHROME:
        sys.exit("Chrome not found; set CHROME_PATH.")
    base = {"fontScale": 1, "noBg": False, "theme": "light", "noImages": False, "noAds": False, "paused": []}
    ok = run("unit.html")
    ok &= run("chat-test.html")
    ok &= run("sample-page.html", "?test=1&settings=" + urllib.parse.quote(json.dumps({**base, "fontScale": 1.5})))
    if "--screenshots" in sys.argv:
        out = Path(tempfile.gettempdir()) / "clearpage-shots"
        out.mkdir(exist_ok=True)
        screenshot("original", base, out)
        screenshot("all-on-dark", {**base, "fontScale": 1.5, "noBg": True, "theme": "dark", "noImages": True, "noAds": True}, out)
        screenshot("contrast", {**base, "fontScale": 1.25, "noBg": True, "theme": "contrast"}, out)
    sys.exit(0 if ok else 1)
