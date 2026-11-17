"""
Reframe Studio -> generate_project_docs.py
--------------------------------------------
Isko "reframe_studio" folder ke andar rakh kar run karo:

    python generate_project_docs.py

Ye EK hi script poora project folder khud scan karti hai (kisi fixed
file-list par depend nahi karti — jo bhi source-code file mil jaye,
wo shamil ho jayegi) aur DO files banati hai, usi folder mein:

  1) PROJECT_FILES_LIST.md  -> poore folder ki saari files ki list
  2) PROJECT_CODE.md        -> saari code-files ka asli code, template
                                format mein (### Name: <path> + fenced code)
"""

import os

PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
FILES_LIST_OUTPUT = os.path.join(PROJECT_ROOT, "PROJECT_FILES_LIST.md")
CODE_OUTPUT = os.path.join(PROJECT_ROOT, "PROJECT_CODE.md")

# Ye folders (aur inke andar sab kuch) skip honge — runtime-generated ya
# irrelevant hain, source-code nahi.
SKIP_DIRS = {
    "cache", "uploads", "data",
    "__pycache__", ".git", "node_modules",
    ".venv", "venv", "dist", "build",
}

# Extension -> code-fence language. Isi list mein jo extension ho, uska
# poora code PROJECT_CODE.md mein shamil hoga.
CODE_EXT_LANG = {
    ".py": "python",
    ".js": "js",
    ".jsx": "jsx",
    ".ts": "ts",
    ".html": "html",
    ".css": "css",
    ".bat": "bat",
    ".json": "json",
}

# Ye files kabhi bhi CODE_OUTPUT mein shamil nahi hongi (khud ye script,
# purani helper-scripts, aur is script ke apne outputs) — infinite/junk
# self-reference se bachne ke liye. File-list mein phir bhi dikhengi.
EXCLUDE_FROM_CODE = {
    "generate_project_docs.py",
    "generate_project_code.py",
    "list_project_files.py",
    "PROJECT_CODE.md",
    "PROJECT_FILES_LIST.md",
}

MAX_SIZE_BYTES = 2 * 1024 * 1024  # 2MB se badi file ko code mein embed nahi karenge


def read_text(path):
    for enc in ("utf-8", "utf-8-sig", "latin-1"):
        try:
            with open(path, "r", encoding=enc) as f:
                return f.read()
        except UnicodeDecodeError:
            continue
    with open(path, "rb") as f:
        return f.read().decode("utf-8", errors="replace")


def scan():
    all_files = []
    code_files = []  # list of (rel_path_forward_slash, full_path, lang)

    for root, dirs, files in os.walk(PROJECT_ROOT):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")]

        for fname in sorted(files):
            full = os.path.join(root, fname)
            rel = os.path.relpath(full, PROJECT_ROOT)
            rel_fwd = rel.replace(os.sep, "/")
            all_files.append(rel_fwd)

            ext = os.path.splitext(fname)[1].lower()
            if fname in EXCLUDE_FROM_CODE:
                continue
            if ext in CODE_EXT_LANG:
                code_files.append((rel_fwd, full, CODE_EXT_LANG[ext]))

    all_files.sort()
    code_files.sort(key=lambda t: t[0])
    return all_files, code_files


def write_files_list(all_files, code_paths):
    lines = ["# Project Files List", f"\nProject root: `{PROJECT_ROOT}`\n",
              f"## Sab Files ({len(all_files)})\n"]
    for f in all_files:
        marker = "  <- source code" if f in code_paths else ""
        lines.append(f"- {f}{marker}")

    lines.append(f"\n## Sirf Code Files ({len(code_paths)}) -- ye PROJECT_CODE.md mein hain\n")
    for f in code_paths:
        lines.append(f"- {f}")

    content = "\n".join(lines)
    with open(FILES_LIST_OUTPUT, "w", encoding="utf-8") as f:
        f.write(content)
    return content


def write_project_code(code_files):
    blocks = []
    skipped_large = []

    for rel_fwd, full_path, lang in code_files:
        blocks.append(f"### Name: {rel_fwd}")
        size = os.path.getsize(full_path)
        if size > MAX_SIZE_BYTES:
            blocks.append(f"```{lang}")
            blocks.append(f"(file too large to embed: {size} bytes -- skipped)")
            blocks.append("```")
            skipped_large.append(rel_fwd)
        else:
            content = read_text(full_path).rstrip("\n")
            blocks.append(f"```{lang}")
            blocks.append(content)
            blocks.append("```")
        blocks.append("")

    content = "\n".join(blocks)
    with open(CODE_OUTPUT, "w", encoding="utf-8") as f:
        f.write(content)
    return content, skipped_large


def main():
    all_files, code_files = scan()
    code_paths = [c[0] for c in code_files]

    write_files_list(all_files, code_paths)
    _, skipped_large = write_project_code(code_files)

    print(f"Project root: {PROJECT_ROOT}\n")
    print(f"Total files found: {len(all_files)}")
    print(f"Code files embedded in PROJECT_CODE.md: {len(code_files)}")
    for f in code_paths:
        print(f"  - {f}")

    if skipped_large:
        print("\nYe files bohot badi thin, skip ki gayin (sirf placeholder likha):")
        for f in skipped_large:
            print(f"  - {f}")

    print(f"\n==> Likh di gayin:\n  {FILES_LIST_OUTPUT}\n  {CODE_OUTPUT}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"\nERROR: {e}")
    input("\n\nDone. Press Enter to close...")
