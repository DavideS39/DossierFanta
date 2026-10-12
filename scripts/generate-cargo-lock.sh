#!/usr/bin/env bash
# ============================================================
# M2.2 — FIX A3 (H9): generate-cargo-lock.sh
# ============================================================
# Genera src-tauri/Cargo.lock per DossierFanta.
#
# L'ambiente di generazione M2.2 NON ha toolchain Rust installata,
# quindi non può produrre il file. L'utente deve eseguire questo
# script sul suo dev machine Windows (o qualsiasi box con cargo
# installato) per generare il Cargo.lock la PRIMA volta.
#
# Una volta generato e committato, il file resta nel repo e la
# GitHub Action build-msi.yml usa `--locked` per garantire build
# riproducibile: se Cargo.lock manca o è out-of-sync, il CI fallisce
# esplicitamente invece di rigenerare il lockfile in modo non-deterministico.
#
# Uso:
#   bash scripts/generate-cargo-lock.sh        # da root del repo
#   bash scripts/generate-cargo-lock.sh --check # verifica solo (no write)
#
# Output:
#   src-tauri/Cargo.lock  (~30-50 KB, tutte le versioni delle deps
#   transitive di tauri + rusqlite + chrono + uuid + serde + ...)
#
# Commit:
#   git add src-tauri/Cargo.lock
#   git commit -m "M2.2 — FIX A3 (H9): commit Cargo.lock per build riproducibile"
#   git push
# ============================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CARGO_TOML="${REPO_ROOT}/src-tauri/Cargo.toml"
LOCKFILE="${REPO_ROOT}/src-tauri/Cargo.lock"

# Verifica prerequisiti
if ! command -v cargo >/dev/null 2>&1; then
  echo "ERROR: cargo non trovato nel PATH." >&2
  echo "Installa Rust da https://rustup.rs/ e riprova." >&2
  exit 1
fi

if [ ! -f "${CARGO_TOML}" ]; then
  echo "ERROR: src-tauri/Cargo.toml non trovato a ${CARGO_TOML}" >&2
  exit 1
fi

# Verifica .gitignore NON esclude Cargo.lock
GITIGNORE="${REPO_ROOT}/.gitignore"
if grep -qE '^\s*src-tauri/Cargo\.lock\s*$' "${GITIGNORE}" 2>/dev/null; then
  echo "ERROR: .gitignore esclude src-tauri/Cargo.lock. Rimuovi la riga e riprova." >&2
  echo "  Cargo.lock VA committato per le app binarie (Tauri = binario, non libreria)." >&2
  exit 1
fi

if [ "${1:-}" = "--check" ]; then
  if [ ! -f "${LOCKFILE}" ]; then
    echo "FAIL: Cargo.lock assente. Esegui senza --check per generarlo."
    exit 2
  fi
  echo "OK: Cargo.lock presente ($(wc -c < "${LOCKFILE}") byte)"
  cd "${REPO_ROOT}/src-tauri" && cargo verify-lock --manifest-path Cargo.toml 2>/dev/null \
    && echo "OK: Cargo.lock sincronizzato con Cargo.toml" \
    || { echo "WARN: Cargo.lock out-of-sync con Cargo.toml — rigenera"; exit 3; }
  exit 0
fi

# Genera il lockfile
echo "Generating src-tauri/Cargo.lock..."
cd "${REPO_ROOT}/src-tauri"
cargo generate-lockfile

if [ ! -f "${LOCKFILE}" ]; then
  echo "ERROR: generate-lockfile non ha prodotto Cargo.lock." >&2
  exit 1
fi

SIZE=$(wc -c < "${LOCKFILE}")
echo "OK: Cargo.lock generato (${SIZE} byte)"
echo ""
echo "Prossimi passi:"
echo "  1. git add src-tauri/Cargo.lock"
echo "  2. git commit -m \"M2.2 — FIX A3 (H9): commit Cargo.lock per build riproducibile\""
echo "  3. git push"
echo "  4. Verifica che la GitHub Action build-msi.yml vada verde con --locked"
