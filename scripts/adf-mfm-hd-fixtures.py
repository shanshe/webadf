#!/usr/bin/env python3
"""Greaseweazle's AmigaDOS_HD MFM for a synthetic HD disk: the independent
oracle for the firmware's HD encoder (wifi-floppy/firmware/src/adf_mfm.c) and
for the whole WFAD -> loader -> track cache path (test_track_cache_hd.c).

MUST run under ~/.local/pipx/venvs/greaseweazle/bin/python (pnpm firmware:hd-fixtures).

    adf-mfm-hd-fixtures.py <out-dir>

Writes, for the synthetic kinds 'prng' and 'bootblock' (src/lib/adfmfm/
synthetic.ts's, over 1,802,240 bytes instead of 901,120):
  <kind>-t<NNN>.mfm   tracks 0, 1, 80 and 159 in full (25,336 bytes each)
  prng-digests.txt    "<track> <sha256>" for all 160 tracks of 'prng'
Synthetic only: nothing derived from a real disk enters the repo. The C tests
regenerate the same bytes with the same xorshift32, so any drift between the
two fails them.
"""
import hashlib
import os
import sys
from greaseweazle.codec.amiga import amigados

HD_BYTES = 22 * 512 * 160
TRACK_BYTES = 22 * 512
MFM_BYTES = 25336
TRACKS = [0, 1, 80, 159]

def fill(buf, start, seed):
    x = seed
    for i in range(start, len(buf)):
        x ^= (x << 13) & 0xffffffff
        x ^= x >> 17
        x ^= (x << 5) & 0xffffffff
        buf[i] = x & 0xff

def synthetic(kind):
    b = bytearray(HD_BYTES)
    if kind == 'prng':
        fill(b, 0, 0x12345678)
    elif kind == 'bootblock':
        b[0:4] = b'DOS\0'
        b[8:12] = (1760).to_bytes(4, 'big')   # HD root block
        fill(b, 12, 0xdeadbeef)
    return b

def encode(raw, tno):
    trk = amigados.AmigaDOS_HD(tno // 2, tno % 2)
    trk.set_img_track(raw[tno * TRACK_BYTES:(tno + 1) * TRACK_BYTES])
    mfm = trk.master_track().bits.tobytes()
    assert len(mfm) == MFM_BYTES, f't{tno}: {len(mfm)} bytes'
    return mfm

out_dir = sys.argv[1]
os.makedirs(out_dir, exist_ok=True)
for kind in ['prng', 'bootblock']:
    raw = synthetic(kind)
    for tno in TRACKS:
        path = os.path.join(out_dir, f'{kind}-t{tno:03d}.mfm')
        with open(path, 'wb') as f:
            f.write(encode(raw, tno))
        print(f'wrote {path}')
    if kind == 'prng':
        path = os.path.join(out_dir, 'prng-digests.txt')
        with open(path, 'w') as f:
            for tno in range(160):
                f.write(f'{tno} {hashlib.sha256(encode(raw, tno)).hexdigest()}\n')
        print(f'wrote {path}')
