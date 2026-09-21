import type { UploadInfo } from "@ncf/shared";
import { Check, FileUp, LoaderCircle, Upload, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { t } from "../../i18n";
import { api, ApiError } from "../../lib/api";
import { fileFingerprint, loadResume, removeResume, saveResume } from "./resume";

interface UploadTask {
  key: string;
  fingerprint: string;
  name: string;
  progress: number;
  state: "uploading" | "completed" | "failed" | "conflict" | "skipped";
  error?: string;
  upload?: UploadInfo;
  conflict?: { existingNodeId: string; revision: number };
}

interface UploadManagerProps {
  parentId: string;
  onCompleted: () => void;
}

const PART_SIZE = 8 * 1024 * 1024;

export function UploadManager({ parentId, onCompleted }: UploadManagerProps): React.JSX.Element {
  const input = useRef<HTMLInputElement>(null);
  const [tasks, setTasks] = useState<UploadTask[]>([]);
  const [dragging, setDragging] = useState(false);

  const update = (key: string, patch: Partial<UploadTask>) => {
    setTasks((current) => current.map((task) => (task.key === key ? { ...task, ...patch } : task)));
  };

  const uploadFile = async (file: File) => {
    const fingerprint = await fileFingerprint(file);
    const key = `${fingerprint}:${parentId}`;
    setTasks((current) => [
      ...current.filter((task) => task.key !== key),
      { key, fingerprint, name: file.name, progress: 0, state: "uploading" },
    ]);
    try {
      const saved = await loadResume(fingerprint);
      let upload: UploadInfo;
      if (saved !== null && saved.parentId === parentId && saved.expiresAt > Date.now()) {
        upload = await api.uploadStatus(saved.uploadId, saved.capability);
        upload = { ...upload, capability: saved.capability };
      } else {
        upload = await api.createUpload(
          parentId,
          file.name,
          file.size,
          file.size <= PART_SIZE ? "single" : "multipart",
        );
        if (upload.capability === undefined) throw new Error("Upload capability was not returned");
        await saveResume({
          fingerprint,
          uploadId: upload.id,
          capability: upload.capability,
          parentId,
          name: file.name,
          size: file.size,
          lastModified: file.lastModified,
          expiresAt: upload.expiresAt,
        });
      }
      if (upload.capability === undefined) throw new Error("Upload cannot be resumed");
      update(key, { upload });
      if (upload.mode === "single") {
        if (upload.state === "created") {
          await api.putSingle(upload.id, upload.capability, file);
        }
        update(key, { progress: 0.92 });
      } else {
        const stored = new Set(upload.parts.map((part) => part.partNumber));
        const partCount = Math.ceil(file.size / upload.partSize);
        let completedBytes = upload.parts.reduce((sum, part) => sum + part.size, 0);
        update(key, { progress: completedBytes / file.size });
        for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
          if (stored.has(partNumber)) continue;
          const offset = (partNumber - 1) * upload.partSize;
          const part = file.slice(offset, Math.min(file.size, offset + upload.partSize));
          await api.putPart(upload.id, upload.capability, partNumber, part);
          completedBytes += part.size;
          update(key, { progress: completedBytes / file.size });
        }
      }
      await api.completeUpload(upload.id, upload.capability);
      await removeResume(fingerprint);
      update(key, { progress: 1, state: "completed" });
      onCompleted();
    } catch (cause) {
      if (
        cause instanceof ApiError &&
        cause.code === "name_conflict" &&
        cause.existingNodeId !== undefined &&
        cause.revision !== undefined
      ) {
        update(key, {
          state: "conflict",
          progress: 0.92,
          conflict: { existingNodeId: cause.existingNodeId, revision: cause.revision },
        });
      } else {
        update(key, {
          state: "failed",
          error: cause instanceof Error ? cause.message : t("upload.failed"),
        });
      }
    }
  };

  const resolveConflict = async (task: UploadTask, mode: "overwrite" | "rename" | "skip") => {
    if (task.upload?.capability === undefined || task.conflict === undefined) return;
    update(task.key, { state: "uploading" });
    try {
      if (mode === "skip") {
        await api.abortUpload(task.upload.id, task.upload.capability);
        await removeResume(task.fingerprint);
        update(task.key, { state: "skipped", progress: 1 });
        return;
      }
      await api.completeUpload(
        task.upload.id,
        task.upload.capability,
        mode === "overwrite"
          ? { mode, expectedRevision: task.conflict.revision }
          : { mode: "rename" },
      );
      await removeResume(task.fingerprint);
      update(task.key, { state: "completed", progress: 1 });
      onCompleted();
    } catch (cause) {
      update(task.key, {
        state: "failed",
        error: cause instanceof Error ? cause.message : t("upload.resolveFailed"),
      });
    }
  };

  const select = (files: FileList | File[]) => {
    void (async () => {
      for (const file of Array.from(files)) await uploadFile(file);
    })();
  };

  useEffect(() => {
    const open = () => input.current?.click();
    const enter = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes("Files")) {
        event.preventDefault();
        setDragging(true);
      }
    };
    const over = (event: DragEvent) => event.preventDefault();
    const leave = (event: DragEvent) => {
      if (event.relatedTarget === null) setDragging(false);
    };
    const drop = (event: DragEvent) => {
      event.preventDefault();
      setDragging(false);
      if (event.dataTransfer?.files !== undefined) select(event.dataTransfer.files);
    };
    window.addEventListener("ncf-upload", open);
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("ncf-upload", open);
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [parentId]);

  const conflictTask = tasks.find((task) => task.state === "conflict");

  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          if (event.target.files !== null) select(event.target.files);
          event.target.value = "";
        }}
      />
      {conflictTask !== undefined && (
        <div className="fixed inset-0 z-[80] grid place-items-center bg-[var(--overlay)] p-4 backdrop-blur-sm">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="upload-conflict-title"
            className="w-full max-w-lg rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-2xl"
          >
            <h2 id="upload-conflict-title" className="text-lg font-semibold text-[var(--fg)]">
              {t("upload.conflictTitle")}
            </h2>
            <p className="mt-2 text-sm text-[var(--fg-muted)]">
              「{conflictTask.name}」— {t("upload.conflictBody")}
            </p>
            <div className="mt-6 grid gap-2">
              <button
                className="primary-button justify-center"
                onClick={() => void resolveConflict(conflictTask, "overwrite")}
              >
                {t("upload.overwrite")}
              </button>
              <button
                className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-[var(--fg)] transition hover:bg-white/5"
                onClick={() => void resolveConflict(conflictTask, "rename")}
              >
                {t("upload.keepBoth")}
              </button>
              <button
                className="rounded-xl px-4 py-2.5 text-sm text-slate-400 transition hover:bg-white/5 hover:text-[var(--fg)]"
                onClick={() => void resolveConflict(conflictTask, "skip")}
              >
                {t("upload.skip")}
              </button>
            </div>
          </section>
        </div>
      )}
      {dragging && (
        <div className="fixed inset-4 z-[70] grid place-items-center rounded-3xl border-2 border-dashed border-[var(--accent)] bg-[var(--overlay)] text-[var(--overlay-fg)] backdrop-blur-xl">
          <div className="text-center">
            <div className="mx-auto grid h-20 w-20 place-items-center rounded-3xl bg-sky-400/15">
              <FileUp className="h-9 w-9 text-sky-300" />
            </div>
            <p className="mt-5 text-xl font-semibold text-[var(--overlay-fg)]">
              {t("upload.dropTitle")}
            </p>
            <p className="mt-2 text-sm text-[var(--overlay-fg)]/80">{t("upload.dropBody")}</p>
          </div>
        </div>
      )}
      {tasks.length > 0 && (
        <aside className="fixed bottom-5 right-5 z-50 w-[min(380px,calc(100vw-2.5rem))] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl backdrop-blur-xl">
          <header className="flex items-center justify-between border-b border-white/10 px-4 py-3">
            <span className="flex items-center gap-2 text-sm font-medium text-[var(--fg)]">
              <Upload className="h-4 w-4 text-[var(--accent)]" /> {t("upload.title")}
            </span>
            <button
              className="text-[var(--fg-muted)] hover:text-[var(--fg)]"
              onClick={() => setTasks([])}
            >
              <X className="h-4 w-4" />
            </button>
          </header>
          <div className="max-h-72 space-y-1 overflow-auto p-2">
            {tasks.map((task) => (
              <div key={task.key} className="rounded-xl px-3 py-2.5 hover:bg-white/[0.04]">
                <div className="flex items-center gap-3">
                  {task.state === "completed" || task.state === "skipped" ? (
                    <Check className="h-4 w-4 text-emerald-400" />
                  ) : task.state === "uploading" ? (
                    <LoaderCircle className="h-4 w-4 animate-spin text-sky-400" />
                  ) : task.state === "conflict" ? (
                    <FileUp className="h-4 w-4 text-amber-400" />
                  ) : (
                    <X className="h-4 w-4 text-rose-400" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm text-[var(--fg)]">
                    {task.name}
                  </span>
                  <span className="text-xs tabular-nums text-[var(--fg-muted)]">
                    {Math.round(task.progress * 100)}%
                  </span>
                </div>
                <div className="ml-7 mt-2 h-1 overflow-hidden rounded-full bg-white/10">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${task.state === "failed" ? "bg-rose-400" : "bg-sky-400"}`}
                    style={{ width: `${Math.max(2, task.progress * 100)}%` }}
                  />
                </div>
                {task.error !== undefined && (
                  <p className="ml-7 mt-1.5 text-xs text-rose-300">{task.error}</p>
                )}
              </div>
            ))}
          </div>
        </aside>
      )}
    </>
  );
}
