#!/bin/bash
# Готовит облачную сессию Claude Code к работе с Rust-проектом.
set -euo pipefail

# Локально окружение настраивает человек — хук ничего не делает.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# stdout хука SessionStart попадает в контекст агента, поэтому вывод установок — в stderr.
exec 1>&2

project_dir="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$project_dir"

rustup component add rustfmt clippy

# Cargo.toml появится вместе с каркасом проекта; до этого скачивать нечего.
if [ -f Cargo.toml ]; then
  cargo fetch
fi
