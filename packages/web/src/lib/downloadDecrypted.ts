import { saveClientMedia } from "./clientMediaRegistration";

export async function downloadDecrypted(url: string, name: string, size: number) {
  if (size > 64 * 1024 * 1024) {
    const picker = (
      window as Window & {
        showSaveFilePicker?: (options: { suggestedName: string }) => Promise<FileSystemFileHandle>;
      }
    ).showSaveFilePicker;
    if (!picker)
      throw new Error("大きなファイルの保存には、保存先を選択できるChromeなどを利用してください。");
    const handle = await picker({ suggestedName: name });
    const destination = await handle.createWritable();
    await saveClientMedia(url, size, {
      write: (bytes) => destination.write(new Uint8Array(bytes)),
      close: () => destination.close(),
      abort: (reason) => destination.abort(reason),
    });
    return;
  }
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  await saveClientMedia(url, size, {
    async write(bytes) {
      chunks.push(new Uint8Array(bytes));
    },
    async close() {},
    async abort() {
      chunks.length = 0;
    },
  });
  const objectUrl = URL.createObjectURL(new Blob(chunks, { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}
