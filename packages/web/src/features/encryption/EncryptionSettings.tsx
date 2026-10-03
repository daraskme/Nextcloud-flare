import { Download, KeyRound, LoaderCircle, ShieldCheck, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import type { Account } from "../../lib/api";
import {
  createRecipientVault,
  type RecipientPublicKey,
  type RecipientVault,
  type UnlockedRecipient,
  unlockRecipientVault,
} from "../../lib/cryptoEnvelope";
import {
  EncryptionVaultStore,
  MAX_ENCRYPTION_FILE_BYTES,
  type PinnedAdminRecipient,
  parsePublicKeyFile,
  parseRecoveryFile,
  publicKeyFileJson,
  recoveryFileJson,
} from "../../lib/encryptionVaultStore";

interface PendingSetup {
  readonly vault: RecipientVault;
  readonly recoveryKey: string;
  readonly downloaded: boolean;
}

interface AdminKeyCandidate {
  readonly accountId: string;
  readonly recipient: RecipientPublicKey;
}

export interface EncryptionUnlockState {
  readonly owner: UnlockedRecipient;
  readonly adminRecipient: RecipientPublicKey | null;
}

export interface EncryptionSettingsProps {
  readonly account: Account;
  readonly initialUnlocked?: EncryptionUnlockState | null;
  readonly onUnlocked: (state: EncryptionUnlockState | null) => void;
}

function downloadJson(filename: string, json: string): void {
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function sameVault(left: RecipientVault, right: RecipientVault): boolean {
  return (
    left.version === right.version &&
    left.accountId === right.accountId &&
    left.recipient.fingerprint === right.recipient.fingerprint &&
    left.recipient.spki === right.recipient.spki &&
    left.salt === right.salt &&
    left.iv === right.iv &&
    left.encryptedPkcs8 === right.encryptedPkcs8
  );
}

export function EncryptionSettings({
  account,
  initialUnlocked,
  onUnlocked,
}: EncryptionSettingsProps) {
  const store = useMemo(() => new EncryptionVaultStore(), []);
  const callback = useRef(onUnlocked);
  const accountId = useRef(account.id);
  const initialUnlockedRef = useRef(initialUnlocked);
  const fileInput = useRef<HTMLInputElement>(null);
  const adminKeyInput = useRef<HTMLInputElement>(null);
  const [vault, setVault] = useState<RecipientVault | null>(null);
  const [pending, setPending] = useState<PendingSetup | null>(null);
  const [publicKey, setPublicKey] = useState<RecipientPublicKey | null>(
    initialUnlocked?.owner.publicKey ?? null,
  );
  const [unlockedRecipient, setUnlockedRecipient] = useState<UnlockedRecipient | null>(
    initialUnlocked?.owner ?? null,
  );
  const [pinnedAdmin, setPinnedAdmin] = useState<PinnedAdminRecipient | null>(null);
  const [adminCandidate, setAdminCandidate] = useState<AdminKeyCandidate | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [unlocked, setUnlocked] = useState(Boolean(initialUnlocked));
  const [failure, setFailure] = useState("");

  useEffect(() => {
    callback.current = onUnlocked;
  }, [onUnlocked]);

  useEffect(() => {
    initialUnlockedRef.current = initialUnlocked;
  }, [initialUnlocked]);

  useEffect(() => {
    if (initialUnlocked === undefined) return;
    setUnlockedRecipient(initialUnlocked?.owner ?? null);
    setPublicKey(initialUnlocked?.owner.publicKey ?? null);
    setUnlocked(Boolean(initialUnlocked));
  }, [initialUnlocked]);

  useEffect(() => {
    accountId.current = account.id;
    const currentSession = initialUnlockedRef.current;
    let current = true;
    setLoading(true);
    setVault(null);
    setPending(null);
    setPublicKey(currentSession?.owner.publicKey ?? null);
    setUnlockedRecipient(currentSession?.owner ?? null);
    setPinnedAdmin(null);
    setAdminCandidate(null);
    setUnlocked(Boolean(currentSession));
    setFailure("");
    void Promise.all([
      store.get(account.id),
      account.role === "app_admin"
        ? Promise.resolve(null)
        : store.getPinnedAdminRecipient(account.id),
    ]).then(
      ([stored, pinned]) => {
        if (!current) return;
        setVault(stored);
        setPublicKey(currentSession?.owner.publicKey ?? stored?.recipient ?? null);
        setPinnedAdmin(pinned);
        if (currentSession) {
          const state: EncryptionUnlockState = {
            owner: currentSession.owner,
            adminRecipient:
              account.role === "app_admin"
                ? currentSession.owner.publicKey
                : (pinned?.recipient ?? null),
          };
          callback.current(state);
        }
        setLoading(false);
      },
      () => {
        if (!current) return;
        setFailure(
          "この端末の暗号化設定を読み込めませんでした。ブラウザーの保存領域を確認してください。",
        );
        setLoading(false);
      },
    );
    return () => {
      current = false;
    };
  }, [account.id, account.role, store]);

  const beginSetup = async () => {
    setBusy(true);
    setFailure("");
    try {
      const created = await createRecipientVault(account.id);
      if (accountId.current !== account.id) return;
      setPending({ vault: created.vault, recoveryKey: created.recoveryKey, downloaded: false });
      setPublicKey(created.vault.recipient);
    } catch {
      setFailure(
        "この端末で暗号化鍵を作成できませんでした。ブラウザーを更新して再試行してください。",
      );
    } finally {
      setBusy(false);
    }
  };

  const downloadRecoveryFile = () => {
    if (!pending) return;
    try {
      downloadJson(
        `ncf-recovery-${account.id}.json`,
        recoveryFileJson(account.id, pending.vault, pending.recoveryKey),
      );
      setPending({ ...pending, downloaded: true });
    } catch {
      setFailure("復旧ファイルを作成できませんでした。もう一度お試しください。");
    }
  };

  const downloadPublicKey = () => {
    if (!publicKey) return;
    try {
      downloadJson(`ncf-public-key-${account.id}.json`, publicKeyFileJson(account.id, publicKey));
    } catch {
      setFailure("公開鍵ファイルを作成できませんでした。もう一度お試しください。");
    }
  };

  const importRecoveryFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setFailure("");
    try {
      if (file.size > MAX_ENCRYPTION_FILE_BYTES) throw new Error();
      const imported = parseRecoveryFile(await file.text(), account.id);
      if (pending && !pending.downloaded) throw new Error();
      if (pending && !sameVault(imported.recipientVault, pending.vault)) throw new Error();
      if (vault && !sameVault(imported.recipientVault, vault)) throw new Error();
      const recipient = await unlockRecipientVault(
        imported.recipientVault,
        imported.recoveryKey,
        account.id,
      );
      if (accountId.current !== account.id) return;
      await store.put(account.id, imported.recipientVault);
      setVault(imported.recipientVault);
      setPublicKey(recipient.publicKey);
      setUnlockedRecipient(recipient);
      setPending(null);
      setUnlocked(true);
      callback.current({
        owner: recipient,
        adminRecipient:
          account.role === "app_admin" ? recipient.publicKey : (pinnedAdmin?.recipient ?? null),
      });
    } catch {
      setFailure(
        "復旧ファイルを確認できませんでした。対象アカウント、ファイル内容、復旧鍵を確認してください。秘密値は画面やログに記録しません。",
      );
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const importAdminKeyFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setFailure("");
    try {
      if (file.size > MAX_ENCRYPTION_FILE_BYTES) throw new Error();
      const candidate = await parsePublicKeyFile(await file.text(), account.id);
      if (accountId.current !== account.id) return;
      setAdminCandidate(candidate);
    } catch {
      setFailure(
        "管理者公開鍵ファイルを検証できませんでした。別経路で受け取った正しい公開鍵ファイルを選んでください。",
      );
    } finally {
      setBusy(false);
      if (adminKeyInput.current) adminKeyInput.current.value = "";
    }
  };

  const pinAdminKey = async () => {
    if (!adminCandidate) return;
    setBusy(true);
    setFailure("");
    try {
      await store.pinAdminRecipient(account.id, adminCandidate.accountId, adminCandidate.recipient);
      const pinned = {
        accountId: account.id,
        adminAccountId: adminCandidate.accountId,
        recipient: adminCandidate.recipient,
      };
      setPinnedAdmin(pinned);
      setAdminCandidate(null);
      if (unlockedRecipient) {
        callback.current({ owner: unlockedRecipient, adminRecipient: pinned.recipient });
      }
    } catch {
      setFailure("管理者公開鍵をこの端末に固定できませんでした。保存領域を確認してください。");
    } finally {
      setBusy(false);
    }
  };

  const unpinAdminKey = async () => {
    setBusy(true);
    setFailure("");
    try {
      await store.deletePinnedAdminRecipient(account.id);
      setPinnedAdmin(null);
      setAdminCandidate(null);
      if (unlockedRecipient) callback.current({ owner: unlockedRecipient, adminRecipient: null });
    } catch {
      setFailure("固定した管理者公開鍵を解除できませんでした。保存領域を確認してください。");
    } finally {
      setBusy(false);
    }
  };

  const lock = () => {
    setUnlocked(false);
    setUnlockedRecipient(null);
    callback.current(null);
  };

  return (
    <section className="settings-card" aria-labelledby="encryption-settings-title">
      <div className="settings-card-heading">
        <span className="settings-icon">
          <ShieldCheck size={20} aria-hidden="true" />
        </span>
        <div>
          <h2 id="encryption-settings-title">暗号化鍵の保管</h2>
          <p>復号鍵はこの端末で管理し、サーバーへ送信しません。</p>
        </div>
      </div>
      <p className="muted">
        復旧ファイル自体はパスワード保護されていません。秘密鍵として扱い、このサービスにはアップロードしないでください。端末外に安全に保管し、他人と共有しないでください。紛失すると暗号化したファイルを復号できません。
      </p>
      {failure && (
        <p className="form-error" role="alert">
          {failure}
        </p>
      )}
      {loading ? (
        <p className="muted" role="status">
          <LoaderCircle size={16} className="spin" /> 設定を読み込んでいます
        </p>
      ) : busy ? (
        <p className="muted" role="status">
          <LoaderCircle size={16} className="spin" /> 暗号化鍵を確認しています
        </p>
      ) : unlocked ? (
        <div className="encryption-settings-actions">
          <p role="status">この端末で暗号化鍵を解除しました。</p>
          <p className="muted">
            鍵はこのタブのメモリーだけにあります。他のタブで解除した鍵は、それぞれのタブでロックしてください。
          </p>
          <Button onClick={downloadPublicKey}>
            <Download size={16} />
            公開鍵を保存
          </Button>
          <Button variant="ghost" onClick={lock}>
            このタブでロック
          </Button>
        </div>
      ) : pending ? (
        <div className="encryption-settings-actions">
          <p>まず復旧ファイルを保存し、そのファイルを選んで復旧できることを確認してください。</p>
          <Button onClick={downloadRecoveryFile}>
            <Download size={16} />
            復旧ファイルを保存
          </Button>
          <Button disabled={!pending.downloaded} onClick={() => fileInput.current?.click()}>
            <Upload size={16} />
            保存したファイルを選択
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            hidden
            disabled={!pending.downloaded}
            onChange={(event) => void importRecoveryFile(event.currentTarget.files?.[0])}
          />
        </div>
      ) : vault ? (
        <div className="encryption-settings-actions">
          <p>このアカウントの鍵を保存しています。復旧ファイルを選んで解除してください。</p>
          <Button onClick={downloadPublicKey}>
            <Download size={16} />
            公開鍵を保存
          </Button>
          <Button onClick={() => fileInput.current?.click()}>
            <Upload size={16} />
            復旧ファイルを選択
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(event) => void importRecoveryFile(event.currentTarget.files?.[0])}
          />
        </div>
      ) : (
        <div className="encryption-settings-actions">
          <p>最初に端末内で鍵を作成し、復旧ファイルを保存してから復旧確認を行います。</p>
          <Button disabled={busy} onClick={() => void beginSetup()}>
            <KeyRound size={16} />
            暗号化鍵を作成
          </Button>
          <Button onClick={() => fileInput.current?.click()}>
            <Upload size={16} />
            既存の復旧ファイルから復元
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(event) => void importRecoveryFile(event.currentTarget.files?.[0])}
          />
        </div>
      )}
      {account.role !== "app_admin" && !loading && (
        <div className="encryption-settings-actions" aria-label="管理者公開鍵の固定">
          <h3>管理者の公開鍵</h3>
          <p>
            管理者から別の安全な経路で受け取った公開鍵ファイルを読み込み、表示された指紋を管理者と照合してから固定してください。自動取得は行いません。
          </p>
          {pinnedAdmin ? (
            <p role="status">
              固定中の管理者アカウント: <code>{pinnedAdmin.adminAccountId}</code>
              <br />
              指紋: <code>{pinnedAdmin.recipient.fingerprint}</code>
            </p>
          ) : (
            <p role="status">
              管理者の公開鍵はまだ固定されていません。固定されるまで暗号化アップロードは利用できません。
            </p>
          )}
          {adminCandidate && (
            <div className="notice" role="group" aria-label="未固定の管理者公開鍵候補">
              <span>
                未固定の候補 — アカウント: <code>{adminCandidate.accountId}</code>
                <br />
                指紋: <code>{adminCandidate.recipient.fingerprint}</code>
                <br />
                この指紋を管理者と別経路で照合してください。
              </span>
              <Button disabled={busy} onClick={() => void pinAdminKey()}>
                この公開鍵を固定
              </Button>
            </div>
          )}
          <Button disabled={busy} onClick={() => adminKeyInput.current?.click()}>
            <Upload size={16} />
            管理者公開鍵ファイルを確認
          </Button>
          {pinnedAdmin && (
            <Button disabled={busy} variant="ghost" onClick={() => void unpinAdminKey()}>
              固定を解除
            </Button>
          )}
          <input
            ref={adminKeyInput}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(event) => void importAdminKeyFile(event.currentTarget.files?.[0])}
          />
        </div>
      )}
    </section>
  );
}
