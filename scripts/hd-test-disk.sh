#!/usr/bin/env bash
# Bench prep for HD (spec 2026-09-26-hd-floppies §7 "Test disk"): a bootable
# 1.76 MB FFS HD ADF with everything on a DD Workbench disk, plus one known
# file. The DD ADF is an ARGUMENT -- no disk image is committed or fetched
# here -- and the output goes outside the repository.
#
#   scripts/hd-test-disk.sh <workbench-dd.adf> <out-dir>
#
# amitools 0.4's xdftool makes only DD .adf images, so the HD image is made as
# a raw .hdf of 80 cylinders x 2 heads x 22 sectors -- byte for byte an HD
# ADF's layout -- and renamed. xdftool puts the root block at 1760, where an
# HD boot block points.
#
# The known file, HDCheck.txt, is 20,000 numbered lines (560,000 bytes).
# Workbench 3.1 has no checksum tool, so on the Amiga:
#   Copy HDBench:HDCheck.txt RAM:      -- no error
#   List RAM:HDCheck.txt               -- 560000 bytes
#   Type RAM:HDCheck.txt               -- ends "HDCHECK line 20000 of 20000"
# trackdisk checks every sector's MFM data checksum as it reads, so a bad
# sector fails the Copy instead of passing silently.
set -euo pipefail
usage='usage: scripts/hd-test-disk.sh <workbench-dd.adf> <out-dir>'
src=${1:?$usage}
out=${2:?$usage}

repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
mkdir -p "$out"
out=$(cd "$out" && pwd)
case "$out/" in
  "$repo"/*) echo "refusing to write inside the repository: $out" >&2; exit 1 ;;
esac
[ "$(wc -c < "$src" | tr -d ' ')" = 901120 ] || { echo "$src is not a 901,120-byte DD ADF" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# 1. The DD disk's files, as a tree (xdftool names the directory after the volume).
mkdir "$work/unp"
xdftool "$src" unpack "$work/unp" >/dev/null
vol_dir=$(find "$work/unp" -mindepth 1 -maxdepth 1 -type d | head -1)
[ -n "$vol_dir" ] || { echo "no volume unpacked from $src" >&2; exit 1; }
vol=$(basename "$vol_dir")   # keep the name: Workbench's own files may refer to it

# 2. The known file.
awk 'BEGIN { for (i = 1; i <= 20000; i++) printf "HDCHECK line %05d of 20000\n", i }' > "$work/HDCheck.txt"
[ "$(wc -c < "$work/HDCheck.txt" | tr -d ' ')" = 560000 ]

# 3. The HD image: format, boot block, the tree, the known file.
hdf="$work/HDBench.hdf"
xdftool "$hdf" create chs=80,2,22 + format "$vol" ffs + boot install >/dev/null
find "$vol_dir" -mindepth 1 -maxdepth 1 -print0 | while IFS= read -r -d '' entry; do
  xdftool "$hdf" write "$entry" >/dev/null
done
xdftool "$hdf" write "$work/HDCheck.txt" >/dev/null

[ "$(wc -c < "$hdf" | tr -d ' ')" = 1802240 ] || { echo "image is not 1,802,240 bytes" >&2; exit 1; }
xdftool "$hdf" boot show | grep -q 'root_blk:  1760' || { echo "root block is not 1760" >&2; exit 1; }
xdftool "$hdf" boot show | grep -q 'bootable: True'  || { echo "boot block is not bootable" >&2; exit 1; }

cp "$hdf" "$out/HDBench.adf"
cp "$work/HDCheck.txt" "$out/HDCheck.txt"
echo "wrote $out/HDBench.adf (volume \"$vol\", FFS, 1,802,240 bytes)"
echo "HDCheck.txt: 560000 bytes, sha256 $(shasum -a 256 "$work/HDCheck.txt" | cut -d' ' -f1)"
xdftool "$hdf" info
