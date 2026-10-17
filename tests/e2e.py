"""End-to-end test: loads the real extension into a throwaway headless Chrome
through the DevTools protocol (tiny stdlib-only client below), serves the sample
page over HTTP, and checks that the content script, storage wiring, ad-blocking
network rules and side panel work together.

Usage: py tests/e2e.py          (needs ports 9333 and 8765 free)
"""
import base64
import http.server
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

PORT = 9333
HTTP_PORT = 8765
HERE = Path(__file__).resolve().parent
EXT = str(HERE.parent / "extension")
CHROME = os.environ.get("CHROME_PATH", r"C:\Program Files\Google\Chrome\Application\chrome.exe")


class Cdp:
    """Minimal WebSocket + CDP client: enough for call/evaluate/attach."""

    def __init__(self, ws_url):
        host, path = ws_url.split("//", 1)[1].split("/", 1)
        h, p = host.split(":")
        self.sock = socket.create_connection((h, int(p)))
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.send(
            f"GET /{path} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n".encode()
        )
        resp = b""
        while b"\r\n\r\n" not in resp:
            resp += self.sock.recv(1)
        self.next_id = 0
        self.events = []

    def _recv_exact(self, n):
        buf = b""
        while len(buf) < n:
            buf += self.sock.recv(n - len(buf))
        return buf

    def _recv(self):
        data = b""
        while True:
            b1, b2 = self._recv_exact(2)
            n = b2 & 0x7F
            if n == 126:
                n = int.from_bytes(self._recv_exact(2), "big")
            elif n == 127:
                n = int.from_bytes(self._recv_exact(8), "big")
            data += self._recv_exact(n)
            if b1 & 0x80:
                return json.loads(data)

    def call(self, method, session=None, **params):
        self.next_id += 1
        msg = {"id": self.next_id, "method": method, "params": params}
        if session:
            msg["sessionId"] = session
        payload = json.dumps(msg).encode()
        mask = os.urandom(4)
        n = len(payload)
        if n < 126:
            header = bytes([0x81, 0x80 | n])
        elif n < 65536:
            header = bytes([0x81, 0x80 | 126]) + n.to_bytes(2, "big")
        else:
            header = bytes([0x81, 0x80 | 127]) + n.to_bytes(8, "big")
        self.sock.send(header + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))
        while True:
            reply = self._recv()
            if reply.get("id") == self.next_id:
                return reply
            self.events.append(reply)

    def evaluate(self, session, expression):
        res = self.call("Runtime.evaluate", session=session, expression=expression, awaitPromise=True, returnByValue=True)
        r = res.get("result", {})
        if "exceptionDetails" in r:
            raise RuntimeError(json.dumps(r["exceptionDetails"])[:500])
        return r.get("result", {}).get("value")

    def attach(self, target_id):
        return self.call("Target.attachToTarget", targetId=target_id, flatten=True)["result"]["sessionId"]


