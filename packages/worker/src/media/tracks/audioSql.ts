/** Internal SQL for the fixed audio/blob aliases a and b. */
export const AUDIO_CODEC_MIME = `((a.codec='opus' AND b.mime_sniffed IN ('audio/ogg; codecs="opus"','audio/webm; codecs="opus"','audio/mp4; codecs="Opus"'))
    OR (a.codec='mp3' AND b.mime_sniffed='audio/mpeg')
    OR (a.codec='flac' AND b.mime_sniffed='audio/flac')
    OR (a.codec='pcm' AND b.mime_sniffed='audio/wav')
    OR (a.codec='vorbis' AND b.mime_sniffed='audio/ogg; codecs="vorbis"')
    OR (a.codec='aac' AND b.mime_sniffed IN ('audio/mp4; codecs="mp4a.40.2"','audio/mp4; codecs="mp4a.40.5"','audio/mp4; codecs="mp4a.40.29"')))`;
