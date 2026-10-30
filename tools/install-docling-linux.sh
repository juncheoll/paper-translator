#!/bin/sh
# Shared macOS/Linux bootstrap. Pinned uv assets and SHA-256 come from the
# official https://github.com/astral-sh/uv/releases/tag/0.13.6 release.
set -eu
mtt_tools=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mtt_system=$(uname -s)
mtt_arch=$(uname -m)
case "$mtt_system:$mtt_arch" in
  Darwin:arm64)
    mtt_macos_major=$(sw_vers -productVersion | cut -d. -f1)
    if [ "$mtt_macos_major" -lt 14 ]; then
      echo 'This beta requires macOS 14 or newer on Apple Silicon.' >&2; exit 1
    fi
    mtt_home=${PAPER_DOCLING_HOME:-"$HOME/Library/Application Support/PaperTranslator/Docling"}
    mtt_asset=uv-aarch64-apple-darwin.tar.gz
    mtt_sha=60fbd5c8a1ed681845eea28d9d622fcde03c51e91a43465b64a1e17db1ed3472
    ;;
  Linux:x86_64)
    mtt_home=${PAPER_DOCLING_HOME:-"${XDG_DATA_HOME:-$HOME/.local/share}/paper-translator/docling"}
    mtt_asset=uv-x86_64-unknown-linux-gnu.tar.gz
    mtt_sha=f29c3e94ffabd7e6f3ba521dba169a9b7ec12100bf3257087f0f24f6123f3645
    ;;
  *) echo 'This beta bootstrap supports macOS 14+ Apple Silicon and Linux x86_64. Other architectures are not verified.' >&2; exit 1 ;;
esac
mtt_temp=$(mktemp -d "${TMPDIR:-/tmp}/mtt-docling-setup.XXXXXX")
trap 'rm -rf "$mtt_temp"' EXIT HUP INT TERM
printf '%s\n' 'Preparing a private Python runtime and Docling environment. Initial setup may take several minutes.'
curl --fail --location --retry 2 --proto '=https' --proto-redir '=https' --tlsv1.2 \
  "https://github.com/astral-sh/uv/releases/download/0.13.6/$mtt_asset" -o "$mtt_temp/uv.tar.gz"
if command -v sha256sum >/dev/null 2>&1; then
  mtt_actual=$(sha256sum "$mtt_temp/uv.tar.gz" | cut -d' ' -f1)
else
  mtt_actual=$(shasum -a 256 "$mtt_temp/uv.tar.gz" | cut -d' ' -f1)
fi
if [ "$mtt_actual" != "$mtt_sha" ]; then echo 'uv checksum verification failed. Nothing was executed.' >&2; exit 1; fi
mkdir -p "$mtt_temp/unpacked" "$mtt_home/bootstrap"
tar -xzf "$mtt_temp/uv.tar.gz" -C "$mtt_temp/unpacked" --strip-components=1
cp "$mtt_temp/unpacked/uv" "$mtt_home/bootstrap/uv"
chmod 700 "$mtt_home/bootstrap/uv"
export UV_PYTHON_INSTALL_DIR="$mtt_home/python"
export UV_PYTHON_BIN_DIR="$mtt_home/bootstrap/bin"
export UV_CACHE_DIR="$mtt_home/uv-cache"
export UV_NO_MODIFY_PATH=1
export PYTHONUTF8=1
"$mtt_home/bootstrap/uv" python install --no-config --no-bin 3.12.14
mtt_python=$("$mtt_home/bootstrap/uv" python find --no-config --managed-python 3.12.14)
"$mtt_python" "$mtt_tools/install_docling_helper.py" --home "$mtt_home" "$@"
