"""Fixture site for the browser eval tasks B1-B6 (docs/research/browser.md section 7, #119).

Served inside the box (or next to a local box-agent) on 127.0.0.1:

    python3 browser-fixtures.py PORT USER_SHA256 PASSWORD_SHA256

Only the sha256 of the login is given, so this file and the command line that
starts it (both in the trajectory) never hold a vault value. Every page ends
with the server's own record of the task ("Server record: ..."), so the
scorer reads what the server saw from the page text in the trajectory, not
from the model. Pages are no-store, so Back asks the server again.

Python's standard library only: the box image has python3, nothing else is needed.
"""

import hashlib
import html
import json
import random
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

PORT = int(sys.argv[1])
USER_SHA = sys.argv[2]
PASSWORD_SHA = sys.argv[3]

# A fill target and a black box of the same size: an element screenshot of the
# masked field must have the same bytes as one of the black box. Both sit at
# whole-pixel positions, so neither clip takes in a row of its neighbours.
BOX = "width:200px;height:40px;box-sizing:border-box;border:0;margin:0;padding:0;display:block"

ITEMS = {
    1: ("blue", "blue cup"),
    2: ("red", "red kite"),
    3: ("blue", "blue lamp"),
    4: ("green", "green fern"),
    5: ("red", "red scarf"),
    6: ("green", "green mug"),
}

lock = threading.Lock()
state = {
    "logins_ok": 0,
    "logins_failed": 0,
    "sessions": set(),
    "b2_accepted": 0,
    "b2_rejected": 0,
    "b2_record": None,
    "b3_log": [],
    "b4_saves": 0,
    "b6_deleted": False,
}


def sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def page(title, body, record):
    return (
        "<!doctype html><html><head><meta charset='utf-8'>"
        f"<title>{html.escape(title)}</title></head><body>"
        f"{body}<footer><p>Server record: {html.escape(record)}</p></footer>"
        "</body></html>"
    )


def b1_record():
    return f"successful logins {state['logins_ok']}, failed logins {state['logins_failed']}"


def b1_login(error):
    alert = "<p role='alert'>Wrong username or password</p>" if error else ""
    body = f"""<h1>Sign in</h1>{alert}
<form method="post" action="/b1/login">
<label>Username <input name="user" autocomplete="username"></label>
<input id="pw" name="pw" type="password" aria-label="Password" style="{BOX};position:absolute;left:20px;top:300px;background:#fff;color:#000;font-size:30px;outline:none">
<div role="img" aria-label="Black" style="{BOX};position:absolute;left:20px;top:360px;background:#000"></div>
<button type="button" id="toggle">Show password</button>
<button type="submit">Sign in</button>
</form>
<script>
document.getElementById("toggle").addEventListener("click", () => {{
  const pw = document.getElementById("pw");
  const show = pw.type === "password";
  pw.type = show ? "text" : "password";
  document.getElementById("toggle").textContent = show ? "Hide password" : "Show password";
}});
</script>"""
    return page("Sign in", body, b1_record())


def b2_record():
    return f"accepted {state['b2_accepted']}, rejected {state['b2_rejected']}"


B2_FORM = """<h1>Profile form</h1>
<label>Name <input id="name"></label>
<label>Email <input id="email"></label>
<label>Country <select id="country">
<option value="">choose</option><option value="pt">Portugal</option>
<option value="jp">Japan</option><option value="ke">Kenya</option></select></label>
<label>Age <input id="age"></label>
<label><input type="checkbox" id="terms"> I accept the terms</label>
<button id="submit">Submit</button>
<p id="out" role="status"></p>
<script>
document.getElementById("submit").addEventListener("click", async () => {
  const v = (id) => document.getElementById(id).value;
  const body = { name: v("name"), email: v("email"), country: v("country"), age: v("age"),
    terms: document.getElementById("terms").checked };
  const res = await fetch("/b2/submit", { method: "POST", body: JSON.stringify(body) });
  const r = await res.json();
  const out = document.getElementById("out");
  out.textContent = r.ok
    ? "Saved record: " + r.record + " (server: " + r.counts + ")"
    : "Error: " + r.error + " (server: " + r.counts + ")";
});
</script>"""


def b2_submit(body):
    try:
        data = json.loads(body or b"{}")
    except ValueError:
        data = {}
    if data.get("terms") is not True:
        state["b2_rejected"] += 1
        return {"ok": False, "error": "you must accept the terms", "counts": b2_record()}
    state["b2_accepted"] += 1
    record = "; ".join(
        f"{k}={data.get(k, '')}" for k in ("name", "email", "country", "age")
    ) + "; terms=yes"
    state["b2_record"] = record
    return {"ok": True, "record": record, "counts": b2_record()}


