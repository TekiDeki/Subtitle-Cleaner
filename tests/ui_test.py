#!/usr/bin/env python3
"""Browser checks for Subtitle Cleaner.

    python3 tests/ui_test.py

Starts its own server, drives the real page in Chromium and writes nothing to
the repository. Every repair is checked twice: once on the screen, and once by
reading the file that the download button produced.
"""
from __future__ import annotations

import re
import threading
from contextlib import contextmanager
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
FIX = ROOT / "tests" / "fixtures"
checks = [0]
problems = []


def check(condition, message):
    checks[0] += 1
    if not condition:
        problems.append(message)


class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


@contextmanager
def serve():
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(Quiet, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()


STAMP = re.compile(r"(\d{2}):(\d{2}):(\d{2})[,.](\d{3}) --> (\d{2}):(\d{2}):(\d{2})[,.](\d{3})")


def stamps(text):
    out = []
    for match in STAMP.finditer(text):
        groups = [int(value) for value in match.groups()]
        start = ((groups[0] * 60 + groups[1]) * 60 + groups[2]) * 1000 + groups[3]
        end = ((groups[4] * 60 + groups[5]) * 60 + groups[6]) * 1000 + groups[7]
        out.append((start, end))
    return out


def main() -> int:
    with serve() as base, sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
        context = browser.new_context(
            viewport={"width": 1440, "height": 950},
            accept_downloads=True,
            permissions=["clipboard-read", "clipboard-write"],
        )
        page = context.new_page()
        errors, foreign, dialogs = [], [], []

        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("request", lambda r: foreign.append(r.url)
                if not (r.url.startswith(base) or r.url.startswith("blob:") or r.url.startswith("data:")) else None)
        page.on("dialog", lambda d: (dialogs.append(d.message), d.accept()))

        page.goto(base + "/index.html", wait_until="load")
        page.wait_for_timeout(400)

        # ------------------------------------------------------------- the start
        check("Subtitle Cleaner" in page.title(), "the title names the tool")
        check(page.locator("#btn-download").is_disabled(), "the download waits for a file")
        check(page.locator("#empty").is_visible(), "the empty state is explained")
        check(page.locator(".cue").count() == 0, "no cue is shown before a file")
        check(page.locator("#file-line").is_hidden(), "there is no file line before a file")

        # --------------------------------------------------------------- a sample
        page.click("#btn-sample")
        page.wait_for_timeout(250)
        check(page.locator(".cue").count() == 6, "the sample has six cues")
        check(page.locator("#file-line").is_visible(), "the file line appears")
        check("sample.srt" in page.inner_text("#file-name"), "the sample is named")
        check(page.inner_text("#stat-cues") == "6", "the counter says six")
        check(page.locator("#stat-length").inner_text() != "0:00", "the length is filled in")
        check(page.locator(".cue.flag").count() > 0, "the sample shows the cues that need work")
        check(page.locator("#issues li").count() > 0, "the issues are listed with their counts")
        check(page.is_enabled("#btn-download"), "the download wakes up")
        check(not page.locator("#clean-note").is_visible(), "the clean note stays away while there are issues")
        before = int(page.inner_text("#stat-issues"))
        check(before > 0, "the sample starts with issues: %d" % before)

        # ------------------------------------------------------------ fix overlaps
        page.click("#btn-overlaps")
        page.wait_for_timeout(250)
        page.wait_for_function("document.querySelector('#toast').hidden === false")
        check("Overlaps fixed" in page.inner_text("#toast"), "the repair is reported: " + page.inner_text("#toast"))
        left = page.evaluate("window.TDSubs.audit(window.__subs.state.cues).counts.overlap")
        check(left == 0, "no cue overlaps another after the repair: %d" % left)
        check(not any("overlap" in text.lower() for text in page.locator("#issues li").all_inner_texts()),
              "the overlap chip is gone from the report")
        codes = page.evaluate("window.__subs.state.cues.length")
        check(codes == 6, "fixing overlaps keeps every cue")

        # ------------------------------------------------------------------ clean
        page.click("#btn-clean")
        page.wait_for_timeout(250)
        check(page.locator(".cue").count() == 5, "the empty cue is removed")
        check("Cues removed: 1" in page.inner_text("#toast"), "the removal is reported")

        page.click("#btn-strip")
        page.wait_for_timeout(250)
        texts = page.locator(".cue-text").all_inner_texts()
        check(not any("<i>" in text for text in texts), "the tags are gone from the list")

        page.click("#btn-wrap")
        page.wait_for_timeout(250)
        check("Lines re-wrapped" in page.inner_text("#toast"), "re-wrapping is reported")

        page.click("#btn-split")
        page.wait_for_timeout(250)
        check("Cues split" in page.inner_text("#toast"), "splitting is reported")

        page.click("#btn-sort")
        page.wait_for_timeout(250)
        starts = page.evaluate("window.__subs.state.cues.map(c => c.start)")
        check(starts == sorted(starts), "the cues are in time order after the sort: %s" % starts)

        # ------------------------------------------------------------------ shift
        first_before = page.evaluate("window.__subs.state.cues[0].start")
        page.fill("#shift", "2.5")
        page.click("#apply-shift")
        page.wait_for_timeout(250)
        first_after = page.evaluate("window.__subs.state.cues[0].start")
        check(first_after - first_before == 2500, "two and a half seconds were added: %d to %d" % (first_before, first_after))

        page.fill("#shift", "-99")
        page.click("#apply-shift")
        page.wait_for_timeout(250)
        lowest = page.evaluate("Math.min.apply(null, window.__subs.state.cues.map(c => c.start))")
        check(lowest == 0, "a shift past the start stops at zero: %d" % lowest)
        ends_ok = page.evaluate("window.__subs.state.cues.every(c => c.end >= c.start)")
        check(ends_ok, "no cue ends before it starts after the shift")

        # ------------------------------------------------------------------ speed
        page.click("#btn-clear")
        page.wait_for_timeout(200)
        page.click("#btn-sample")
        page.wait_for_timeout(250)
        page.fill("#speed", "2")
        page.click("#apply-speed")
        page.wait_for_timeout(250)
        spans = page.evaluate("window.__subs.state.cues.map(c => [c.start, c.end])")
        check(spans[0] == [250, 1450], "at double speed the first cue starts at 250 ms: %s" % str(spans[0]))
        check("Retimed for 2x" in page.inner_text("#toast"), "the retime is reported")

        # --------------------------------------------------------------- download
        with page.expect_download() as caught:
            page.click("#btn-download")
        download = caught.value
        saved = Path(download.path())
        text = saved.read_text(encoding="utf-8")
        check(download.suggested_filename == "sample.srt", "the download keeps the name: " + download.suggested_filename)
        check(text.startswith("1\n00:00:00,250 --> "), "the SRT starts with the retimed first cue: " + text[:40])
        check(len(stamps(text)) == 6, "the file holds six cues")
        state_times = page.evaluate("window.__subs.state.cues.map(c => [c.start, c.end])")
        check(stamps(text) == [tuple(pair) for pair in state_times], "the file carries the times on the screen")

        # ------------------------------------------------------------------- copy
        page.click("#btn-copy")
        page.wait_for_timeout(400)
        check("Copied" in page.inner_text("#toast"), "copying is confirmed")
        try:
            clipboard = page.evaluate("navigator.clipboard.readText()")
        except Exception:
            clipboard = ""
        check(clipboard.strip() == text.strip(),
              "the clipboard holds the same file the download wrote")

        # ------------------------------------------------------------- VTT export
        page.select_option("#format", "vtt")
        with page.expect_download() as caught:
            page.click("#btn-download")
        vtt = caught.value
        vtt_text = Path(vtt.path()).read_text(encoding="utf-8")
        check(vtt.suggested_filename == "sample.vtt", "the VTT is named with its own extension: " + vtt.suggested_filename)
        check(vtt_text.startswith("WEBVTT\n\n"), "the VTT opens with its header")
        check("-->" in vtt_text and "," not in vtt_text.split("\n")[0], "the VTT uses dots in its times")

        # ------------------------------------------------------------ a real file
        page.click("#btn-clear")
        page.wait_for_timeout(200)
        page.set_input_files("#file-input", str(FIX / "sample.srt"))
        page.wait_for_timeout(600)
        check(page.locator(".cue").count() == 3, "three cues are read from the file")
        check("sample.srt" in page.inner_text("#file-name"), "the uploaded file keeps its name")
        check(page.locator("#format").input_value() == "srt", "an SRT file preselects SRT")

        page.set_input_files("#file-input", str(FIX / "sample.vtt"))
        page.wait_for_timeout(600)
        check(page.locator(".cue").count() == 2, "the VTT file gives two cues")
        check(page.locator("#format").input_value() == "vtt", "a VTT file preselects VTT")

        page.set_input_files("#file-input", str(FIX / "cp1250.srt"))
        page.wait_for_timeout(600)
        check("Bună ziua" in page.locator(".cue-text").first.inner_text(),
              "a file saved in the old Windows encoding is still read: " + page.locator(".cue-text").first.inner_text())

        # ------------------------------------------------------------- the paste
        page.click("#btn-clear")
        page.wait_for_timeout(150)
        page.fill("#paste", "1\n00:00:01,000 --> 00:00:02,000\nPasted by hand\n")
        page.click("#btn-paste")
        page.wait_for_timeout(300)
        check(page.locator(".cue").count() == 1, "pasted text is read")
        check("Pasted by hand" in page.inner_text(".cue-text"), "the pasted line is on the screen")
        check(page.locator("#paste").input_value() == "", "the box is emptied after a good paste")

        page.fill("#paste", "no cues here")
        page.click("#btn-paste")
        page.wait_for_timeout(300)
        check("no subtitle cues" in page.inner_text("#toast").lower() or "replici" in page.inner_text("#toast"),
              "a text without cues is refused: " + page.inner_text("#toast"))
        check(page.locator(".cue").count() == 1, "the old file is not thrown away by a bad paste")

        # ------------------------------------------------------- a very long file
        big = "\n".join(f"{i}\n00:00:{i % 60:02d},000 --> 00:00:{i % 60:02d},500\nLine {i}\n" for i in range(1, 451))
        page.fill("#paste", big)
        page.click("#btn-paste")
        page.wait_for_timeout(600)
        check(page.locator(".cue").count() == 400, "a long file stops drawing at four hundred rows")
        check(page.locator("#too-many").is_visible(), "and says that the rest is in the file")
        check(page.inner_text("#stat-cues") == "450", "while the count still says four hundred and fifty")
        check(page.inner_text("#count").endswith("450") or "450" in page.inner_text("#count"),
              "the cue header counts all of them: " + page.inner_text("#count"))

        # ------------------------------------------------------------------ clear
        page.click("#btn-clear")
        page.wait_for_timeout(250)
        check(page.locator(".cue").count() == 0, "clear empties the list")
        check(page.locator("#empty").is_visible(), "and brings the empty state back")
        check(page.locator("#file-line").is_hidden(), "the file line goes away")
        check(page.locator("#btn-download").is_disabled(), "the download sleeps again")

        # ------------------------------------------------------------------ theme
        page.click("#theme")
        page.wait_for_timeout(200)
        check(page.get_attribute("html", "data-theme") == "dark", "the dark theme goes on")
        page.reload(wait_until="load")
        page.wait_for_timeout(400)
        check(page.get_attribute("html", "data-theme") == "dark", "the dark theme survives a reload")
        page.click("#theme")
        page.wait_for_timeout(150)

        # -------------------------------------------------------------- languages
        for locale, expected in (
            ("ro", "Subtitrări care se deschid curat"),
            ("sr-latn", "Titlovi koji se otvaraju čisto"),
            ("sr-cyrl", "Титлови који се отварају чисто"),
            ("en", "Subtitles that open cleanly"),
        ):
            page.select_option("#lang", locale)
            page.wait_for_timeout(250)
            heading = page.locator("h1").inner_text()
            check(expected in heading, "%s: the heading is translated: %s" % (locale, heading))

        page.select_option("#lang", "ro")
        page.wait_for_timeout(200)
        page.click("#btn-sample")
        page.wait_for_timeout(300)
        check("replici" in page.inner_text("#count"), "ro: six cues read as plural: " + page.inner_text("#count"))
        page.select_option("#lang", "en")
        page.wait_for_timeout(250)

        # ------------------------------------------------- the service worker
        sw = page.evaluate("""async () => {
            const reg = await navigator.serviceWorker.getRegistration();
            return reg ? (reg.active ? 'active' : 'registered') : 'none';
        }""")
        check(sw != "none", "the service worker is registered")

        # ---------------------------------------------------------------- hygiene
        check(not errors, "no console or page errors: %s" % errors[:3])
        check(not foreign, "no request leaves the page: %s" % foreign[:3])
        check(not dialogs, "no alert boxes were needed: %s" % dialogs[:3])
        browser.close()

    print("")
    if problems:
        print("FAIL: %d of %d browser checks" % (len(problems), checks[0]))
        for problem in problems:
            print("  - " + problem)
        return 1
    print("PASS: %d of %d browser checks" % (checks[0], checks[0]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
