#!/usr/bin/env python3
"""
One-time cleanup of portal-data history JSONL files.

1. Remove consecutive exact duplicates (identical JSON lines in a row).
2. Remove same-(timestamp, url) page duplicates.
3. Collapse idempotent entries (list_meta, set) that differ only by timestamp —
   keep only the last occurrence per content key.

Usage: python3 scripts/cleanup-logs.py [--dry-run]
"""
import json
import sys
from pathlib import Path

HISTORY_DIR = Path.home() / "portal-data" / "history"


def content_key(entry):
    """Return a hashable key for the semantic content of an idempotent entry,
    ignoring timestamp. Returns None for non-idempotent actions."""
    action = entry.get("action")
    if action == "list_meta":
        # Same (id, name, qbTrees) = duplicate
        return ("list_meta", entry.get("id"), entry.get("name"),
                json.dumps(entry.get("qbTrees"), sort_keys=True))
    if action == "set":
        # Same (key, value) = duplicate
        return ("set", entry.get("key"),
                json.dumps(entry.get("value"), sort_keys=True))
    return None


def clean_file(filepath, dry_run=False):
    with open(filepath, "r", encoding="utf-8") as f:
        lines = f.readlines()

    original_count = len(lines)
    if original_count == 0:
        return 0, 0

    # Pass 1: remove consecutive exact duplicates
    deduped = [lines[0]]
    for i in range(1, len(lines)):
        if lines[i] != lines[i - 1]:
            deduped.append(lines[i])

    # Pass 2: remove same-(timestamp, url) page duplicates
    seen_page_keys = set()
    after_page_dedup = []
    for line in deduped:
        stripped = line.strip()
        if not stripped:
            continue
        try:
            entry = json.loads(stripped)
        except json.JSONDecodeError:
            after_page_dedup.append(line)
            continue

        if entry.get("action") == "page":
            key = (entry.get("timestamp"), entry.get("url"))
            if key in seen_page_keys:
                continue
            seen_page_keys.add(key)

        after_page_dedup.append(line)

    # Pass 3: collapse idempotent entries (list_meta, set).
    # Two-pass: first find the last index of each content key,
    # then keep only that occurrence (preserves order).
    parsed = []
    for line in after_page_dedup:
        stripped = line.strip()
        try:
            entry = json.loads(stripped)
        except json.JSONDecodeError:
            entry = None
        parsed.append((line, entry))

    last_index = {}
    for i, (line, entry) in enumerate(parsed):
        if entry is None:
            continue
        ck = content_key(entry)
        if ck is not None:
            last_index[ck] = i

    final = []
    for i, (line, entry) in enumerate(parsed):
        if entry is not None:
            ck = content_key(entry)
            if ck is not None and last_index[ck] != i:
                continue
        final.append(line)

    removed = original_count - len(final)
    if removed > 0 and not dry_run:
        with open(filepath, "w", encoding="utf-8") as f:
            f.writelines(final)

    return original_count, removed


def main():
    dry_run = "--dry-run" in sys.argv

    if not HISTORY_DIR.exists():
        print(f"History directory not found: {HISTORY_DIR}")
        sys.exit(1)

    files = sorted(HISTORY_DIR.glob("*.jsonl"))
    if not files:
        print("No JSONL files found.")
        return

    total_before = 0
    total_removed = 0

    for filepath in files:
        before, removed = clean_file(filepath, dry_run)
        total_before += before
        if removed > 0:
            print(f"  {filepath.name}: {before} → {before - removed} (removed {removed})")
        total_removed += removed

    mode = " (dry run)" if dry_run else ""
    print(f"\nTotal{mode}: {total_before} → {total_before - total_removed} entries ({total_removed} removed)")


if __name__ == "__main__":
    main()