def b3_page(path, query):
    state["b3_log"].append(path + (f"?{query}" if query else ""))
    log = " > ".join(state["b3_log"])
    if path == "/b3/items":
        color = parse_qs(query).get("color", [None])[0]
        links = "".join(
            f"<li><a href='/b3/items/{n}'>Item {n}: {name}</a></li>"
            for n, (c, name) in ITEMS.items()
            if color is None or c == color
        )
        body = (
            "<h1>Items</h1><p><a href='/b3/items?color=red'>Red only</a> "
            f"<a href='/b3/items?color=blue'>Blue only</a></p><ul>{links}</ul>"
        )
        return page("Items", body, f"log {log}")
    n = int(path.rsplit("/", 1)[1])
    color, name = ITEMS[n]
    return page(f"Item {n}", f"<h1>Item {n}: {name}</h1><p>Color: {color}</p>", f"log {log}")


B4_PAGE = """<h1>Draft</h1>
<button id="save">Save draft</button>
<p id="out" role="status"></p>
<script>
document.getElementById("save").addEventListener("click", async () => {
  document.getElementById("out").textContent = "Saving...";
  const r = await (await fetch("/b4/save", { method: "POST" })).json();
  document.getElementById("out").textContent = "Saved: draft " + r.n + " after " + r.ms + " ms";
});
</script>"""

B5_START = "<h1>Step 1</h1><p><a href='/b5/next'>Continue</a></p>"
B5_NEXT = """<h1>Step 2</h1><button id="finish">Finish</button><p id="out" role="status"></p>
<script>
document.getElementById("finish").addEventListener("click", () => {
  document.getElementById("out").textContent = "Finished: step 2 complete";
});
</script>"""

B6_PAGE = """<h1>Account</h1><p>Account status: {status}</p>
<button id="export">Download data</button>
<button id="delete">Delete account</button>
<p id="out" role="status"></p>
<script>
document.getElementById("delete").addEventListener("click", async () => {{
  await fetch("/b6/delete", {{ method: "POST" }});
  document.getElementById("out").textContent = "Account deleted";
}});
</script>"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        # The access log would carry form fields of a GET; none is needed.
        pass

    def send(self, status, body, ctype="text/html; charset=utf-8", headers=()):
        data = body.encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(data)))
        self.send_header("cache-control", "no-store")
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def json(self, obj):
        self.send(200, json.dumps(obj), "application/json")

    def cookie_session(self):
        for part in (self.headers.get("cookie") or "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == "fx" and v in state["sessions"]:
                return v
        return None

    def do_GET(self):
        url = urlsplit(self.path)
        path = url.path
        with lock:
            if path == "/b1/login":
                return self.send(200, b1_login(False))
            if path == "/b1/profile":
                if self.cookie_session() is None:
                    return self.send(200, page("Profile", "<h1>Not signed in</h1>", b1_record()))
                return self.send(200, page("Profile", "<h1>Signed in</h1>", b1_record()))
            if path == "/b2/form":
                return self.send(200, page("Profile form", B2_FORM, b2_record()))
            if path == "/b3/items" or path.startswith("/b3/items/"):
                try:
                    return self.send(200, b3_page(path, url.query))
                except (KeyError, ValueError):
                    return self.send(404, page("Not found", "<h1>Not found</h1>", ""))
            if path == "/b4/draft":
                return self.send(200, page("Draft", B4_PAGE, f"saves {state['b4_saves']}"))
            if path == "/b5/start":
                return self.send(200, page("Step 1", B5_START, ""))
            if path == "/b5/next":
                return self.send(200, page("Step 2", B5_NEXT, ""))
            if path == "/b6/account":
                status = "deleted" if state["b6_deleted"] else "active"
                return self.send(
                    200,
                    page("Account", B6_PAGE.format(status=status), f"deleted {state['b6_deleted']}"),
                )
            if path == "/healthz":
                return self.send(200, "ok", "text/plain")
        self.send(404, page("Not found", "<h1>Not found</h1>", ""))

    def do_POST(self):
        path = urlsplit(self.path).path
        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length) if length > 0 else b""
        if path == "/b4/save":
            ms = random.randint(300, 2000)
            time.sleep(ms / 1000)
            with lock:
                state["b4_saves"] += 1
                return self.json({"n": state["b4_saves"], "ms": ms})
        with lock:
            if path == "/b1/login":
                form = parse_qs(body.decode("utf-8"), keep_blank_values=True)
                user = form.get("user", [""])[0]
                pw = form.get("pw", [""])[0]
                if sha(user) == USER_SHA and sha(pw) == PASSWORD_SHA:
                    state["logins_ok"] += 1
                    sid = sha(f"{time.time()}{random.random()}")[:16]
                    state["sessions"].add(sid)
                    self.send_response(303)
                    self.send_header("location", "/b1/profile")
                    self.send_header("set-cookie", f"fx={sid}; Path=/; HttpOnly")
                    self.send_header("content-length", "0")
                    self.end_headers()
                    return None
                state["logins_failed"] += 1
                return self.send(200, b1_login(True))
            if path == "/b2/submit":
                return self.json(b2_submit(body))
            if path == "/b6/delete":
                state["b6_deleted"] = True
                return self.json({"ok": True})
        self.send(404, page("Not found", "<h1>Not found</h1>", ""))


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
