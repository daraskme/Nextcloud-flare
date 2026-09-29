# Encoded track fixtures

Generated locally with FFmpeg 9.0.1 from a synthetic 160×90 test pattern/blue field and a 440 Hz sine tone. No external media or user content is included. Each is two seconds long. `encoded.ts` contains the exact same bytes for Workers tests; Node/browser tests read the binary files.

```sh
ffmpeg -f lavfi -i 'testsrc2=size=160x90:rate=10:duration=2' -f lavfi -i 'sine=frequency=440:sample_rate=48000:duration=2' -c:v libaom-av1 -cpu-used 8 -crf 45 -threads 1 -c:a libopus -b:a 24k -metadata title='AV1 test' -movflags +faststart av1-opus.mp4
ffmpeg -i av1-opus.mp4 -c copy av1-opus.webm
ffmpeg -i av1-opus.mp4 -map 0:v -c copy av1.mp4
ffmpeg -i av1-opus.mp4 -map 0:v -c copy av1.webm
ffmpeg -f lavfi -i 'color=c=blue:size=160x90:rate=5:duration=2' -pix_fmt yuv420p10le -c:v libaom-av1 -cpu-used 8 -crf 45 -threads 1 av1-10bit.mp4
ffmpeg -i av1-10bit.mp4 -c copy av1-10bit.webm
ffmpeg -i av1-opus.mp4 -map 0:a -c copy -metadata title='テスト曲' -metadata artist='Local fixture' -metadata album='Test album' -metadata track=2 opus.ogg
ffmpeg -i opus.ogg -c copy opus.webm
ffmpeg -i opus.ogg -c copy -metadata title='テスト曲' -metadata artist='Local fixture' -metadata album='Test album' -metadata track=2 opus.mp4
```

AV1 configuration is Main profile, level index 0, main tier, 8-bit or 10-bit. Opus is mono at 48 kHz. The MP4 without audio places moov after mdat; a sparse unit fixture expands mdat to 1 GB to verify that media bytes are skipped. Tests also mutate headers, ranges, codec parameters and Ogg checksums. These samples do not replace a cross-browser/OS support matrix.

`long.opus` is a 90-second, low-bitrate stream used by Node parser and browser player tests. It verifies that audio packet counts do not consume the metadata-structure budget; page CRC and header bounds still apply.

```sh
ffmpeg -f lavfi -i 'sine=frequency=440:sample_rate=48000:duration=90' -c:a libopus -application voip -b:a 6k long.opus
```

Additional two-second audio fixtures use the same synthetic 440 Hz tone. `encodedAudio.ts` contains base64 of `tone.mp3`, `tone.flac` and `tone.wav` for Workers tests. The MPEG-2/2.5 samples exercise lower sample rates, ID3v2.4 and a stream without ID3/Xing. WAV is mono 16-bit PCM; Node tests also construct PCM extensible and IEEE float containers. All commands below were run locally with FFmpeg 9.0.1.

```sh
ffmpeg -f lavfi -i 'sine=frequency=440:sample_rate=48000:duration=2' -c:a libmp3lame -b:a 64k -id3v2_version 3 -metadata title='テスト曲' -metadata artist='Local fixture' -metadata album='Test album' -metadata track=2 -metadata disc=1 tone.mp3
ffmpeg -f lavfi -i 'sine=frequency=440:sample_rate=48000:duration=2' -c:a flac -metadata title='テスト曲' -metadata artist='Local fixture' -metadata album='Test album' -metadata track=2 -metadata disc=1 tone.flac
ffmpeg -f lavfi -i 'sine=frequency=440:sample_rate=48000:duration=2' -c:a pcm_s16le -metadata title='テスト曲' -metadata artist='Local fixture' -metadata album='Test album' -metadata track=2 tone.wav
ffmpeg -f lavfi -i 'sine=frequency=440:sample_rate=22050:duration=2' -c:a libmp3lame -b:a 32k -id3v2_version 4 -metadata title='テスト曲' -metadata artist='Local fixture' -metadata album='Test album' -metadata track=2 tone-mpeg2.mp3
ffmpeg -f lavfi -i 'sine=frequency=440:sample_rate=11025:duration=2' -c:a libmp3lame -b:a 16k -id3v2_version 0 -write_xing 0 tone-mpeg25.mp3
```

AAC and Vorbis fixtures below are also included in `encodedAudio.ts`. The AAC files use AAC-LC: mono at 48 kHz with faststart, and stereo at 44.1 kHz with a Program Config Element and trailing moov. Vorbis uses mono at 48 kHz and stereo at 44.1 kHz. Actual HE-AAC playback is not covered by these fixtures; SBR/PS configuration parsing has separate synthetic unit tests.

```sh
ffmpeg -f lavfi -i 'sine=frequency=440:sample_rate=48000:duration=2' -c:a aac -b:a 64k -movflags +faststart -metadata title='テスト曲' -metadata artist='Local fixture' -metadata album='Test album' -metadata track=2 -metadata disc=1 tone.m4a
ffmpeg -f lavfi -i 'sine=frequency=440:sample_rate=44100:duration=2' -ac 2 -c:a aac -b:a 96k -aac_pce 1 -metadata title='テスト曲' -metadata artist='Local fixture' -metadata album='Test album' -metadata track=2 tone-pce.m4a
ffmpeg -f lavfi -i 'sine=frequency=440:sample_rate=48000:duration=2' -c:a libvorbis -q:a 2 -metadata title='テスト曲' -metadata artist='Local fixture' -metadata album='Test album' -metadata track=2 -metadata disc=1 tone.ogg
ffmpeg -f lavfi -i 'sine=frequency=440:sample_rate=44100:duration=2' -ac 2 -c:a libvorbis -q:a 3 -metadata title='テスト曲' -metadata artist='Local fixture' -metadata album='Test album' -metadata track=2 tone-stereo.ogg
```

`cover.mp3`, `cover.flac`, `cover.m4a`, `cover.opus` and `cover.ogg` add the locally generated `../images/pattern.png` to the corresponding two-second audio above. `encodedCovers.ts` contains exactly these bytes. The embedded PNG bytes, dimensions and audio identity are checked independently in Node tests; Workers and browser tests use real Images conversion and thumbnail delivery.

```sh
ffmpeg -i tone.mp3 -i ../images/pattern.png -map 0:a -map 1:v -c copy -id3v2_version 3 -disposition:v attached_pic -metadata:s:v title='Cover' -metadata:s:v comment='Cover (front)' cover.mp3
ffmpeg -i tone.flac -i ../images/pattern.png -map 0:a -map 1:v -c copy -disposition:v attached_pic -metadata:s:v title='Cover' -metadata:s:v comment='Cover (front)' cover.flac
ffmpeg -i tone.m4a -i ../images/pattern.png -map 0:a -map 1:v -c copy -disposition:v attached_pic -movflags +faststart cover.m4a
```

For Ogg, write a FLAC PICTURE block with big-endian fields: picture type 3, MIME length 9 and `image/png`, description length 0, four zero geometry/depth/palette integers, then the exact PNG byte length and bytes. Its canonical base64 is the `METADATA_BLOCK_PICTURE` value in `cover.ffmetadata` (first line `;FFMETADATA1`). The parser inspects the real image dimensions instead of trusting the optional declared geometry.

```sh
ffmpeg -i opus.ogg -i cover.ffmetadata -map_metadata 1 -map 0:a -c copy cover.opus
ffmpeg -i tone.ogg -i cover.ffmetadata -map_metadata 1 -map 0:a -c copy cover.ogg
```
