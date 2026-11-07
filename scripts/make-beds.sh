#!/usr/bin/env bash
# Turns music tracks (e.g. generated with Suno) into bed loops for the radio: public/bed-1.mp3 … bed-N.mp3.
# Usage: scripts/make-beds.sh <dir-with-mp3s>   (needs ffmpeg; run from the repo root; overwrites public/bed-*.mp3)
# Each track: first LEN seconds, the last XF seconds folded onto the first XF seconds (seamless loop), loudness
# normalised to about -24 LUFS with a -12 dBFS ceiling, stereo 96 kbps. The player picks one at random per episode.
set -euo pipefail
command -v ffmpeg >/dev/null || { echo "ffmpeg is required" >&2; exit 1; }
[ -d public ] || { echo "run from the repo root" >&2; exit 1; }
DIR=${1:?dir}
LEN=96   # seconds kept from each track (plus XF for the fold)
XF=4
rm -f public/bed-[0-9]*.mp3
n=0
find "$DIR" -maxdepth 1 -name '*.mp3' -print0 | sort -z | while IFS= read -r -d '' f; do
  n=$((n+1)); out="public/bed-$n.mp3"
  ffmpeg -y -hide_banner -loglevel error -i "$f" -vn -filter_complex "
    [0:a]atrim=start=0:end=$((LEN+XF)),asetpts=PTS-STARTPTS,asplit[x][y];
    [x]atrim=start=0:end=$XF,asetpts=PTS-STARTPTS[head];
    [y]atrim=start=$XF,asetpts=PTS-STARTPTS[body];
    [body][head]acrossfade=d=$XF:c1=tri:c2=tri,loudnorm=I=-24:TP=-9:LRA=9,alimiter=limit=0.25:level=disabled[out]" \
    -map "[out]" -ar 44100 -ac 2 -b:a 96k -id3v2_version 0 -write_xing 0 "$out"
  printf '%s <- %s\n' "$out" "$(basename "$f")"
  ffmpeg -hide_banner -i "$out" -af volumedetect -f null - 2>&1 | grep -E "mean_volume|max_volume" | sed 's/^/   /'
done
ls -la public/bed-*.mp3
