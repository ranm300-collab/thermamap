# same as python -m http.server, but tells the browser never to cache anything.
# use this instead while developing so css/js edits always show up on refresh

import http.server

PORT = 8000

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

if __name__ == '__main__':
    server = http.server.ThreadingHTTPServer(('', PORT), NoCacheHandler)
    print(f'serving at http://localhost:{PORT}, caching turned off')
    server.serve_forever()
