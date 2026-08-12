#!/usr/bin/env bash
set -euo pipefail

# Update script for a standalone nexus-addon folder.
# - Works even when this folder is NOT a git repository.
# - Creates a timestamped backup before replacing files.
# - Replaces content from GitHub without interactive prompts.

REPO_URL="${NEXUS_REPO_URL:-https://github.com/DopeEx/NexusAccounting.git}"
BRANCH="${NEXUS_REPO_BRANCH:-master}"
SUBDIR="nexus-addon"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_NAME="$(basename -- "$0")"
WORKDIR="$(mktemp -d)"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_ROOT="$SCRIPT_DIR/.update-backup"
BACKUP_FILE="$BACKUP_ROOT/nexus-addon-$TIMESTAMP.tar.gz"

cleanup() {
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

echo "[1/5] Erstelle Backup in $BACKUP_FILE"
mkdir -p "$BACKUP_ROOT"
tar --exclude='.update-backup' -czf "$BACKUP_FILE" -C "$SCRIPT_DIR" .

echo "[2/5] Klone $REPO_URL (Branch: $BRANCH)"
git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$WORKDIR/repo"

SOURCE_DIR="$WORKDIR/repo/$SUBDIR"
if [[ ! -d "$SOURCE_DIR" ]]; then
  echo "Fehler: Ordner '$SUBDIR' wurde im Repo nicht gefunden."
  echo "Backup bleibt erhalten: $BACKUP_FILE"
  exit 1
fi

echo "[3/5] Entferne alte Dateien (Backup bleibt erhalten)"
find "$SCRIPT_DIR" -mindepth 1 -maxdepth 1 \
  ! -name '.update-backup' \
  ! -name "$SCRIPT_NAME" \
  -exec rm -rf {} +

echo "[4/5] Kopiere neue Dateien"
cp -a "$SOURCE_DIR"/. "$SCRIPT_DIR"/

echo "[5/5] Update abgeschlossen"
echo "Quelle: $REPO_URL@$BRANCH/$SUBDIR"
echo "Backup: $BACKUP_FILE"
echo "Hinweis: Lokale Änderungen wurden durch Repo-Dateien ersetzt."
