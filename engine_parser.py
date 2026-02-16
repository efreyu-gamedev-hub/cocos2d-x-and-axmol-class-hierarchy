#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Build CMake compile_commands.json, parse C++ with libclang, build inheritance tree from class `Ref`,
extract class descriptions + public method descriptions, write to JSON.

Usage:
  python3 ref_tree.py /path/to/cmake_project /path/to/out.json
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

# ----------------------------
# libclang bootstrap / loading
# ----------------------------

def run_cmd(cmd: List[str], cwd: Optional[Path] = None, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        check=check,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

def ensure_pip_packages() -> None:
    """
    Best-effort install of python bindings and (often bundled) libclang via pip.
    Works on many systems; on some Linux distros you still need system libclang.
    """
    def pip_install(pkgs: List[str]) -> None:
        run_cmd([sys.executable, "-m", "pip", "install", "--upgrade"] + pkgs, check=True)

    # Try minimal set first
    pip_install(["pip"])
    pip_install(["clang", "libclang"])

def try_install_system_libclang() -> None:
    """
    Best-effort install system libclang if not available.
    We try common package managers. If it fails, we continue (pip path might work).
    """
    sysname = platform.system().lower()

    if sysname == "linux":
        # Try apt-get, dnf, yum, pacman in that order
        if shutil.which("apt-get"):
            try:
                run_cmd(["sudo", "apt-get", "update"], check=True)
                run_cmd(["sudo", "apt-get", "install", "-y", "libclang-dev", "clang"], check=True)
            except Exception:
                pass
        elif shutil.which("dnf"):
            try:
                run_cmd(["sudo", "dnf", "install", "-y", "clang", "clang-libs", "libclang"], check=True)
            except Exception:
                pass
        elif shutil.which("yum"):
            try:
                run_cmd(["sudo", "yum", "install", "-y", "clang", "llvm-libclang", "llvm-devel"], check=True)
            except Exception:
                pass
        elif shutil.which("pacman"):
            try:
                run_cmd(["sudo", "pacman", "-Sy", "--noconfirm", "clang", "llvm-libs"], check=True)
            except Exception:
                pass

    elif sysname == "darwin":
        # Homebrew
        if shutil.which("brew"):
            try:
                run_cmd(["brew", "update"], check=True)
                run_cmd(["brew", "install", "llvm"], check=True)
            except Exception:
                pass

    elif sysname == "windows":
        # Chocolatey (best-effort)
        if shutil.which("choco"):
            try:
                run_cmd(["choco", "install", "-y", "llvm"], check=True)
            except Exception:
                pass

def _find_libclang() -> Optional[str]:
    """Locate the native libclang shared library."""
    sysname = platform.system().lower()
    if sysname == "windows":
        pattern, glob_pat = "libclang.dll", "libclang.dll"
    elif sysname == "darwin":
        pattern, glob_pat = "libclang.dylib", "libclang*.dylib"
    else:
        pattern, glob_pat = "libclang.so", "libclang.so*"

    # 1) Try homebrew llvm on macOS (usually matches the latest clang bindings)
    if sysname == "darwin":
        for brew_prefix in ("/opt/homebrew/opt/llvm/lib", "/usr/local/opt/llvm/lib"):
            brew_path = Path(brew_prefix) / pattern
            if brew_path.exists():
                return str(brew_path)

    # 2) Look next to the clang python package (pip 'libclang' puts it in clang/native/)
    try:
        import clang as _clang_pkg
        pkg_dir = Path(_clang_pkg.__file__).parent
        candidates = list(pkg_dir.rglob(glob_pat))
        if candidates:
            candidates.sort(key=lambda p: len(p.name))
            return str(candidates[0])
    except Exception:
        pass

    return None


def load_clang():
    """
    Import clang.cindex and ensure it can locate libclang shared library.
    """
    try:
        import clang.cindex  # type: ignore
    except ImportError:
        try:
            ensure_pip_packages()
        except Exception:
            pass
        try:
            try_install_system_libclang()
        except Exception:
            pass
        import clang.cindex  # type: ignore

    # Configure library path before any clang API calls
    lib_path = _find_libclang()
    if lib_path:
        clang.cindex.Config.set_library_file(lib_path)

    return clang.cindex

# ----------------------------
# CMake compile_commands.json
# ----------------------------

def generate_compile_commands(project_dir: Path) -> Path:
    """
    Runs CMake to generate compile_commands.json.
    Creates build directory in project root: <project>/build
    """
    if not project_dir.exists():
        raise FileNotFoundError(f"Project dir does not exist: {project_dir}")

    build_dir = project_dir / "build"
    build_dir.mkdir(parents=True, exist_ok=True)

    # Configure with compile commands export
    cmd = [
        "cmake",
        "-S", str(project_dir),
        "-B", str(build_dir),
        "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON",
    ]
    try:
        run_cmd(cmd, cwd=project_dir, check=True)
    except subprocess.CalledProcessError as e:
        raise RuntimeError(
            "CMake configure failed.\n"
            f"Command: {' '.join(cmd)}\n"
            f"stdout:\n{e.stdout}\n"
            f"stderr:\n{e.stderr}\n"
        )

    cc = build_dir / "compile_commands.json"
    if not cc.exists():
        # Some generators may place it differently; last-ditch search
        found = list(build_dir.rglob("compile_commands.json"))
        if found:
            cc = found[0]
        else:
            raise FileNotFoundError(f"compile_commands.json not found under: {build_dir}")

    # Optionally copy to project root (some tools expect it there)
    root_cc = project_dir / "compile_commands.json"
    try:
        shutil.copyfile(cc, root_cc)
        return root_cc
    except Exception:
        return cc

# ----------------------------
# Parsing helpers
# ----------------------------

def normalize_path(p: str) -> str:
    return p.replace("\\", "/")

def clean_raw_comment(raw: Optional[str]) -> str:
    if not raw:
        return ""
    s = raw.strip()

    # Remove common comment wrappers
    # /** ... */ , /*! ... */ , /// ... , //! ...
    if s.startswith("/*"):
        s = re.sub(r"^/\*+!?", "", s)
        s = re.sub(r"\*+/$", "", s)
        # strip leading '*' per line
        lines = []
        for line in s.splitlines():
            line = re.sub(r"^\s*\*+\s?", "", line)
            lines.append(line.rstrip())
        s = "\n".join(lines).strip()
    else:
        # line comments
        lines = []
        for line in s.splitlines():
            line = re.sub(r"^\s*///!?\s?", "", line)
            line = re.sub(r"^\s*//!?\s?", "", line)
            lines.append(line.rstrip())
        s = "\n".join(lines).strip()

    # Collapse extra blank lines
    s = re.sub(r"\n{3,}", "\n\n", s).strip()
    return s

def cursor_comment_text(cursor) -> str:
    # Prefer raw_comment if present
    raw = getattr(cursor, "raw_comment", None)
    txt = clean_raw_comment(raw)
    if txt:
        return txt
    # Some bindings support get_raw_comment_text / brief_comment
    brief = getattr(cursor, "brief_comment", None)
    if brief:
        b = brief.strip()
        if b:
            return b
    return ""

def get_cursor_file(cursor) -> Optional[str]:
    loc = cursor.location
    if not loc or not loc.file:
        return None
    return str(loc.file)

def is_public_method(cursor, clang) -> bool:
    if cursor.kind != clang.CursorKind.CXX_METHOD:
        return False
    try:
        if cursor.is_implicit():
            return False
    except AttributeError:
        # Fallback: skip compiler-generated methods by checking location
        if not cursor.location or not cursor.location.file:
            return False
    try:
        if cursor.access_specifier != clang.AccessSpecifier.PUBLIC:
            return False
    except Exception:
        return False
    return True

def build_display_method_name(cursor) -> str:
    # displayname usually includes params: foo(int) / foo()
    dn = getattr(cursor, "displayname", "") or ""
    if dn:
        return dn
    sp = getattr(cursor, "spelling", "") or ""
    return f"{sp}()"

# ----------------------------
# Main AST extraction
# ----------------------------

def _extra_clang_args() -> List[str]:
    """Detect -isysroot and clang builtin include paths for the current platform."""
    extra: List[str] = []
    if platform.system().lower() == "darwin":
        try:
            sdk = subprocess.check_output(["xcrun", "--show-sdk-path"], text=True).strip()
            if sdk:
                extra += ["-isysroot", sdk]
        except Exception:
            pass
        # Clang builtin headers (stdarg.h, etc.)
        for prefix in ("/opt/homebrew/opt/llvm/lib/clang", "/usr/local/opt/llvm/lib/clang"):
            p = Path(prefix)
            if p.is_dir():
                versions = sorted(p.iterdir(), reverse=True)
                for v in versions:
                    inc = v / "include"
                    if inc.is_dir():
                        extra += ["-isystem", str(inc)]
                        break
                break
    return extra


def load_compile_commands(cc_path: Path) -> List[dict]:
    with cc_path.open("r", encoding="utf-8") as f:
        return json.load(f)

def make_args(entry: dict) -> Tuple[str, List[str], str]:
    """
    Returns: (file, args, directory)
    """
    file_ = entry.get("file")
    directory = entry.get("directory", "")
    if "arguments" in entry and isinstance(entry["arguments"], list):
        args = entry["arguments"][1:]  # drop compiler executable
    else:
        # split command string
        cmd = entry.get("command", "")
        # naive split; better than nothing (compile_commands usually has arguments nowadays)
        args = cmd.split()[1:]
    return file_, args, directory

def parse_translation_units(clang, cc_entries: List[dict], project_dir: Path) -> Tuple[
    Dict[str, dict],  # class_name -> info
    Dict[str, Set[str]],  # base_name -> set(derived_names)
    Set[str],  # all class names
]:
    index = clang.Index.create()
    extra_args = _extra_clang_args()
    project_root = normalize_path(str(project_dir)) + "/"

    classes: Dict[str, dict] = {}
    derived_map: Dict[str, Set[str]] = {}
    all_names: Set[str] = set()

    parsed_files: Set[str] = set()
    total = len(cc_entries)

    for idx, entry in enumerate(cc_entries):
        file_, args, directory = make_args(entry)
        if not file_:
            continue

        # Avoid parsing same file many times
        key = normalize_path(os.path.abspath(os.path.join(directory, file_)) if directory else os.path.abspath(file_))
        if key in parsed_files:
            continue
        parsed_files.add(key)

        # libclang is picky: ensure working dir matches compile database directory
        workdir = directory if directory else None

        # Filter args that commonly break parsing
        filtered_args = []
        skip_next = False
        for a in args:
            if skip_next:
                skip_next = False
                continue
            # Drop flags that take a next argument and break libclang
            if a in ("-o", "-c", "-arch"):
                skip_next = True
                continue
            if a.startswith("-o"):
                continue
            filtered_args.append(a)

        filtered_args = extra_args + filtered_args

        try:
            tu = index.parse(
                path=file_,
                args=filtered_args,
                options=clang.TranslationUnit.PARSE_DETAILED_PROCESSING_RECORD,
                unsaved_files=None,
            )
        except Exception:
            # try absolute path
            try:
                tu = index.parse(
                    path=key,
                    args=filtered_args,
                    options=clang.TranslationUnit.PARSE_DETAILED_PROCESSING_RECORD,
                    unsaved_files=None,
                )
            except Exception:
                continue

        print(f"\r  [{idx+1}/{total}] {os.path.basename(file_)}", end="", flush=True)

        # Determine project root to skip system/external headers during traversal
        project_prefix = normalize_path(os.path.dirname(key)).rsplit("/external/", 1)[0]

        def visit(cursor):
            # Skip cursors from files outside the project
            loc = cursor.location
            if loc and loc.file:
                fpath = normalize_path(str(loc.file))
                if not fpath.startswith(project_prefix):
                    return

            # Collect class/struct definitions
            if cursor.kind in (clang.CursorKind.CLASS_DECL, clang.CursorKind.STRUCT_DECL):
                try:
                    if not cursor.is_definition():
                        return
                except Exception:
                    return

                name = cursor.spelling
                if not name:
                    return

                all_names.add(name)

                # Bases
                bases: List[str] = []
                for c in cursor.get_children():
                    if c.kind == clang.CursorKind.CXX_BASE_SPECIFIER:
                        # c.type.spelling might include namespaces; keep spelling-like last component too
                        bt = c.type.spelling or ""
                        bt = bt.strip()
                        if bt:
                            # prefer the unqualified name for linking if possible
                            unqual = bt.split("::")[-1]
                            bases.append(unqual)

                # Header path
                fpath = get_cursor_file(cursor)
                header = normalize_path(fpath) if fpath else ""
                if header.startswith(project_root):
                    header = header[len(project_root):]

                # Description
                desc = cursor_comment_text(cursor)

                # Public methods
                methods = []
                for c in cursor.get_children():
                    if is_public_method(c, clang):
                        mname = build_display_method_name(c)
                        mdesc = cursor_comment_text(c)
                        if mdesc:
                            methods.append({"name": mname, "description": mdesc})
                        else:
                            methods.append({"name": mname, "description": ""})

                # Merge if seen before (keep best description/methods)
                prev = classes.get(name)
                if prev:
                    if (not prev.get("description")) and desc:
                        prev["description"] = desc
                    if (not prev.get("header")) and header:
                        prev["header"] = header

                    # Merge bases
                    prev_bases = set(prev.get("bases", []))
                    prev_bases.update(bases)
                    prev["bases"] = sorted(prev_bases)

                    # Merge methods by name
                    existing = {m["name"]: m for m in prev.get("methods", [])}
                    for m in methods:
                        if m["name"] not in existing or (not existing[m["name"]].get("description") and m.get("description")):
                            existing[m["name"]] = m
                    prev["methods"] = sorted(existing.values(), key=lambda x: x["name"])
                else:
                    classes[name] = {
                        "name": name,
                        "description": desc,
                        "header": header,
                        "bases": sorted(set(bases)),
                        "methods": sorted(methods, key=lambda x: x["name"]),
                    }

                # Build derived map (base -> derived)
                for b in bases:
                    derived_map.setdefault(b, set()).add(name)

            # Recurse
            for ch in cursor.get_children():
                visit(ch)

        visit(tu.cursor)

    print(f"\nParsed {len(parsed_files)} files, found {len(classes)} classes.")
    return classes, derived_map, all_names

def build_tree(classes: Dict[str, dict], derived_map: Dict[str, Set[str]], root_name: str) -> dict:
    """
    Create recursive JSON object for root_name and its descendants.
    """
    visited: Set[str] = set()

    def node(name: str) -> dict:
        if name in visited:
            # prevent cycles
            info = classes.get(name, {"name": name, "description": "", "header": "", "methods": []})
            return {
                "name": info.get("name", name),
                "description": info.get("description", ""),
                "header": info.get("header", ""),
                "methods": info.get("methods", []),
                "children": [],
            }

        visited.add(name)
        info = classes.get(name, {"name": name, "description": "", "header": "", "methods": []})

        children_names = sorted(derived_map.get(name, set()))
        children = [node(ch) for ch in children_names]

        return {
            "name": info.get("name", name),
            "description": info.get("description", ""),
            "header": info.get("header", ""),
            "methods": info.get("methods", []),
            "children": children,
        }

    return node(root_name)

# ----------------------------
# Entrypoint
# ----------------------------

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("project_dir", help="Path to CMake project directory")
    ap.add_argument("out_json", help="Path to output JSON file")
    args = ap.parse_args()

    project_dir = Path(args.project_dir).resolve()
    out_json = Path(args.out_json).resolve()

    # 1) generate compile_commands.json (via cmake)
    cc_path = generate_compile_commands(project_dir)

    # load libclang
    clang = load_clang()

    # 2) parse and build dependency tree from Ref
    cc_entries = load_compile_commands(cc_path)
    classes, derived_map, _all = parse_translation_units(clang, cc_entries, project_dir)

    # If Ref isn't found, still emit a minimal root
    root = build_tree(classes, derived_map, "Object")

    # 3) write output
    out_json.parent.mkdir(parents=True, exist_ok=True)
    with out_json.open("w", encoding="utf-8") as f:
        json.dump(root, f, ensure_ascii=False, indent=2)

    print(f"OK: wrote {out_json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
