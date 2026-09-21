import { describe, expect, it } from "vitest";

import { parseAudioMetadata } from "../../src/media/audio/parser.js";

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function be32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function le32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function synchsafe(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 21) & 0x7f,
    (value >>> 14) & 0x7f,
    (value >>> 7) & 0x7f,
    value & 0x7f,
  ]);
}

function id3Frame(id: string, value: Uint8Array): Uint8Array {
  return concat(text(id), be32(value.byteLength), new Uint8Array(2), value);
}

function commentBlock(values: string[]): Uint8Array {
  return concat(
    le32(0),
    le32(values.length),
    ...values.map((value) => {
      const bytes = text(value);
      return concat(le32(bytes.byteLength), bytes);
    }),
  );
}

function atom(type: string, payload = new Uint8Array()): Uint8Array {
  return concat(
    be32(payload.byteLength + 8),
    Uint8Array.from(type, (value) => value.charCodeAt(0)),
    payload,
  );
}

function mp4Data(value: Uint8Array): Uint8Array {
  return atom("data", concat(new Uint8Array(8), value));
}

describe("bounded audio metadata parsers", () => {
  it("extracts MP3 ID3v2 text, order, duration, bitrate, and cover", () => {
    const frames = concat(
      id3Frame("TIT2", concat(new Uint8Array([3]), text("Song"))),
      id3Frame("TPE1", concat(new Uint8Array([3]), text("Artist"))),
      id3Frame("TALB", concat(new Uint8Array([3]), text("Album"))),
      id3Frame("TRCK", concat(new Uint8Array([3]), text("2/10"))),
      id3Frame(
        "APIC",
        concat(
          new Uint8Array([3]),
          text("image/jpeg"),
          new Uint8Array([0, 3, 0, 0xff, 0xd8, 0xff]),
        ),
      ),
    );
    const head = concat(
      text("ID3"),
      new Uint8Array([3, 0, 0]),
      synchsafe(frames.byteLength),
      frames,
      new Uint8Array([0xff, 0xfb, 0x90, 0x64]),
    );
    expect(parseAudioMetadata({ name: "song.mp3", size: 128_000, head, tail: head })).toMatchObject(
      {
        title: "Song",
        artist: "Artist",
        album: "Album",
        trackNo: 2,
        codec: "mp3",
        bitrate: 128_000,
        durationMs: 8000,
        cover: { mime: "image/jpeg" },
      },
    );
  });

  it("extracts FLAC STREAMINFO and Vorbis comments", () => {
    const streamInfo = new Uint8Array(34);
    const packed = (44_100n << 44n) | (1n << 41n) | (15n << 36n) | 88_200n;
    new DataView(streamInfo.buffer).setBigUint64(10, packed, false);
    const comments = commentBlock([
      "TITLE=FLAC Song",
      "ARTIST=FLAC Artist",
      "ALBUM=FLAC Album",
      "TRACKNUMBER=3",
      "DISCNUMBER=1",
    ]);
    const head = concat(
      text("fLaC"),
      new Uint8Array([0, 0, 0, streamInfo.byteLength]),
      streamInfo,
      new Uint8Array([0x84, 0, 0, comments.byteLength]),
      comments,
    );
    expect(
      parseAudioMetadata({ name: "song.flac", size: 176_400, head, tail: head }),
    ).toMatchObject({
      title: "FLAC Song",
      artist: "FLAC Artist",
      album: "FLAC Album",
      trackNo: 3,
      discNo: 1,
      durationMs: 2000,
      codec: "flac",
    });
  });

  it("extracts OGG/Opus comments and tail granule duration", () => {
    const comments = commentBlock(["TITLE=Opus Song", "ARTIST=Opus Artist"]);
    const head = concat(
      text("OggS"),
      new Uint8Array(32),
      text("OpusHead"),
      new Uint8Array(19),
      text("OpusTags"),
      comments,
    );
    const tail = new Uint8Array(128);
    tail.set(text("OggS"));
    new DataView(tail.buffer).setBigUint64(6, 96_000n, true);
    expect(parseAudioMetadata({ name: "song.opus", size: 32_000, head, tail })).toMatchObject({
      title: "Opus Song",
      artist: "Opus Artist",
      durationMs: 2000,
      codec: "opus",
    });
  });

  it("extracts M4A atoms and WAV INFO metadata", () => {
    const mvhd = new Uint8Array(20);
    new DataView(mvhd.buffer).setUint32(12, 1000, false);
    new DataView(mvhd.buffer).setUint32(16, 5000, false);
    const ilst = atom(
      "ilst",
      concat(
        atom("©nam", mp4Data(text("M4A Song"))),
        atom("©ART", mp4Data(text("M4A Artist"))),
        atom("©alb", mp4Data(text("M4A Album"))),
        atom("trkn", mp4Data(new Uint8Array([0, 0, 0, 4, 0, 9]))),
      ),
    );
    const moov = atom(
      "moov",
      concat(
        atom("mvhd", mvhd),
        atom("udta", atom("meta", concat(new Uint8Array(4), ilst))),
        atom("mp4a"),
      ),
    );
    expect(
      parseAudioMetadata({
        name: "song.m4a",
        size: 80_000,
        head: atom("ftyp"),
        tail: moov,
        mp4Window: moov,
      }),
    ).toMatchObject({
      title: "M4A Song",
      artist: "M4A Artist",
      album: "M4A Album",
      trackNo: 4,
      durationMs: 5000,
      codec: "aac",
    });

    const fmt = new Uint8Array(16);
    const fmtView = new DataView(fmt.buffer);
    fmtView.setUint16(0, 1, true);
    fmtView.setUint16(2, 2, true);
    fmtView.setUint32(4, 48_000, true);
    fmtView.setUint32(8, 192_000, true);
    fmtView.setUint16(12, 4, true);
    fmtView.setUint16(14, 16, true);
    const infoValue = concat(text("WAV Song"), new Uint8Array([0]));
    const info = concat(
      text("INFO"),
      text("INAM"),
      le32(infoValue.byteLength),
      infoValue,
      new Uint8Array(infoValue.byteLength % 2),
    );
    const data = new Uint8Array(1920);
    const chunks = concat(
      text("fmt "),
      le32(fmt.byteLength),
      fmt,
      text("LIST"),
      le32(info.byteLength),
      info,
      text("data"),
      le32(data.byteLength),
      data,
    );
    const wav = concat(text("RIFF"), le32(chunks.byteLength + 4), text("WAVE"), chunks);
    expect(
      parseAudioMetadata({ name: "song.wav", size: wav.byteLength, head: wav, tail: wav }),
    ).toMatchObject({
      title: "WAV Song",
      durationMs: 10,
      codec: "pcm",
      bitrate: 1_536_000,
    });
  });
});
