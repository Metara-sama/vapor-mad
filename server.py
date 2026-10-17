#!/usr/bin/env python3
# 本机文件服务：静态站点 + 上传接收 + 媒体文件清单
import http.server
import json
import os
import socketserver
import urllib.parse

ROOT = os.path.dirname(os.path.abspath(__file__))
MEDIA = os.path.join(ROOT, 'media')
PORT = 8123
EXT = ('.mid', '.midi', '.mp3', '.wav', '.ogg', '.m4a', '.flac',
       '.aac', '.opus', '.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi')
MAX_UPLOAD = 300 * 1024 * 1024


def scan(folder):
    out = []
    if not os.path.isdir(folder):
        return out
    try:
        names = os.listdir(folder)
    except OSError:
        return out
    for name in sorted(names):
        p = os.path.join(folder, name)
        try:
            if not os.path.isfile(p) or name.startswith('.'):
                continue
        except OSError:
            continue
        if name.lower().endswith(EXT):
            out.append(name)
    return out


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def _json(self, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == '/__list':
            self._json(scan(MEDIA) + [n for n in scan(ROOT) if n not in scan(MEDIA)])
            return
        return super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != '/upload':
            self.send_error(404)
            return

        qs = urllib.parse.parse_qs(parsed.query)
        raw_name = qs.get('name', ['upload.bin'])[0]
        name = os.path.basename(raw_name).replace('\\', '_').strip() or 'upload.bin'

        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_UPLOAD:
            self.send_error(413, 'bad length')
            return

        os.makedirs(MEDIA, exist_ok=True)
        dest = os.path.join(MEDIA, name)
        written = 0
        try:
            with open(dest, 'wb') as fh:
                remaining = length
                while remaining > 0:
                    chunk = self.rfile.read(min(262144, remaining))
                    if not chunk:
                        break
                    fh.write(chunk)
                    remaining -= len(chunk)
                    written += len(chunk)
        except OSError:
            self.send_error(500, 'write failed')
            return

        if written != length:
            try:
                os.remove(dest)
            except OSError:
                pass
            self.send_error(500, 'incomplete')
            return

        self._json({'ok': True, 'name': name, 'size': written,
                    'url': './media/' + urllib.parse.quote(name)})

    def log_message(self, fmt, *args):
        pass


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == '__main__':
    os.makedirs(MEDIA, exist_ok=True)
    with Server(('127.0.0.1', PORT), Handler) as httpd:
        print('serving on http://127.0.0.1:%d' % PORT)
        httpd.serve_forever()
