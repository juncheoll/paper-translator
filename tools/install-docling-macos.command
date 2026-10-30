#!/bin/sh
mtt_tools=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
/bin/sh "$mtt_tools/install-docling-linux.sh" "$@"
mtt_result=$?
if [ "${PAPER_DOCLING_NO_PAUSE:-0}" != 1 ] && [ -t 0 ]; then
  printf '\nPress Enter to close this installer.\n'
  read -r mtt_answer
fi
exit "$mtt_result"
