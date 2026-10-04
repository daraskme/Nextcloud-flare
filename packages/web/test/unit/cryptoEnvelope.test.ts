import { beforeAll, describe, expect, it } from "vitest";
import {
  chunkCount,
  cipherSize,
  createFileCipher,
  createRecipientVault,
  decryptChunk,
  decryptFileChunks,
  decryptPlainRange,
  encryptChunk,
  encryptFileChunks,
  type FileCipher,
  iteratePlainRange,
  PLAIN_CHUNK_BYTES,
  parseFileEnvelope,
  partitionCipherChunks,
  planPlainRange,
  unlockRecipientVault,
  unwrapFileCipher,
} from "../../src/lib/cryptoEnvelope";

describe("client encryption envelope draft", () => {
  let owner: Awaited<ReturnType<typeof createRecipientVault>>;
  let admin: Awaited<ReturnType<typeof createRecipientVault>>;
  let cipher: FileCipher;
  let first: Uint8Array;
  let last: Uint8Array;
  const plainSize = PLAIN_CHUNK_BYTES + 7;

  beforeAll(async () => {
    owner = await createRecipientVault("owner_user");
    admin = await createRecipientVault("admin_user");
    cipher = await createFileCipher(plainSize, [
      owner.unlocked.publicKey,
      admin.unlocked.publicKey,
    ]);
    first = new Uint8Array(PLAIN_CHUNK_BYTES);
    first[0] = 11;
    first[first.length - 1] = 19;
    last = Uint8Array.from([1, 2, 3, 4, 5, 6, 7]);
  }, 30_000);

  it("lets owner and admin unwrap the same file key and rejects an unrelated key", async () => {
    const ownerKey = await unwrapFileCipher(cipher.envelope, owner.unlocked);
    const adminKey = await unwrapFileCipher(cipher.envelope, admin.unlocked);
    const chunk = await encryptChunk(cipher, 1, last);
    expect(await decryptChunk(ownerKey, 1, chunk)).toEqual(last);
    expect(await decryptChunk(adminKey, 1, chunk)).toEqual(last);
    const stranger = await createRecipientVault("stranger_user");
    await expect(unwrapFileCipher(cipher.envelope, stranger.unlocked)).rejects.toThrow();
    expect(ownerKey.key.extractable).toBe(false);
  }, 30_000);

  it("accepts one recipient when the owner is also the administrator", async () => {
    const one = await createFileCipher(3, [owner.unlocked.publicKey]);
    const recovered = await unwrapFileCipher(one.envelope, owner.unlocked);
    const bytes = Uint8Array.from([7, 8, 9]);
    expect(await decryptChunk(recovered, 0, await encryptChunk(one, 0, bytes))).toEqual(bytes);
  });

  it("authenticates chunk index, ciphertext, length, crypto id and total size", async () => {
    const encryptedFirst = await encryptChunk(cipher, 0, first);
    const encryptedLast = await encryptChunk(cipher, 1, last);
    expect(await decryptChunk(cipher, 0, encryptedFirst)).toEqual(first);
    await expect(decryptChunk(cipher, 1, encryptedFirst)).rejects.toThrow();
    await expect(decryptChunk(cipher, 0, encryptedLast)).rejects.toThrow();
    await expect(decryptChunk(cipher, 1, encryptedLast.subarray(0, -1))).rejects.toThrow();
    const tampered = encryptedLast.slice();
    tampered[13] = tampered[13]! ^ 1;
    await expect(decryptChunk(cipher, 1, tampered)).rejects.toThrow();
    const changedSize = {
      ...cipher.envelope,
      plainSize: PLAIN_CHUNK_BYTES + 8,
      cipherSize: cipherSize(PLAIN_CHUNK_BYTES + 8),
    };
    await expect(
      decryptChunk({ ...cipher, envelope: changedSize }, 0, encryptedFirst),
    ).rejects.toThrow();
    const changedId = {
      ...cipher.envelope,
      cryptoId: admin.unlocked.publicKey.fingerprint.slice(0, 22),
    };
    await expect(
      decryptChunk({ ...cipher, envelope: changedId }, 0, encryptedFirst),
    ).rejects.toThrow();
  }, 30_000);

  it("handles empty files with one authenticated zero-byte chunk", async () => {
    const empty = await createFileCipher(0, [owner.unlocked.publicKey, admin.unlocked.publicKey]);
    expect(chunkCount(0)).toBe(1);
    expect(empty.envelope.cipherSize).toBe(28);
    const chunks: Uint8Array[] = [];
    for await (const chunk of encryptFileChunks(new Blob([]), empty)) chunks.push(chunk);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(28);
    expect(await decryptChunk(empty, 0, chunks[0]!)).toHaveLength(0);
    expect(planPlainRange(empty.envelope, 0, 0)).toEqual([
      {
        index: 0,
        cipherOffset: 0,
        cipherLength: 28,
        plainOffset: 0,
        plainLength: 0,
        takeOffset: 0,
        takeLength: 0,
      },
    ]);
    const fetched = [];
    for await (const result of decryptPlainRange(empty, 0, 0, async () => chunks[0]!))
      fetched.push(result);
    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toHaveLength(0);
    await expect(decryptChunk(empty, 0, chunks[0]!.subarray(0, 27))).rejects.toThrow();
  }, 30_000);

  it("rejects reordered, omitted, and extra chunks at full-file completion", async () => {
    const a = await encryptChunk(cipher, 0, first);
    const b = await encryptChunk(cipher, 1, last);
    const collect = async (chunks: Uint8Array[]) => {
      const plain = [];
      for await (const chunk of decryptFileChunks(
        (async function* () {
          yield* chunks;
        })(),
        cipher,
      ))
        plain.push(chunk);
      return plain;
    };
    expect((await collect([a, b])).map((chunk) => chunk.length)).toEqual([PLAIN_CHUNK_BYTES, 7]);
    await expect(collect([b, a])).rejects.toThrow();
    await expect(collect([a])).rejects.toThrow();
    await expect(collect([a, b, b])).rejects.toThrow();
  }, 30_000);

  it("separates four MiB cryptographic chunks from transport parts and maps the final range", async () => {
    const file = new Blob([new Uint8Array(first), new Uint8Array(last)]);
    const parts = [];
    for await (const part of partitionCipherChunks(
      encryptFileChunks(file, cipher),
      cipher.envelope.cipherSize,
      PLAIN_CHUNK_BYTES,
    ))
      parts.push(part);
    expect(parts.map((part) => part.length)).toEqual([PLAIN_CHUNK_BYTES, 63]);
    const joined = new Uint8Array(cipher.envelope.cipherSize);
    joined.set(parts[0]!);
    joined.set(parts[1]!, parts[0]!.length);
    const tailPlan = planPlainRange(cipher.envelope, PLAIN_CHUNK_BYTES - 2, 9);
    expect(
      tailPlan.map(({ index, cipherOffset, cipherLength, takeLength }) => [
        index,
        cipherOffset,
        cipherLength,
        takeLength,
      ]),
    ).toEqual([
      [0, 0, PLAIN_CHUNK_BYTES + 28, 2],
      [1, PLAIN_CHUNK_BYTES + 28, 35, 7],
    ]);
    const plain = [];
    for await (const slice of decryptPlainRange(cipher, PLAIN_CHUNK_BYTES - 2, 9, async (range) =>
      joined.subarray(range.cipherOffset, range.cipherOffset + range.cipherLength),
    ))
      plain.push(slice);
    expect([...plain[0]!, ...plain[1]!]).toEqual([0, 19, ...last]);
    await expect(async () => {
      for await (const _ of partitionCipherChunks(
        (async function* () {
          yield joined.subarray(0, -1);
        })(),
        cipher.envelope.cipherSize,
      ))
        void _;
    }).rejects.toThrow();
  }, 30_000);

  it("uses bounded geometry at the configured maximum and strictly parses metadata", () => {
    const maximum = 536_870_912_000;
    expect(() => cipherSize(maximum)).toThrow();
    const validPlainSize = maximum - PLAIN_CHUNK_BYTES;
    expect(cipherSize(validPlainSize)).toBeLessThanOrEqual(maximum);
    expect(
      planPlainRange(
        { ...cipher.envelope, plainSize: validPlainSize, cipherSize: cipherSize(validPlainSize) },
        validPlainSize - 2,
        2,
      ),
    ).toHaveLength(1);
    const large = iteratePlainRange(
      { ...cipher.envelope, plainSize: validPlainSize, cipherSize: cipherSize(validPlainSize) },
      0,
      validPlainSize,
    );
    expect(large.next().value?.index).toBe(0);
    large.return(undefined);
    expect(() =>
      planPlainRange(
        { ...cipher.envelope, plainSize: validPlainSize, cipherSize: cipherSize(validPlainSize) },
        0,
        PLAIN_CHUNK_BYTES * 17,
      ),
    ).toThrow();
    expect(() => parseFileEnvelope({ ...cipher.envelope, unknown: true })).toThrow();
    expect(() =>
      parseFileEnvelope({ ...cipher.envelope, cipherSize: cipher.envelope.cipherSize - 1 }),
    ).toThrow();
    expect(
      parseFileEnvelope({ ...cipher.envelope, recipients: [cipher.envelope.recipients[0]] })
        .recipients,
    ).toHaveLength(1);
    expect(() => planPlainRange(cipher.envelope, plainSize, 1)).toThrow();
  });

  it("recovers a nonextractable private key only with the recovery secret", async () => {
    const unlocked = await unlockRecipientVault(owner.vault, owner.recoveryKey, "owner_user");
    expect(unlocked.privateKey.extractable).toBe(false);
    expect(unlocked.privateKey.type).toBe("private");
    const recovered = await unwrapFileCipher(cipher.envelope, unlocked);
    const chunk = await encryptChunk(cipher, 1, last);
    expect(await decryptChunk(recovered, 1, chunk)).toEqual(last);
    const wrong = await createRecipientVault("wrong_user");
    await expect(
      unlockRecipientVault(owner.vault, wrong.recoveryKey, "owner_user"),
    ).rejects.toThrow();
    await expect(
      unlockRecipientVault(owner.vault, owner.recoveryKey, "admin_user"),
    ).rejects.toThrow();
    await expect(
      unlockRecipientVault(
        { ...owner.vault, accountId: "admin_user" },
        owner.recoveryKey,
        "admin_user",
      ),
    ).rejects.toThrow();
    await expect(
      unlockRecipientVault(
        { ...owner.vault, salt: admin.vault.salt },
        owner.recoveryKey,
        "owner_user",
      ),
    ).rejects.toThrow();
  }, 30_000);
});
