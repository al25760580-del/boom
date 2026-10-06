#!/usr/bin/env python3
"""
Local server for the "transparent" edition of the explosion gif maker.

  GET  /                 -> web interface (web/index.html)
  POST /api/explode      -> {image: dataURL, fx, max_kb, size, keep_aspect, prefer}
                            returns {gif: dataURL, kb, config}

Run:  python3 server.py  (port 8000, listening on 0.0.0.0)
"""
import base64, io, json, os, sys, threading, traceback
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "web")
sys.path.insert(0, HERE)
import explode as X  # noqa: E402

STATUS = {}
LOCK = threading.Lock()


def do_job(job_id, payload):
    def run():
        try:
            with LOCK:
                STATUS[job_id] = {"state": "working", "msg": "reading image..."}
            head, b64 = payload["image"].split(",", 1)
            img = X.Image.open(io.BytesIO(base64.b64decode(b64)))
            img.load()
            img = img.convert("RGBA")
            out = []
            for name in payload["fx"]:
                with LOCK:
                    STATUS[job_id] = {"state": "working",
                                      "msg": "[%s] building frames..." % name}
                size = int(payload.get("size", 512))
                frames, durs = X.build(name, img, size=size,
                                       keep_aspect=bool(payload.get("keep_aspect")),
                                       verbose=False)
                tmp = os.path.join(HERE, "out", "_tmp_%s_%s.gif" % (job_id, name))
                os.makedirs(os.path.dirname(tmp), exist_ok=True)
                path, s, sz, colors, lossy, drop = X.export_gif(
                    frames, durs, tmp,
                    max_kb=float(payload.get("max_kb", 250)), base=size,
                    min_size=int(payload.get("min_size", 128)),
                    profile=payload.get("prefer", "balanced"), verbose=False)
                data = open(path, "rb").read()
                os.remove(path)
                out.append({"name": name,
                            "gif": "data:image/gif;base64," + base64.b64encode(data).decode(),
                            "kb": round(len(data) / 1024.0, 1),
                            "config": "%dpx, %d colores, %d frames" % (sz, colors, len(frames[::drop]))})
            with LOCK:
                STATUS[job_id] = {"state": "done", "results": out}
        except Exception as e:
            traceback.print_exc()
            with LOCK:
                STATUS[job_id] = {"state": "error", "msg": str(e)}
    threading.Thread(target=run, daemon=True).start()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=WEB, **kw)

    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.end_headers()

    def do_POST(self):
        if urlparse(self.path).path != "/api/explode":
            return self._json({"error": "not found"}, 404)
        n = int(self.headers.get("Content-Length", 0))
        payload = json.loads(self.rfile.read(n) or b"{}")
        job_id = str(int(__import__("time").time() * 1000))
        do_job(job_id, payload)
        return self._json({"job": job_id})

    def do_GET(self):
        p = urlparse(self.path).path
        if p.startswith("/status/"):
            j = p.rsplit("/", 1)[-1]
            with LOCK:
                return self._json(STATUS.get(j, {"state": "unknown"}))
        return super().do_GET()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print("explosion gif maker (transparent edition) -> http://0.0.0.0:%d" % port)
    srv.serve_forever()
