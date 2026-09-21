export async function putKnownLength(
  bucket: R2Bucket,
  key: string,
  source: ReadableStream<Uint8Array>,
  length: number,
): Promise<R2Object> {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError("Content length is invalid");
  }

  const fixed = new FixedLengthStream(length);
  const upload = bucket.put(key, fixed.readable);
  const transfer = source.pipeTo(fixed.writable);
  const [object] = await Promise.all([upload, transfer]);
  if (object === null) {
    throw new Error("Unconditional R2 upload returned no object");
  }
  return object;
}

export async function digestSha256(source: ReadableStream<Uint8Array>): Promise<ArrayBuffer> {
  const DigestStreamConstructor = (crypto as Crypto & { DigestStream: typeof DigestStream })
    .DigestStream;
  const digest = new DigestStreamConstructor("SHA-256");
  await source.pipeTo(digest);
  return digest.digest;
}

export async function pumpWithBackpressure(
  source: ReadableStream<Uint8Array>,
  sink: WritableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<void> {
  await source.pipeTo(sink, signal === undefined ? undefined : { signal });
}
