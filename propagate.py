#!/usr/bin/env python3
"""Propagate neohiro-network shared-chrome edits from neohiro.github.io to the
other three sites, preserving each file's line-ending style.

Design: extract the NEW content from neohiro (source of truth) and apply it to
targets, so there is no hand transcription to drift. Idempotent: every item is
skipped when its result is already present. Reports APPLIED / ALREADY /
MISSING per site per item, then prints a normalized identity table.

Run from the site root is NOT required; paths resolve from this file:
    python repos/auto-resume/propagate.py
"""
import hashlib
import os
import re
import sys

BASE = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
SITES = [
    "neohiro.github.io",
    "frenzypenguin-media.github.io",
    "transhumanists.github.io",
    "openstageisland.github.io",
]
SHELLS = ["osi", "neohiro", "fpm", "transhumanists"]

HIDDEN_CSS_RULE = """
/* The assistant variable panels are display:flex boxes. The UA [hidden] rule
   loses to that, and these panels are toggled via the `hidden` property (not
   the .hidden class), so without this override they never visually hide. */
.ai-bar__vars[hidden],
.ai-conv__vars[hidden] {
  display: none !important;
}"""


def load(site, rel):
    p = os.path.join(BASE, site, *rel.split("/"))
    with open(p, "rb") as fh:
        raw = fh.read().decode("utf-8")
    crlf = "\r\n" in raw
    return raw.replace("\r\n", "\n"), crlf


def save(site, rel, text, crlf):
    p = os.path.join(BASE, site, *rel.split("/"))
    out = text.replace("\n", "\r\n") if crlf else text
    with open(p, "wb") as fh:
        fh.write(out.encode("utf-8"))


def report(site, item, status, detail=""):
    print("  %-28s %-34s %-8s %s" % (site, item, status, detail))


def case_block(text, shell):
    m = re.search(
        r"\{%- when '" + shell + r"' -%\}(.*?)(?=\{%- (?:when|endcase))",
        text,
        re.DOTALL,
    )
    return m.group(1) if m else None


