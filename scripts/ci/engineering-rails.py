#!/usr/bin/env python3
"""Stop-cranes for a Vaulter satellite repository.

Scans committed manifests and sources for the zero-royalty denylist
(commercial or copyleft packages, UNLICENSED, Tiptap Pro / Univer Pro and
their registries) and for the source bans a text scan can see: 32-bit
hashtext() locks, session advisory locks, deferred constraints, raw
DB::transaction(), parse_url(), ZipArchive::extractTo(), suppressions, test
->skip(), libclamav linkage and an Eloquent Model on an #[Api] surface.
PHPStan enforces the same call bans semantically; this scan also covers SQL,
TypeScript and Vue.

Exit 0 means zero hits. ``--self-test`` proves a forbidden tree fails and an
allowed twin passes. Run it locally with
``python3 scripts/ci/engineering-rails.py --root . && python3 scripts/ci/engineering-rails.py --self-test``.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import tempfile
from pathlib import Path

FORBIDDEN_EXACT = frozenset(
    {
        "handsontable",
        "hyperformula",
        "dunglas/mercure",
        "minio/minio",
        "exceljs",
        "unzipper",
        "mammoth",
        "xlsx",
        "libclamav",
        "@tiptap-pro",
        "@univerjs-pro",
        "@univer-cli",
    }
)
FORBIDDEN_PREFIXES = ("@tiptap-pro/", "@univerjs-pro/", "@univer-cli/")
DEP_KEYS = frozenset(
    {
        "require",
        "require-dev",
        "conflict",
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
    }
)
SKIP_DIRS = frozenset(
    {
        ".git",
        "vendor",
        "node_modules",
        "build",
        "dist",
        "coverage",
        ".github",
        ".phpunit.cache",
    }
)
SOURCE_EXT = frozenset({".php", ".sql", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".vue"})
LOCK_NAMES = frozenset({"composer.lock", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"})
LOCK_NEEDLES = (
    "@tiptap-pro/",
    "@univerjs-pro/",
    "@univer-cli/",
    "registry.tiptap.dev",
    "handsontable",
    "hyperformula",
    "dunglas/mercure",
    "minio/minio",
    "exceljs",
    "unzipper",
    "mammoth",
    "libclamav",
    "xlsx@0.18.5",
)
BANNED = (
    ("hashtext(", re.compile(r"\bhashtext\s*\(")),
    ("session advisory lock", re.compile(r"\bpg_(?:try_)?advisory_lock\s*\(")),
    ("DEFERRABLE INITIALLY DEFERRED", re.compile(r"DEFERRABLE\s+INITIALLY\s+DEFERRED", re.I)),
    ("DB::transaction()", re.compile(r"\bDB::transaction\s*\(")),
    ("set_config(..., false)", re.compile(r"\bset_config\s*\([^;]*\bfalse\b", re.I)),
    ("parse_url()", re.compile(r"\bparse_url\s*\(")),
    ("ZipArchive::extractTo()", re.compile(r"\bZipArchive::extractTo\s*\(")),
    ("CURLOPT_RESOLVE", re.compile(r"\bCURLOPT_RESOLVE\b")),
    ("@phpstan-ignore", re.compile(r"@phpstan-ignore\b")),
    ("@psalm-suppress", re.compile(r"@psalm-suppress\b")),
    ("REPACK (CONCURRENTLY)", re.compile(r"\bREPACK\s*\(\s*CONCURRENTLY\b", re.I)),
    ("libclamav linkage", re.compile(r"libclamav\.so\b|#include\s*[<\"]clamav")),
    ("registry.tiptap.dev", re.compile(r"registry\.tiptap\.dev")),
)
SKIP_CALL = re.compile(r"->skip\s*\(")
# The Model class itself, not ModelNotFoundException and friends.
ELOQUENT_MODEL = re.compile(r"\bIlluminate\\Database\\Eloquent\\Model\b")
# Both `#[Api]` and `#[Api(since: '1.0')]` are in use.
API_ATTRIBUTE = re.compile(r"#\[Api\b")
FORBIDDEN_DIR_NAMES = frozenset({"Helpers", "Utils", "Common", "Misc", "Traits"})
COPYLEFT = re.compile(r"\b(?:AGPL|GPL|SSPL)(?:-|\b)", re.I)
MANIFEST_NAMES = frozenset({"composer.json", "package.json"})


def forbidden_name(name: str) -> str | None:
    if name in FORBIDDEN_EXACT:
        return name
    for prefix in FORBIDDEN_PREFIXES:
        if name.startswith(prefix):
            return name
    return None


def add(hits: list[str], path: Path, detail: str) -> None:
    hits.append(f"{path}: {detail}")


def walk_deps(node: object, hits: list[str], path: Path) -> None:
    if isinstance(node, dict):
        name = node.get("name")
        if isinstance(name, str):
            bad = forbidden_name(name)
            if bad is not None:
                add(hits, path, f"forbidden package {bad}")
        license_value = node.get("license")
        if isinstance(license_value, str):
            if COPYLEFT.search(license_value):
                add(hits, path, f"copyleft license {license_value}")
            if re.search(r"unlicensed", license_value, re.I):
                add(hits, path, f"UNLICENSED license {license_value}")
            if re.search(r"(?<![A-Za-z])pro(?![A-Za-z])", license_value, re.I):
                add(hits, path, f"Pro license {license_value}")
        for key, value in node.items():
            if key in DEP_KEYS and isinstance(value, dict):
                for dep in value:
                    if isinstance(dep, str):
                        bad = forbidden_name(dep)
                        if bad is not None:
                            add(hits, path, f"forbidden dependency {bad}")
            else:
                walk_deps(value, hits, path)
    elif isinstance(node, list):
        for item in node:
            walk_deps(item, hits, path)


def is_source(path: Path) -> bool:
    return path.name == "Dockerfile" or path.name.startswith("Dockerfile.") or path.suffix in SOURCE_EXT


def is_test(path: Path) -> bool:
    if path.name.endswith("Test.php") or ".test." in path.name:
        return True
    return "tests" in path.parts


def skipped(path: Path) -> bool:
    return any(part in SKIP_DIRS for part in path.parts)


def scan(root: Path) -> list[str]:
    hits: list[str] = []
    if not root.is_dir():
        return [f"{root}: not a directory"]

    composer = root / "composer.json"
    if not composer.is_file():
        hits.append(f"{composer}: missing")
    else:
        try:
            data = json.loads(composer.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            hits.append(f"{composer}: invalid JSON ({exc})")
            data = None
        if isinstance(data, dict):
            php = (data.get("require") or {}).get("php")
            if php != ">=8.4 <8.6":
                hits.append(f"{composer}: require.php must be >=8.4 <8.6, got {php!r}")

    package = root / "package.json"
    if not package.is_file():
        hits.append(f"{package}: missing")
    else:
        try:
            data = json.loads(package.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            hits.append(f"{package}: invalid JSON ({exc})")
            data = None
        if isinstance(data, dict):
            node = (data.get("engines") or {}).get("node")
            if node != ">=26.13.1":
                hits.append(f"{package}: engines.node must be >=26.13.1, got {node!r}")

    for path in root.rglob("*"):
        if skipped(path):
            continue
        if path.is_dir():
            if path.name in FORBIDDEN_DIR_NAMES:
                add(hits, path, "forbidden directory name")
            continue
        if path.name in MANIFEST_NAMES or path.name in LOCK_NAMES and path.suffix == ".json":
            try:
                walk_deps(json.loads(path.read_text(encoding="utf-8")), hits, path)
            except json.JSONDecodeError as exc:
                add(hits, path, f"invalid JSON ({exc})")
        if path.name in LOCK_NAMES:
            text = path.read_text(encoding="utf-8", errors="replace")
            for needle in LOCK_NEEDLES:
                if needle in text:
                    add(hits, path, f"lockfile contains {needle}")
        if not is_source(path):
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        for label, pattern in BANNED:
            if pattern.search(text):
                add(hits, path, label)
        if is_test(path) and SKIP_CALL.search(text):
            add(hits, path, "->skip()")
        if API_ATTRIBUTE.search(text) and ELOQUENT_MODEL.search(text):
            add(hits, path, "Eloquent Model on an #[Api] surface")
    return hits


def require_fail(label: str, root: Path) -> None:
    hits = scan(root)
    if not hits:
        raise SystemExit(f"self-test {label}: expected hits, found none")


def require_ok(label: str, root: Path) -> None:
    hits = scan(root)
    if hits:
        raise SystemExit("self-test " + label + ": expected clean, got " + "; ".join(hits))


def write_base(root: Path, node: str = ">=26.13.1", php: str = ">=8.4 <8.6") -> None:
    root.mkdir()
    (root / "composer.json").write_text(
        json.dumps({"require": {"php": php}}),
        encoding="utf-8",
    )
    (root / "package.json").write_text(
        json.dumps({"engines": {"node": node}}),
        encoding="utf-8",
    )


def self_test() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)

        clean = base / "clean"
        write_base(clean)
        (clean / "ok.php").write_text(
            "<?php pg_advisory_xact_lock(hashtextextended($k, 0));\n",
            encoding="utf-8",
        )
        (clean / "ok.sql").write_text("DEFERRABLE INITIALLY IMMEDIATE\n", encoding="utf-8")
        require_ok("allowed calls", clean)

        bad_pkg = base / "pkg"
        write_base(bad_pkg)
        (bad_pkg / "composer.json").write_text(
            json.dumps({"require": {"php": ">=8.4 <8.6", "handsontable": "^1.0"}}),
            encoding="utf-8",
        )
        require_fail("handsontable", bad_pkg)

        bad_scope = base / "scope"
        write_base(bad_scope)
        (bad_scope / "package.json").write_text(
            json.dumps(
                {
                    "engines": {"node": ">=26.13.1"},
                    "dependencies": {"@tiptap-pro/extension-comments": "1.0.0"},
                }
            ),
            encoding="utf-8",
        )
        require_fail("@tiptap-pro", bad_scope)

        bad_hash = base / "hash"
        write_base(bad_hash)
        (bad_hash / "lock.php").write_text("<?php hashtext($k);\n", encoding="utf-8")
        require_fail("hashtext", bad_hash)

        bad_lock = base / "lock"
        write_base(bad_lock)
        (bad_lock / "session.php").write_text("<?php pg_advisory_lock($k);\n", encoding="utf-8")
        require_fail("pg_advisory_lock", bad_lock)

        bad_sql = base / "sql"
        write_base(bad_sql)
        (bad_sql / "hot.sql").write_text(
            "ALTER TABLE t ADD CONSTRAINT c FOREIGN KEY (id) REFERENCES p(id) DEFERRABLE INITIALLY DEFERRED;\n",
            encoding="utf-8",
        )
        require_fail("INITIALLY DEFERRED", bad_sql)

        bad_dir = base / "dirs"
        write_base(bad_dir)
        (bad_dir / "Helpers").mkdir()
        require_fail("Helpers", bad_dir)

        bad_node = base / "node"
        write_base(bad_node, node=">=26")
        require_fail("engines.node", bad_node)

        ok_license = base / "license-ok"
        write_base(ok_license)
        (ok_license / "package.json").write_text(
            json.dumps({"license": "proprietary", "engines": {"node": ">=26.13.1"}}),
            encoding="utf-8",
        )
        require_ok("proprietary license", ok_license)

        bad_api = base / "api"
        write_base(bad_api)
        (bad_api / "Pin.php").write_text(
            "<?php\nuse Illuminate\\Database\\Eloquent\\Model;\n#[Api(since: '1.0')]\nfinal class Pin extends Model {}\n",
            encoding="utf-8",
        )
        require_fail("Eloquent Model on #[Api(since: ...)]", bad_api)

        api_exception = base / "api-exception"
        write_base(api_exception)
        (api_exception / "Ops.php").write_text(
            "<?php\nuse Illuminate\\Database\\Eloquent\\ModelNotFoundException;\n#[Api(since: '1.0')]\nfinal class Ops {}\n",
            encoding="utf-8",
        )
        require_ok("ModelNotFoundException on an #[Api] surface", api_exception)

        for label, license_value in (
            ("UNLICENSED", "UNLICENSED"),
            ("GPL", "GPL-3.0-only"),
            ("Pro", "Commercial Pro"),
        ):
            bad_license = base / label
            write_base(bad_license)
            (bad_license / "package.json").write_text(
                json.dumps({"license": license_value, "engines": {"node": ">=26.13.1"}}),
                encoding="utf-8",
            )
            require_fail(label, bad_license)

        linked = base / "clamav"
        write_base(linked)
        (linked / "link.php").write_text("<?php dlopen('libclamav.so');\n", encoding="utf-8")
        require_fail("libclamav linkage", linked)

        listed = base / "denylist"
        write_base(listed)
        (listed / "names.ts").write_text("export const banned = ['libclamav'];\n", encoding="utf-8")
        require_ok("libclamav denylist literal", listed)

    print("stop-crane self-test: pass")
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=".")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args(argv)
    if args.self_test:
        return self_test()
    hits = scan(Path(args.root).resolve())
    if hits:
        print(f"stop-cranes: {len(hits)} hit(s)")
        for hit in hits:
            print(hit)
        return 1
    print("stop-cranes: 0 hits")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
