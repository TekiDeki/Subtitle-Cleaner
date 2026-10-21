#!/usr/bin/env python3
# Subtitle Cleaner - TekiDeki
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Kristian Mario Miskovic (TekiDeki)
"""Build a single self contained index.html.

Deterministic by design: the same sources always give byte identical output,
with no timestamps, no dictionary ordering surprises and no machine paths.

The fourth locale, Serbian Cyrillic, is never written by hand: it is produced
here by transliterating the Serbian Latin strings.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
TEMPLATE = SRC / "template.html"
STYLES = SRC / "styles.css"
MODEL_JS = SRC / "model.js"
APP_JS = SRC / "app.js"
LOCALES = SRC / "i18n" / "locales.json"
OUT = ROOT / "index.html"
VERSION_FILE = ROOT / "VERSION"

AUTHORED = ("en", "ro", "sr-latn")
ALL_LOCALES = ("en", "ro", "sr-latn", "sr-cyrl")

# Words that stay in Latin script inside the Cyrillic locale: formats, names.
KEEP_LATIN = (
    "SRT",
    "VTT",
    "srt",
    "vtt",
    "WEBVTT",
    "HTML",
    "CSS",
    "JSON",
    "TekiDeki",
    "GitHub",
    "freehtml.dev",
    "AI",
)

NON_SERBIAN = set("qwxQ WX".replace(" ", ""))

DIGRAPHS = {"lj": "љ", "nj": "њ", "dž": "џ"}
LETTERS = {
    "a": "а", "b": "б", "c": "ц", "č": "ч", "ć": "ћ", "d": "д", "đ": "ђ",
    "e": "е", "f": "ф", "g": "г", "h": "х", "i": "и", "j": "ј", "k": "к",
    "l": "л", "m": "м", "n": "н", "o": "о", "p": "п", "r": "р", "s": "с",
    "š": "ш", "t": "т", "u": "у", "v": "в", "z": "з", "ž": "ж",
}

PLACEHOLDER_RE = re.compile(r"\{[a-zA-Z]+\}")
FORBIDDEN = {"\u2013": "en dash", "\u2014": "em dash", "\u00a0": "no-break space"}


class BuildError(SystemExit):
    pass


def fail(message: str) -> None:
    raise BuildError("build failed: " + message)


def read(path: Path) -> str:
    data = path.read_bytes()
    if data.startswith(b"\xef\xbb\xbf"):
        fail(f"{path.name} starts with a byte order mark")
    return data.decode("utf-8")


def check_text(name: str, text: str) -> None:
    for char, label in FORBIDDEN.items():
        if char in text:
            line = text[: text.index(char)].count("\n") + 1
            fail(f"{name} contains a {label} on line {line}")
    if "\ufffd" in text:
        fail(f"{name} contains a replacement character")


def transliterate(text: str) -> str:
    """Serbian Latin to Cyrillic, leaving {placeholders} and kept terms alone."""
    if not text:
        return text

    protected: list[str] = []

    def keep(value: str) -> str:
        protected.append(value)
        return f"\x00{len(protected) - 1}\x00"

    work = PLACEHOLDER_RE.sub(lambda match: keep(match.group(0)), text)
    for term in sorted(KEEP_LATIN, key=len, reverse=True):
        work = work.replace(term, keep(term))

    out: list[str] = []
    index = 0
    lowered = work.lower()
    while index < len(work):
        pair = lowered[index: index + 2]
        if pair in DIGRAPHS:
            cyr = DIGRAPHS[pair]
            out.append(cyr.upper() if work[index].isupper() else cyr)
            index += 2
            continue
        char = work[index]
        lower = char.lower()
        if lower in LETTERS:
            cyr = LETTERS[lower]
            out.append(cyr.upper() if char.isupper() else cyr)
        else:
            out.append(char)
        index += 1

    result = "".join(out)
    for position, value in enumerate(protected):
        result = result.replace(f"\x00{position}\x00", value)
    return result


def leftovers(text: str) -> set[str]:
    work = PLACEHOLDER_RE.sub(" ", text)
    for term in sorted(KEEP_LATIN, key=len, reverse=True):
        work = work.replace(term, " ")
    return {char for char in work if char.isascii() and char.isalpha() and char not in NON_SERBIAN}


def load_strings(path: Path, name: str) -> dict[str, dict[str, str]]:
    try:
        data = json.loads(read(path))
    except json.JSONDecodeError as error:
        fail(f"{path.name} is not valid JSON: {error}")
    for locale in AUTHORED:
        if locale not in data:
            fail(f"{path.name} is missing the {locale} block")
    reference = set(data["en"])
    for locale in AUTHORED:
        if set(data[locale]) != reference:
            missing = sorted(reference - set(data[locale]))
            extra = sorted(set(data[locale]) - reference)
            fail(f"{name}: {locale} key set differs (missing {missing[:6]}, extra {extra[:6]})")
    placeholders = lambda value: frozenset(PLACEHOLDER_RE.findall(value))
    for key in reference:
        expected = placeholders(data["en"][key])
        for locale in AUTHORED:
            if placeholders(data[locale][key]) != expected:
                fail(f"{name}: placeholder mismatch for {key} in {locale}")
    data["sr-cyrl"] = {key: transliterate(data["sr-latn"][key]) for key in data["sr-latn"]}
    for locale in ALL_LOCALES:
        for key, value in data[locale].items():
            if not isinstance(value, str) or not value.strip():
                fail(f"{name}: empty or non string value for {key} in {locale}")
            check_text(f"{name} {locale}.{key}", value)
    for key, value in data["sr-cyrl"].items():
        bad = leftovers(value)
        if bad:
            fail(f"{name}: sr-cyrl.{key} still has Latin letters {sorted(bad)}: {value}")
    return data


def bundle(variable: str, data: dict[str, dict[str, str]]) -> str:
    payload = ",\n".join(
        "  " + json.dumps(locale) + ": " + json.dumps(data[locale], ensure_ascii=False, sort_keys=True)
        for locale in ALL_LOCALES
    )
    return "/* Generated by build.py. Do not edit. */\nwindow." + variable + " = {\n" + payload + "\n};\n"


def build() -> str:
    version = read(VERSION_FILE).strip()
    if not re.fullmatch(r"\d+(\.\d+)*", version):
        fail("VERSION must be a dotted number")

    template = read(TEMPLATE)
    styles = read(STYLES)
    model_js = read(MODEL_JS)
    app_js = read(APP_JS)

    for name, text in (("template.html", template), ("styles.css", styles),
                       ("model.js", model_js), ("app.js", app_js)):
        check_text(name, text)

    for name, text in (("model.js", model_js), ("app.js", app_js)):
        if "</script" in text.lower():
            fail(f"{name} contains a literal closing script tag")

    locales = load_strings(LOCALES, "locales.json")
    locales_js = bundle("TD_LOCALES", locales)
    if "</script" in locales_js.lower():
        fail("locales.js contains a literal closing script tag")

    used = set(re.findall(r'data-i18n(?:-title|-aria-label|-placeholder|-html)?="([^"]+)"', template))
    used |= set(re.findall(r"\bt\('([A-Za-z0-9_]+)'", app_js))
    used |= set(re.findall(r"\btn\('([A-Za-z0-9_]+)'", app_js))
    missing = sorted(key for key in used if key not in locales["en"] and key + "_one" not in locales["en"])
    if missing:
        fail(f"template or app uses unknown keys: {missing}")

    for required in ("fileCues_one", "fileCues_few", "fileCues_many"):
        if required not in locales["en"]:
            fail(f"the plural table is incomplete: {required} is missing")

    unused = sorted(key for key in locales["en"]
                    if key not in used and not key.endswith(("_one", "_few", "_many")))
    if unused:
        fail(f"locales.json has strings nothing reads: {unused}")

    html = template
    style_tag = '<link rel="stylesheet" href="styles.css">'
    if style_tag not in html:
        fail("template is missing the stylesheet link")
    html = html.replace(style_tag, "<style>\n" + styles.rstrip() + "\n</style>", 1)

    for src, body in (
        ('<script src="model.js"></script>', model_js),
        ('<script src="i18n/locales.js"></script>', locales_js),
        ('<script src="app.js"></script>', app_js),
    ):
        if src not in html:
            fail(f"template is missing {src}")
        html = html.replace(src, "<script>\n" + body.rstrip() + "\n</script>", 1)

    html = html.replace('<html lang="en">', '<html lang="en" data-version="' + version + '">', 1)
    html = html.replace("</body>", "<!-- Subtitle Cleaner " + version + " · single file build -->\n</body>", 1)

    check_text("index.html", html)

    if '<link rel="stylesheet"' in html or re.search(r'<script src="(?!https://)', html):
        fail("index.html still references a local asset")
    if not html.startswith("<!DOCTYPE html>"):
        fail("index.html must start with the doctype")

    OUT.write_text(html, encoding="utf-8")
    return html


def main() -> None:
    html = build()
    size = len(html.encode("utf-8"))
    locales = json.loads(read(LOCALES))
    print(f"index.html written, {size} bytes, {size / 1024:.1f} KiB")
    print(f"interface strings: {len(locales['en'])} keys in {', '.join(ALL_LOCALES)}")
    print(f"VERSION: {read(VERSION_FILE).strip()}")


if __name__ == "__main__":
    main()
