#!/usr/bin/env bash
# Synthesizes public/bed.mp3: a calm static pad (no rhythm, no melody) that loops under the DJ's voice.
# Run from the repo root: scripts/make-bed.sh   (needs ffmpeg; overwrites public/bed.mp3)
set -euo pipefail

command -v ffmpeg >/dev/null || { echo "ffmpeg is required" >&2; exit 1; }
[ -d public ] || { echo "run from the repo root" >&2; exit 1; }

OUT=public/bed.mp3
RATE=44100
RAW=36   # generate 36 s, then fold the last 4 s onto the first 4 s -> 32 s seamless loop
XF=4

# A soft open fifth on A (110 Hz + 164.81 Hz), each pair slightly detuned, each swelling slowly
# with its own 0.05-0.08 Hz LFO, plus pink noise under a 500 Hz low-pass as the "night city hum".
# The LFO periods (20, 16, 14 s) are not divisors of 32 s, so the seam is hidden by the crossfade, not by phase.
pad() { # freq, lfo(Hz), level; swell between 40% and 100% of level
  printf "sine=f=%s:r=%s:d=%s,volume='%s*(0.7+0.3*sin(2*PI*%s*t))':eval=frame" "$1" "$RATE" "$RAW" "$3" "$2"
}

FILTER="
$(pad 110.00 0.050 0.50)[a];
$(pad 110.55 0.065 0.35)[b];
$(pad 164.81 0.080 0.30)[c];
$(pad 165.30 0.057 0.22)[d];
anoisesrc=color=pink:r=$RATE:d=$RAW:a=0.5,lowpass=f=500,volume=0.55[n];
[a][b][c][d][n]amix=inputs=5:normalize=0,highpass=f=50,asplit[x][y];
[x]atrim=start=0:end=$XF,asetpts=PTS-STARTPTS[head];
[y]atrim=start=$XF,asetpts=PTS-STARTPTS[body];
[body][head]acrossfade=d=$XF:c1=tri:c2=tri,loudnorm=I=-24:TP=-9:LRA=7,alimiter=limit=0.25:level=disabled[out]
"

ffmpeg -y -hide_banner -loglevel error -filter_complex "$FILTER" -map "[out]" \
  -ar "$RATE" -ac 1 -b:a 64k -id3v2_version 0 -write_xing 0 "$OUT"

ffprobe -v error -show_entries format=duration,bit_rate:stream=channels -of default=nw=1 "$OUT"
ffmpeg -hide_banner -i "$OUT" -af volumedetect -f null - 2>&1 | grep -E "mean_volume|max_volume"
