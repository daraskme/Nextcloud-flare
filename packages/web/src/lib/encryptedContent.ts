import {
  adminReceiptPayload,
  encryptionHeaderHash,
  verifyEncryptionAttestation,
} from "../../../shared/src/encryptionAttestation";
import {
  type Account,
  type AdminFileUser,
  api,
  type FileNode,
  type PreparedContentSession,
} from "./api";
import {
  registerClientMedia,
  renewClientMedia,
  revokeClientMedia,
} from "./clientMediaRegistration";
import {
  decryptContainerPlainRange,
  type OpenedContainer,
  openAttestedLegacyContainerHeader,
  openAuthenticatedContainerHeader,
  parseContainerHeader,
  readContainerHeaderLength,
} from "./encryptedContainer";
import { getEncryptionSession, onEncryptionLock } from "./encryptionSession";

export interface OpenEncryptedContent {
  readonly opened: OpenedContainer;
  readonly adminReceiptRecorded: boolean;
  media(mode: "inline" | "download"): Promise<string>;
  close(): Promise<void>;
}

/** Read bounded ciphertext ranges only. Never accept a server's whole-file fallback. */
export async function readEncryptedContent(
  account: Account,
  node: FileNode,
  owner?: AdminFileUser,
  signal?: AbortSignal,
  metadataSession?: PreparedContentSession,
): Promise<OpenEncryptedContent> {
  const keys = getEncryptionSession(account.id);
  const marker = node.encryption;
  const ownerId = owner?.id ?? node.ownerId ?? account.id;
  if (
    !keys ||
    !marker ||
    marker.ownerId !== ownerId ||
    !node.currentBlobId ||
    !Number.isSafeInteger(node.size) ||
    node.size! < 12
  )
    throw new Error("暗号化設定で復旧ファイルを読み込み、鍵を解除してください。");
  const controller = new AbortController();
  const signals = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
  let action: "preview" | "download" = "preview";
  const content =
    metadataSession ??
    (owner
      ? await api.prepareAdminContentSession(owner, node, action, account, signals)
      : await api.prepareContentSession(
          account,
          [{ id: node.id, currentBlobId: node.currentBlobId }],
          "content",
          signals,
        ));
  const url = content.url({ id: node.id, currentBlobId: node.currentBlobId });
  const virtual = new Map<"inline" | "download", string>();
  let closed = false;
  let expiresAt = Date.now() + 270_000;
  const sessions: { session: PreparedContentSession; at: number }[] = metadataSession
    ? []
    : [{ session: content, at: Date.now() }];
  let renewal: ReturnType<typeof setInterval> | undefined;
  let renewing = false;
  let detach = () => {};
  const close = async () => {
    if (closed) return;
    closed = true;
    clearInterval(renewal);
    controller.abort();
    detach();
    await Promise.allSettled([...virtual.values()].map(revokeClientMedia));
    await Promise.allSettled(sessions.map(({ session }) => session.cancel()));
  };
  detach = onEncryptionLock(() => {
    void close();
  });
  try {
    let etag = "";
    const range = async (offset: number, length: number) => {
      const response = await fetch(url, {
        headers: { Range: `bytes=${offset}-${offset + length - 1}` },
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        signal: signals,
      });
      const receivedEtag = response.headers.get("ETag") ?? "";
      if (
        response.status !== 206 ||
        response.url !== url ||
        response.redirected ||
        !/^"[A-Za-z0-9._:-]{1,200}"$/.test(receivedEtag) ||
        (etag && receivedEtag !== etag) ||
        response.headers.get("Content-Range") !==
          `bytes ${offset}-${offset + length - 1}/${node.size}` ||
        (response.headers.has("Content-Length") &&
          response.headers.get("Content-Length") !== String(length)) ||
        !response.body
      ) {
        await response.body?.cancel();
        throw new Error("暗号化ファイルの配信情報を確認できません。再度開いてください。");
      }
      etag = receivedEtag;
      const bytes = new Uint8Array(length);
      const reader = response.body.getReader();
      let count = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          if (count + next.value.length > length) throw new Error("encrypted_range_overflow");
          bytes.set(next.value, count);
          count += next.value.length;
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      if (count !== length) throw new Error("encrypted_range_truncated");
      return bytes;
    };
    const prefix = await range(0, 12);
    const length = readContainerHeaderLength(prefix);
    const headerBytes = new Uint8Array(12 + length);
    headerBytes.set(prefix);
    headerBytes.set(await range(12, length), 12);
    const header = parseContainerHeader(headerBytes);
    if (
      header.totalBytes !== node.size ||
      header.envelope.cryptoId !== marker.cryptoId ||
      (await encryptionHeaderHash(new Uint8Array(headerBytes))) !== marker.headerSha256 ||
      !marker.signerFingerprint ||
      !marker.signerRsaFingerprint
    )
      throw new Error(
        "暗号化ファイルの登録情報が一致しません。所有者または管理者に確認してください。",
      );

    const registeredOwnerKeys = (await api.encryptionKeys(ownerId)).keys.filter(
      (entry) => entry.accountId === ownerId,
    );
    const ownerKey = registeredOwnerKeys[0];
    if (
      registeredOwnerKeys.length !== 1 ||
      !ownerKey ||
      ownerKey.recipient.fingerprint !== marker.signerRsaFingerprint ||
      ownerKey.signer.fingerprint !== marker.signerFingerprint
    )
      throw new Error("所有者の現在の登録済み署名鍵を確認できません。暗号化ファイルを開けません。");
    const registeredAdminKeys = (await api.encryptionAdminKeys()).keys.filter(
      (entry) => entry.recipient.fingerprint === marker.requiredAdminFingerprint,
    );
    if (registeredAdminKeys.length !== 1)
      throw new Error("現在の管理者公開鍵を確認できません。暗号化ファイルを開けません。");
    let verifiedExistingReceipt = false;
    if (marker.adminReceiptState === "verified") {
      const receiptAdmin = registeredAdminKeys.find(
        (entry) => entry.accountId === marker.adminAccountId,
      );
      if (
        !receiptAdmin ||
        !marker.adminReceiptSignature ||
        !(await verifyEncryptionAttestation(
          receiptAdmin.signer.spki,
          marker.adminReceiptSignature,
          adminReceiptPayload({
            ownerId,
            blobId: node.currentBlobId,
            headerSha256: marker.headerSha256,
            cryptoId: marker.cryptoId,
            adminAccountId: receiptAdmin.accountId,
            adminFingerprint: marker.requiredAdminFingerprint,
          }),
        ))
      )
        throw new Error("管理者による復号確認の署名を検証できません。");
      verifiedExistingReceipt = true;
    }

    let opened: OpenedContainer;
    if (marker.formatVersion === 2) {
      opened = await openAuthenticatedContainerHeader(header, keys.owner, {
        expectedOwnerId: ownerId,
        expectedSize: node.size!,
        ownerSigningSpki: ownerKey.signer.spki,
        requiredOwnerFingerprint: marker.signerRsaFingerprint,
        requiredAdminFingerprint: marker.requiredAdminFingerprint,
        expectedHeaderSha256: marker.headerSha256,
      });
    } else {
      if (
        !marker.legacyAttestation ||
        !marker.ownerSignature ||
        marker.attestedNodeId !== node.id ||
        marker.attestedRevision === undefined ||
        marker.attestedRevision === null ||
        marker.attestedRevision < 1
      )
        throw new Error("旧形式の送信者を確認できません。所有者による明示的な確認が必要です。");
      opened = await openAttestedLegacyContainerHeader(header, keys.owner, {
        attestation: {
          ownerId,
          nodeId: node.id,
          blobId: node.currentBlobId,
          revision: marker.attestedRevision,
          headerSha256: marker.headerSha256,
          cryptoId: marker.cryptoId,
          requiredAdminFingerprint: marker.requiredAdminFingerprint,
        },
        ownerSignature: marker.ownerSignature,
        ownerSigningSpki: ownerKey.signer.spki,
        expectedOwnerId: ownerId,
        expectedNodeId: node.id,
        expectedBlobId: node.currentBlobId,
        expectedSize: node.size!,
        expectedOwnerFingerprint: marker.signerRsaFingerprint,
        expectedAdminFingerprint: marker.requiredAdminFingerprint,
      });
    }
    signals.throwIfAborted();
    if (getEncryptionSession(account.id) !== keys) throw new Error("encryption_locked");
    let adminReceiptRecorded = verifiedExistingReceipt;
    if (
      account.role === "app_admin" &&
      !metadataSession &&
      keys.ownerRegistered &&
      keys.owner.publicKey.fingerprint === marker.requiredAdminFingerprint &&
      registeredAdminKeys.some(
        (entry) =>
          entry.accountId === account.id &&
          entry.signer.fingerprint === keys.owner.signing.fingerprint &&
          entry.signer.spki === keys.owner.signing.spki,
      ) &&
      keys.owner.signing.privateKey.algorithm.name === "Ed25519" &&
      marker.adminReceiptState !== "verified"
    ) {
      const readCipherChunk = async (offset: number, length: number) => {
        const output = new Uint8Array(length);
        let received = 0;
        while (received < length) {
          const part = Math.min(4 * 1024 * 1024, length - received);
          output.set(await range(offset + received, part), received);
          received += part;
        }
        return output;
      };
      for await (const _chunk of decryptContainerPlainRange(
        opened,
        0,
        Math.min(opened.envelope.plainSize, 4 * 1024 * 1024),
        (chunk) => readCipherChunk(chunk.cipherOffset, chunk.cipherLength),
      )) {
        // Drop plaintext immediately; do not buffer it or expose it to UI state.
      }
      const payload = adminReceiptPayload({
        ownerId,
        blobId: node.currentBlobId,
        headerSha256: marker.headerSha256,
        cryptoId: marker.cryptoId,
        adminAccountId: account.id,
        adminFingerprint: keys.owner.publicKey.fingerprint,
      });
      const signature = new Uint8Array(
        await crypto.subtle.sign("Ed25519", keys.owner.signing.privateKey, payload),
      );
      let binary = "";
      for (const byte of signature) binary += String.fromCharCode(byte);
      const signatureBase64 = btoa(binary)
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
      try {
        await api.recordAdminEncryptionReceipt(
          node.currentBlobId,
          marker.headerSha256,
          signatureBase64,
        );
        adminReceiptRecorded = true;
      } catch {
        adminReceiptRecorded = false;
      }
    }
    if (!metadataSession)
      renewal = setInterval(() => {
        if (renewing || closed) return;
        renewing = true;
        void (async () => {
          if (getEncryptionSession(account.id) !== keys) throw new Error("encryption_locked");
          const next = owner
            ? await api.prepareAdminContentSession(owner, node, action, account, signals)
            : await api.prepareContentSession(
                account,
                [{ id: node.id, currentBlobId: node.currentBlobId! }],
                "content",
                signals,
              );
          if (closed) {
            await next.cancel();
            return;
          }
          sessions.push({ session: next, at: Date.now() });
          expiresAt = Date.now() + 270_000;
          for (const media of virtual.values()) await renewClientMedia(media, expiresAt);
          // Let old in-flight ranges finish before discarding naturally expired tickets.
          while (sessions[0] && sessions[0].at < Date.now() - 300_000) {
            const expired = sessions.shift()!;
            await expired.session.cancel().catch(() => undefined);
          }
        })()
          .catch(() => close())
          .finally(() => {
            renewing = false;
          });
      }, 180_000);
    return {
      opened,
      adminReceiptRecorded,
      close,
      async media(mode) {
        if (metadataSession) throw new Error("metadata_session_cannot_stream");
        signals.throwIfAborted();
        if (owner && mode === "download") {
          const download = await api.prepareAdminContentSession(
            owner,
            node,
            "download",
            account,
            signals,
          );
          if (closed) {
            await download.cancel();
            throw new Error("encryption_locked");
          }
          sessions.push({ session: download, at: Date.now() });
          action = "download";
          expiresAt = Date.now() + 270_000;
        }
        const existing = virtual.get(mode);
        if (existing) {
          await renewClientMedia(existing, expiresAt);
          return existing;
        }
        const value = await registerClientMedia({
          headerBytes,
          cipher: opened.cipher,
          sourceUrl: url,
          sourceEtag: etag,
          accountId: account.id,
          expiresAt,
          mode,
        });
        if (closed) {
          await revokeClientMedia(value);
          throw new Error("encryption_locked");
        }
        virtual.set(mode, value);
        return value;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
