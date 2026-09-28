"""Cache-busting for chenbao.tech.

Cloudflare tells browsers to keep .js / .css / images / fonts for 3 days, so an updated file with the same URL
can stay stale on returning visitors. Every internal reference to a file that changes is therefore written with
a version query (?v=TOKEN), and ride.js appends ASSET_V to the parallax layer images. Run this after changing
any of those files, then commit:

    python tools/bump-version.py            # new token = UTC timestamp
    python tools/bump-version.py 20260928b  # explicit token
"""
import re, sys, time, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
FILES = ['index.html', 'js/main.js', 'js/ride.js', 'js/ui.js', 'css/site.css']
token = sys.argv[1] if len(sys.argv) > 1 else time.strftime('%Y%m%d%H%M', time.gmtime())
assert re.fullmatch(r'[0-9A-Za-z]+', token), token
total = 0
for f in FILES:
    p = ROOT / f
    s = p.read_bytes().decode('utf-8')
    # only our own files: <path>.(js|css|jpg|webp|png)?v=TOKEN (never e.g. youtube.com/watch?v=...)
    s2, n1 = re.subn(r'((?<![:/\w])(?:[\w.-]+/)*[\w.-]+\.(?:js|css|jpg|webp|png)\?v=)[0-9A-Za-z]+', r'\g<1>' + token, s)
    s2, n2 = re.subn(r"(const ASSET_V = ')[0-9A-Za-z]+(')", r'\g<1>' + token + r'\g<2>', s2)
    if s2 != s:
        p.write_bytes(s2.encode('utf-8'))
    total += n1 + n2
    print(f'{f}: {n1 + n2} version refs')
print('token', token, '| total', total)
