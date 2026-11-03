"""GLiNER2 extraction service for the search parser (cold path).

    ml/.venv/bin/python ml/parser/service.py 7100 [fastino/gliner2-base-v1] [host]
    (host defaults to 127.0.0.1; the Docker image passes 0.0.0.0 and publishes the port on the server's localhost only)

GET /health -> {"ok": true, "model": ...}
POST /extract {"text": ...} -> {"model": ..., "result": {"entities": {...}, "equipment": {"label", "confidence"}}}
Single-threaded on purpose: one model, one request at a time.
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

from gliner2 import GLiNER2

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 7100
MODEL = sys.argv[2] if len(sys.argv) > 2 else "fastino/gliner2-base-v1"
HOST = sys.argv[3] if len(sys.argv) > 3 else "127.0.0.1"
model = GLiNER2.from_pretrained(MODEL)
schema = (
    model.create_schema()
    .entities({
        "origin_city": "city or town where the empty truck is",
        "destination": "destination city, state, region or 'anywhere'",
        "rate_per_mile": "minimum pay in dollars per mile",
        "deadhead_miles": "radius or deadhead distance in miles",
    })
    .classification("equipment", ["van", "reefer", "flatbed", "unspecified"])
)


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._send(200, {"ok": True, "model": MODEL}) if self.path == "/health" else self._send(404, {"error": "not_found"})

    def do_POST(self):
        if self.path != "/extract":
            self._send(404, {"error": "not_found"})
            return
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        self._send(200, {"model": MODEL, "result": model.extract(body["text"], schema, include_confidence=True)})

    def log_message(self, *args):
        pass


print(f"gliner2 service ready on {HOST}:{PORT} ({MODEL})", flush=True)
HTTPServer((HOST, PORT), Handler).serve_forever()
