#!/bin/bash
# Migrate ~/portal-data entity files to event-sourced schema.
#
# Changes:
#   1. settings.json: add "timestamp": 0
#   2. atoms/{slug}.json: rename "watermark" → "timestamp"
#   3. lists/user/{id}.json: wrap bare array → { "timestamp": 0, "pins": [...] }
#   4. lists/permanent-deletes.json: wrap bare array → { "timestamp": 0, "urls": [...] }
#
# Prerequisites:
#   - Ensure the extension's write buffer is empty (no pending writes)
#   - jq must be installed
#
# Usage: ./scripts/migrate-entity-schema.sh [portal-data-dir]

set -euo pipefail

DIR="${1:-$HOME/portal-data}"

if [ ! -d "$DIR" ]; then
  echo "Error: Directory '$DIR' does not exist" >&2
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo "Error: jq is required. Install with 'brew install jq'" >&2
  exit 1
fi

echo "Migrating entity schema in: $DIR"

# 1. settings.json — add timestamp: 0 if missing
SETTINGS="$DIR/settings.json"
if [ -f "$SETTINGS" ]; then
  if jq -e '.timestamp' "$SETTINGS" &>/dev/null; then
    echo "  settings.json: already has timestamp, skipping"
  else
    jq '. + {"timestamp": 0}' "$SETTINGS" > "$SETTINGS.tmp" && mv "$SETTINGS.tmp" "$SETTINGS"
    echo "  settings.json: added timestamp: 0"
  fi
else
  echo "  settings.json: not found, skipping"
fi

# 2. atoms/{slug}.json — rename "watermark" → "timestamp"
ATOMS_DIR="$DIR/atoms"
if [ -d "$ATOMS_DIR" ]; then
  atom_count=0
  for f in "$ATOMS_DIR"/*.json; do
    [ -f "$f" ] || continue
    if jq -e '.watermark' "$f" &>/dev/null; then
      jq '.timestamp = .watermark | del(.watermark)' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
      atom_count=$((atom_count + 1))
    elif ! jq -e '.timestamp' "$f" &>/dev/null; then
      jq '. + {"timestamp": 0}' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
      atom_count=$((atom_count + 1))
    fi
  done
  echo "  atoms/*.json: migrated $atom_count files"
else
  echo "  atoms/: directory not found, skipping"
fi

# 3. lists/user/{id}.json — wrap bare array → { "timestamp": 0, "pins": [...] }
USER_DIR="$DIR/lists/user"
if [ -d "$USER_DIR" ]; then
  pin_count=0
  for f in "$USER_DIR"/*.json; do
    [ -f "$f" ] || continue
    # Check if top-level is an array (bare format)
    if jq -e 'type == "array"' "$f" &>/dev/null; then
      jq '{"timestamp": 0, "pins": .}' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
      pin_count=$((pin_count + 1))
    elif ! jq -e '.timestamp' "$f" &>/dev/null; then
      # Object but no timestamp
      jq '. + {"timestamp": 0}' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
      pin_count=$((pin_count + 1))
    fi
  done
  echo "  lists/user/*.json: migrated $pin_count files"
else
  echo "  lists/user/: directory not found, skipping"
fi

# 4. lists/permanent-deletes.json — wrap bare array → { "timestamp": 0, "urls": [...] }
PD="$DIR/lists/permanent-deletes.json"
if [ -f "$PD" ]; then
  if jq -e 'type == "array"' "$PD" &>/dev/null; then
    jq '{"timestamp": 0, "urls": .}' "$PD" > "$PD.tmp" && mv "$PD.tmp" "$PD"
    echo "  lists/permanent-deletes.json: wrapped array"
  elif ! jq -e '.timestamp' "$PD" &>/dev/null; then
    jq '. + {"timestamp": 0}' "$PD" > "$PD.tmp" && mv "$PD.tmp" "$PD"
    echo "  lists/permanent-deletes.json: added timestamp"
  else
    echo "  lists/permanent-deletes.json: already migrated, skipping"
  fi
else
  echo "  lists/permanent-deletes.json: not found, skipping"
fi

echo "Migration complete."
