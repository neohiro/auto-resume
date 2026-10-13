import hashlib, os

SITES = [
    "neohiro.github.io",
    "frenzypenguin-media.github.io",
    "transhumanists.github.io",
    "openstageisland.github.io",
]
FILES = [
    "_includes/footer-button-row.html",
    "_includes/nav.html",
    "_includes/bottom-bar.html",
    "assets/css/bottom-bar.css",
    "assets/js/network-ux.js",
    "assets/js/bottom-bar.js",
    "assets/css/network-ux.css",
    "assets/css/ai-seal.css",
]

root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "repos")

for f in FILES:
    print("=== %s ===" % f)
    for s in SITES:
        p = os.path.join(root, s, *f.split("/"))
        if not os.path.exists(p):
            print("   %-32s MISSING" % s)
            continue
        b = open(p, "rb").read()
        # normalise CRLF so formatting noise does not mask real drift
        norm = b.replace(b"\r\n", b"\n")
        print(
            "   %-32s %6d bytes  url_index=%d  md5=%s"
            % (s, len(b), norm.count(b"_url_index"), hashlib.md5(norm).hexdigest()[:12])
        )
    print("")