class Handler(http.server.SimpleHTTPRequestHandler):
    """Serves tests/, plus /real.html: the sample page without its chrome.* mock and
    test scripts, so the extension's real content script is the only copy running."""

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(HERE), **kw)

    def log_message(self, *a):
        pass

    def do_GET(self):
        if not self.path.startswith("/real.html"):
            return super().do_GET()
        page = (HERE / "sample-page.html").read_text(encoding="utf-8")
        for tag in ('<script src="chrome-mock.js"></script>', '<link rel="stylesheet" href="../extension/content.css" />',
                    '<script src="../extension/content.js"></script>', '<script src="content-tests.js"></script>'):
            page = page.replace(tag, "")
        body = page.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", HTTP_PORT), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    proc = subprocess.Popen([CHROME, "--headless=new", "--disable-gpu", f"--user-data-dir={tempfile.mkdtemp()}",
                             f"--remote-debugging-port={PORT}", "--enable-unsafe-extension-debugging", "about:blank"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    failed = 0

    def check(name, ok, detail=""):
        nonlocal failed
        print(("ok   " if ok else "FAIL ") + name + ("" if ok else f" -> {detail}"))
        failed += not ok

    try:
        for _ in range(50):
            try:
                ver = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/version"))
                break
            except OSError:
                time.sleep(0.2)
        cdp = Cdp(ver["webSocketDebuggerUrl"])
        ext_id = cdp.call("Extensions.loadUnpacked", path=EXT)["result"]["id"]
        time.sleep(1.5)
        targets = cdp.call("Target.getTargets")["result"]["targetInfos"]
        sw = next((t for t in targets if t["type"] == "service_worker" and ext_id in t["url"]), None)
        check("extension loads and service worker starts", sw is not None, targets)
        sws = cdp.attach(sw["targetId"])

        settings = {"fontScale": 1.5, "noBg": True, "theme": "dark", "noImages": True, "noAds": True,
                    "paused": [], "ttsRate": 1, "ttsVoice": ""}
        cdp.evaluate(sws, f"chrome.storage.local.set({{'cp:settings': {json.dumps(settings)}}})")
        time.sleep(0.5)
        rulesets = cdp.evaluate(sws, "chrome.declarativeNetRequest.getEnabledRulesets()")
        check("ad-blocking ruleset enabled from settings", rulesets == ["ads"], rulesets)

        page_id = cdp.call("Target.createTarget", url=f"http://127.0.0.1:{HTTP_PORT}/real.html")["result"]["targetId"]
        time.sleep(2)
        ps = cdp.attach(page_id)

        def style(sel, prop):
            return cdp.evaluate(ps, f"getComputedStyle(document.querySelector({json.dumps(sel)})).{prop}")

        check("real content script scales text", style("#story p:not(.byline)", "fontSize") == "21px", style("#story p:not(.byline)", "fontSize"))
        check("real content script applies dark theme", style("body", "backgroundColor") == "rgb(18, 18, 18)", style("body", "backgroundColor"))
        check("real content script hides images", style("img.hero", "display") == "none")
        alt = cdp.evaluate(ps, "document.querySelector('cp-alt')?.textContent")
        check("alt text label inserted", alt == "Image: Volunteers carrying boxes of books into a brick building", alt)
        check("cosmetic ad hiding", style(".ad-slot", "display") == "none")

        cdp.call("Network.enable", session=ps)
        cdp.events.clear()
        cdp.evaluate(ps, "fetch('https://securepubads.g.doubleclick.net/tag/js/gpt.js', {mode: 'no-cors'}).then(() => 'loaded', () => 'failed')")
        cdp.evaluate(ps, "new Promise(r => setTimeout(r, 300))")
        errors = [e["params"].get("errorText") for e in cdp.events if e.get("method") == "Network.loadingFailed"]
        check("ad network request blocked by declarativeNetRequest", "net::ERR_BLOCKED_BY_CLIENT" in errors, errors)

        # The service worker reaches the page the same way the side panel does.
        tab_id = cdp.evaluate(sws, "chrome.tabs.query({url: 'http://127.0.0.1/*'}).then(t => t[0].id)")
        outline = cdp.evaluate(sws, f"chrome.tabs.sendMessage({tab_id}, {{type: 'cp:outline'}}).then(r => r.outline)")
        check("page outline over extension messaging", bool(outline) and "#story" in outline, outline)
        chunks = cdp.evaluate(sws, f"chrome.tabs.sendMessage({tab_id}, {{type: 'cp:read-prepare', mode: 'page'}}).then(r => r.chunks)")
        check("read-aloud text over extension messaging", bool(chunks) and chunks[0].startswith("Volunteers restore"), chunks)
        check("hidden ads are not read aloud", bool(chunks) and not any("ADVERTISEMENT" in c for c in chunks), chunks)

        # Read-aloud engine, driven from an extension page like the side panel does.
        # chrome.tts.speak is replaced by a silent fake that fires the same events.
        cdp.evaluate(sws, """
            globalThis.__spoken = [];
            chrome.tts.speak = (text, opts) => {
                __spoken.push(text);
                setTimeout(() => opts.onEvent({ type: 'word', charIndex: 0, length: 3 }), 10);
                setTimeout(() => opts.onEvent({ type: 'end' }), 40);
            };
            chrome.tts.stop = () => {};
        """)
        ext_page = cdp.attach(cdp.call("Target.createTarget", url=f"chrome-extension://{ext_id}/sidepanel.html")["result"]["targetId"])
        time.sleep(1)
        cdp.evaluate(ext_page, f"chrome.runtime.sendMessage({{type: 'tts:start', tabId: {tab_id}, mode: 'page'}})")
        # Poll from here: timers inside a background tab are throttled to ~1 s.
        state, highlighted = None, False
        for _ in range(100):
            state = cdp.evaluate(ext_page, "chrome.runtime.sendMessage({type: 'tts:get'})")
            highlighted = highlighted or cdp.evaluate(ps, "CSS.highlights.has('cp-chunk') && CSS.highlights.has('cp-word')")
            if state and state["state"] == "playing" and highlighted:
                break
            time.sleep(0.005)
        check("reader starts playing", state and state["state"] == "playing", state)
        check("spoken word is highlighted in the page", highlighted)
        time.sleep(1.5)
        spoken = cdp.evaluate(sws, "__spoken")
        check("reader advances through every chunk in order", spoken == chunks, spoken)
        state = cdp.evaluate(ext_page, "chrome.runtime.sendMessage({type: 'tts:get'})")
        check("reader stops at the end and clears highlights", state["state"] == "idle" and not cdp.evaluate(ps, "CSS.highlights.has('cp-chunk')"), state)

        cdp.evaluate(sws, "chrome.storage.local.get('cp:settings').then(r => chrome.storage.local.set({'cp:settings': {...r['cp:settings'], paused: ['127.0.0.1']}}))")
        time.sleep(0.5)
        check("pausing the site restores the original page", style(".ad-slot", "display") == "block" and style("img.hero", "display") == "block")
        dynamic = cdp.evaluate(sws, "chrome.declarativeNetRequest.getDynamicRules()")
        check("paused site gets a network allow rule", bool(dynamic) and dynamic[0]["condition"]["requestDomains"] == ["127.0.0.1"], dynamic)

        panel_id = cdp.call("Target.createTarget", url=f"chrome-extension://{ext_id}/sidepanel.html")["result"]["targetId"]
        time.sleep(1.5)
        pan = cdp.attach(panel_id)
        check("side panel script runs", cdp.evaluate(pan, "document.getElementById('site').textContent") == "No website open")
        check("side panel lists the Claude models", cdp.evaluate(pan, "document.getElementById('model').options.length") == 3)
        voices = cdp.evaluate(sws, "new Promise(r => chrome.tts.getVoices(r)).then(v => v.length)")
        print(f"info chrome.tts voices available: {voices}")
    finally:
        proc.kill()
        server.shutdown()
    print("PASS" if not failed else f"FAIL {failed}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