def main():
    missing = []

    # ---- Load source of truth -------------------------------------------
    src_bar, _ = load("neohiro.github.io", "_includes/bottom-bar.html")
    src_nav, _ = load("neohiro.github.io", "_includes/nav.html")
    src_uxjs, _ = load("neohiro.github.io", "assets/js/network-ux.js")

    # Extract: ai_title assign line
    m = re.search(r"  \{%- assign ai_title = .*?-%\}", src_bar)
    ai_assign = m.group(0) if m else None

    # Extract: per-shell CTA svg blocks from source
    src_svgs = {}
    for sh in SHELLS:
        blk = case_block(src_bar, sh)
        if blk:
            sm = re.search(r'(<svg class="bottom-bar__cta-icon".*?</svg>)', blk, re.DOTALL)
            src_svgs[sh] = sm.group(1) if sm else None

    # Extract: network switcher block (switcher start .. just before auth comment)
    sw_start = src_nav.find("  <!-- ── Network switcher")
    sw_end = src_nav.find("  <!-- ── Auth slot")
    switcher = src_nav[sw_start:sw_end] if 0 <= sw_start < sw_end else None

    # Extract: starfield guard span from source
    anchor = "    if (document.getElementById('starfield')) return;\n"
    guard = None
    ai = src_uxjs.find(anchor)
    if ai >= 0:
        gm = re.search(r"if \(reduceMotion \|\| isMobile\) return;\n", src_uxjs[ai:])
        if gm:
            guard = src_uxjs[ai : ai + gm.end()]

    # ---- Per-site application -------------------------------------------
    for site in SITES:
        # -- bottom-bar.html --
        rel = "_includes/bottom-bar.html"
        text, crlf = load(site, rel)
        changed = False

        if "ai_title" in text:
            report(site, "bottom-bar ai_title", "ALREADY")
        elif ai_assign and '<button type="button" class="bottom-bar__ai"' in text:
            text = text.replace(
                '  <button type="button" class="bottom-bar__ai"',
                ai_assign + '\n  <button type="button" class="bottom-bar__ai"',
                1,
            )
            old_title = 'title="Talk to the neohiro assistant'
            if old_title in text:
                # replace up to the closing quote of the title attribute
                text = re.sub(
                    r'title="Talk to the neohiro assistant[^"]*"',
                    'title="{{ ai_title }}"',
                    text,
                    count=1,
                )
                changed = True
                report(site, "bottom-bar ai_title", "APPLIED")
            else:
                missing.append((site, "bottom-bar AI title (no neohiro title found)"))
                report(site, "bottom-bar ai_title", "MISSING", "title attr differs")
        else:
            missing.append((site, "bottom-bar ai button anchor"))
            report(site, "bottom-bar ai_title", "MISSING", "no ai button")

        for sh in SHELLS:
            blk = case_block(text, sh)
            if blk is None:
                continue
            if '<svg class="bottom-bar__cta-icon"' in blk:
                report(site, "bottom-bar cta svg [%s]" % sh, "ALREADY")
                continue
            sm = re.search(r'(<span class="bottom-bar__cta-icon".*?</span>)', blk, re.DOTALL)
            if sm and src_svgs.get(sh):
                text = text.replace(sm.group(1), src_svgs[sh], 1)
                changed = True
                report(site, "bottom-bar cta svg [%s]" % sh, "APPLIED")
            else:
                missing.append((site, "bottom-bar cta svg [%s]" % sh))
                report(site, "bottom-bar cta svg [%s]" % sh, "MISSING")

        if changed:
            save(site, rel, text, crlf)

        # -- nav.html --
        rel = "_includes/nav.html"
        text, crlf = load(site, rel)
        changed = False

        if 'Beats|/heartbeats/|4' in text:
            text = text.replace(
                '- "Beats|/heartbeats/|4"',
                '- "Guides|/#hardening-guides|4"',
                1,
            )
            changed = True
            report(site, "nav Beats comment", "APPLIED")
        else:
            report(site, "nav Beats comment", "ALREADY")

        if "nav-network-btn" in text:
            report(site, "nav network switcher", "ALREADY")
        elif switcher:
            anchor_line = "  {%- assign dash = site.dashboard_url"
            di = text.find(anchor_line)
            if di >= 0:
                text = text[:di] + switcher + text[di:]
                changed = True
                report(site, "nav network switcher", "APPLIED")
            else:
                missing.append((site, "nav dash anchor"))
                report(site, "nav network switcher", "MISSING", "no dash anchor")
        else:
            missing.append((site, "nav switcher source"))
            report(site, "nav network switcher", "MISSING", "no source block")

        if changed:
            save(site, rel, text, crlf)

        # -- network-ux.js --
        rel = "assets/js/network-ux.js"
        text, crlf = load(site, rel)
        if "reduceMotion" in text:
            report(site, "uxjs starfield guard", "ALREADY")
        elif guard and anchor in text:
            text = text.replace(anchor, guard, 1)
            save(site, rel, text, crlf)
            report(site, "uxjs starfield guard", "APPLIED")
        else:
            missing.append((site, "uxjs starfield anchor"))
            report(site, "uxjs starfield guard", "MISSING")

        # -- network-ux.css --
        rel = "assets/css/network-ux.css"
        text, crlf = load(site, rel)
        if ".ai-bar__vars[hidden]" in text:
            report(site, "uxcss hidden override", "ALREADY")
        elif ".hidden { display: none !important; }" in text:
            text = text.replace(
                ".hidden { display: none !important; }",
                ".hidden { display: none !important; }" + HIDDEN_CSS_RULE,
                1,
            )
            save(site, rel, text, crlf)
            report(site, "uxcss hidden override", "APPLIED")
        else:
            missing.append((site, "uxcss .hidden anchor"))
            report(site, "uxcss hidden override", "MISSING")

    # ---- Identity table (CRLF-normalized) --------------------------------
    print("")
    print("=== normalized identity (md5 of LF content) ===")
    for rel in [
        "_includes/bottom-bar.html",
        "_includes/nav.html",
        "assets/js/network-ux.js",
        "assets/css/network-ux.css",
        "assets/css/bottom-bar.css",
        "assets/js/bottom-bar.js",
        "assets/css/ai-seal.css",
    ]:
        hashes = {}
        for site in SITES:
            p = os.path.join(BASE, site, *rel.split("/"))
            if not os.path.exists(p):
                hashes[site] = "MISSING"
                continue
            with open(p, "rb") as fh:
                norm = fh.read().decode("utf-8").replace("\r\n", "\n")
            hashes[site] = hashlib.md5(norm.encode("utf-8")).hexdigest()[:12]
        uniq = set(hashes.values())
        flag = "IDENTICAL" if len(uniq) == 1 else "DRIFTED"
        print("  %-28s %s  %s" % (rel, flag, hashes))

    print("")
    if missing:
        print("MISSING items needing manual follow-up:")
        for site, item in missing:
            print("  - %s: %s" % (site, item))
    else:
        print("No missing items. All propagations applied or already present.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
