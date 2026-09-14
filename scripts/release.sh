#!/usr/bin/env bash
# Helper script: prepara un nuovo release commit + tag.
#
# Uso:
#   ./scripts/release.sh 0.1.0       # crea tag v0.1.0
#   ./scripts/release.sh 0.2.0-m1    # prerelease
#
# Lo script:
#   1. Verifica che working tree sia pulito
#   2. Aggiorna versione in package.json e src-tauri/Cargo.toml e src-tauri/tauri.conf.json
#   3. Crea commit "release: vX.Y.Z"
#   4. Crea tag annotato vX.Y.Z
#   5. Mostra i comandi da eseguire per pushare (non pusha in automatico)

set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Uso: $0 <versione-senza-v> (es. 0.1.0)"
  exit 1
fi

VERSION="$1"
TAG="v${VERSION}"

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9]+)?$ ]]; then
  echo "Errore: versione non semver-compatibile: $VERSION"
  echo "Esempi validi: 0.1.0, 0.2.0-m1, 1.0.0-rc1"
  exit 1
fi

# Verifica working tree pulito
if [ -n "$(git status --porcelain)" ]; then
  echo "Errore: working tree non pulito. Commit o stash prima del release."
  git status --short
  exit 1
fi

echo "==> Preparo release $TAG"

# Aggiorna package.json
sed -i.bak -E "s/\"version\": \"[^\"]+\"/\"version\": \"$VERSION\"/" package.json
rm -f package.json.bak
echo "  ✓ package.json: $VERSION"

# Aggiorna src-tauri/Cargo.toml
sed -i.bak -E "s/^version = \"[^\"]+\"/version = \"$VERSION\"/" src-tauri/Cargo.toml
rm -f src-tauri/Cargo.toml.bak
echo "  ✓ src-tauri/Cargo.toml: $VERSION"

# Aggiorna src-tauri/tauri.conf.json
sed -i.bak -E "s/\"version\": \"[^\"]+\"/\"version\": \"$VERSION\"/" src-tauri/tauri.conf.json
rm -f src-tauri/tauri.conf.json.bak
echo "  ✓ src-tauri/tauri.conf.json: $VERSION"

# Update Cargo.lock per riflettere nuova versione
(cd src-tauri && cargo update -p dossierfanta --precise "$VERSION" 2>/dev/null) || true
echo "  ✓ src-tauri/Cargo.lock: $VERSION"

# Commit + tag
git add package.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json
git commit -m "release: $TAG

Aggiornamento versione a $VERSION.
Vedi CHANGELOG.md per i dettagli."

git tag -a "$TAG" -m "DossierFanta $TAG"

echo ""
echo "==> Fatto. Commit + tag $TAG creati localmente."
echo ""
echo "Per pushare e triggerare il build GitHub Actions:"
echo "  git push origin main"
echo "  git push origin $TAG"
echo ""
echo "Il workflow 'Release' si avvia automaticamente e creerà una GitHub Release"
echo "con bundle .msi + .exe + .deb + .AppImage + .dmg allegati."
