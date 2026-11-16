# shellcheck shell=bash
#
# What deploy/install.sh ends a successful run with: the Cloudgate mark with
# what to do next beside it, and the logotype under it. Sourced by install.sh;
# defines functions and runs nothing. backend/test/deploy/finish-banner.spec.ts
# drives them directly, which is why they live in a file of their own.

# The brand colour's escape, or empty for none. Set by finish_banner_colour.
FINISH_BANNER_COLOUR=

# Decides whether the art is drawn in the brand colour. install.sh calls it
# before it copies its output into the install log: after that, stdout is a
# pipe into tee and never a terminal. NO_COLOR (no-color.org), a TERM of dumb
# and output that is not a terminal all mean no colour.
finish_banner_colour() {
  FINISH_BANNER_COLOUR=
  [ -t 1 ] || return 0
  [ -z "${NO_COLOR:-}" ] || return 0
  [ "${TERM:-dumb}" != dumb ] || return 0
  case "${COLORTERM:-}" in
    # The console's --brand, #6d57e0.
    truecolor | 24bit) FINISH_BANNER_COLOUR=$'\033[38;2;109;87;224m' ;;
    # The nearest of the 256: #5f5fd7.
    *) FINISH_BANNER_COLOUR=$'\033[38;5;62m' ;;
  esac
}

# Prints the art. Each argument is a line set beside the mark, top down; the
# mark has five rows, so five lines at most, and an empty argument is a blank
# row. The mark is the console's glyph (frontend/public/cloudgate-mark.svg)
# in half blocks; the logotype is figlet's Standard font, lowercase as the
# console sets it.
finish_banner() {
  local mark=(
    '      ▄████▄    '
    '  ▄▄█ ███████▄  '
    ' ▄███▄█▀██ ████ '
    '██████████▄█████'
    '▀██████████████▀'
  )
  local word=(
    '      _                 _             _'
    '  ___| | ___  _   _  __| | __ _  __ _| |_ ___'
    ' / __| |/ _ \| | | |/ _` |/ _` |/ _` | __/ _ \'
    '| (__| | (_) | |_| | (_| | (_| | (_| | ||  __/'
    ' \___|_|\___/ \__,_|\__,_|\__, |\__,_|\__\___|'
    '                          |___/'
  )
  local on="$FINISH_BANNER_COLOUR" off='' i row text
  [ -z "$on" ] || off=$'\033[0m'
  echo
  for i in "${!mark[@]}"; do
    row="${mark[$i]}"
    text="${*:i+1:1}"
    if [ -n "$text" ]; then
      printf '%s%s%s    %s\n' "$on" "$row" "$off" "$text"
    else
      printf '%s%s%s\n' "$on" "${row%"${row##*[! ]}"}" "$off"
    fi
  done
  echo
  for row in "${word[@]}"; do
    printf '%s%s%s\n' "$on" "$row" "$off"
  done
}
