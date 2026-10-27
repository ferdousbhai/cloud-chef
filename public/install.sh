#!/usr/bin/env bash
# Installs the cloudchef command: curl -fsSL https://cloudchef.build/install.sh | bash
set -euo pipefail

main() {
  local host="${CLOUDCHEF_HOST:-https://cloudchef.build}"
  host="${host%/}"
  local dir="${CLOUDCHEF_INSTALL_DIR:-$HOME/.local/bin}"
  local target="$dir/cloudchef"
  local tmp version

  command -v curl >/dev/null 2>&1 || { echo "cloudchef needs curl." >&2; exit 1; }
  command -v git >/dev/null 2>&1 || echo "Note: cloudchef needs git too; install it before cloning projects." >&2

  mkdir -p "$dir"
  tmp="$(mktemp "$dir/.cloudchef.XXXXXX")"
  trap 'rm -f "$tmp"' EXIT
  echo "Downloading $host/cli/cloudchef"
  curl -fsSL "$host/cli/cloudchef" -o "$tmp"
  chmod +x "$tmp"
  if ! version="$("$tmp" --version 2>&1)"; then
    echo "The downloaded cloudchef doesn't run: $version" >&2
    exit 1
  fi
  mv -f "$tmp" "$target"
  trap - EXIT
  echo "Installed $version to $target"

  echo "Installing the cloudchef skill for coding agents."
  CLOUDCHEF_HOST="$host" "$target" skill install

  case ":$PATH:" in
    *":$dir:"*) ;;
    *)
      echo
      echo "$dir isn't on your PATH. Add it to your shell profile (~/.zshrc or ~/.bashrc):"
      echo "  export PATH=\"$dir:\$PATH\""
      ;;
  esac

  echo
  echo "Next: cloudchef auth login"
}

main "$@"
