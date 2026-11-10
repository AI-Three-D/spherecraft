# Static server for owned measurement runs (never the owner's :8181 server).
# usage: python3 noCacheServer.py PORT ROOT
import functools
import http.server
import socketserver
import sys

PORT = int(sys.argv[1])
ROOT = sys.argv[2]


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        super().end_headers()

    def log_message(self, *args):
        pass


socketserver.TCPServer.allow_reuse_address = True
with socketserver.ThreadingTCPServer(("127.0.0.1", PORT), functools.partial(Handler, directory=ROOT)) as httpd:
    httpd.serve_forever()
