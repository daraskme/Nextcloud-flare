# Image metadata fixtures

Generated locally with FFmpeg 9.0.1 from uniform 16×12 color sources. These contain no user images or external copyrighted media. The parser reads encoded container metadata; this directory does not prove browser decoder support.

```sh
ffmpeg -f lavfi -i 'color=c=red:s=16x12:d=1:r=2' -frames:v 1 -threads 1 red.png
ffmpeg -f lavfi -i 'color=c=red:s=16x12:d=1:r=2' -frames:v 1 -threads 1 red.jpg
ffmpeg -f lavfi -i 'color=c=red:s=16x12:d=1:r=2' -frames:v 1 -threads 1 red.webp
ffmpeg -f lavfi -i 'color=c=red:s=16x12:d=1:r=2' -frames:v 1 -c:v libaom-av1 -cpu-used 8 -threads 1 red.avif
ffmpeg -f lavfi -i 'color=c=blue:s=16x12:d=1:r=2' -frames:v 1 -pix_fmt yuv420p10le -c:v libaom-av1 -cpu-used 8 -threads 1 blue-10bit.avif
ffmpeg -f lavfi -i 'color=c=green:s=16x12:d=1:r=2' -frames:v 2 -c:v libaom-av1 -cpu-used 8 -threads 1 sequence.avif
```

`encoded.ts` is the base64 representation of `red.png` and `red.avif` for the Workers test runtime, which cannot read local files. Node tests read the binary originals. Synthetic EXIF, corrupt containers and sparse large payloads are assembled by the unit tests.
