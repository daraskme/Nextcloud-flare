/** Explicit operator destination only. No redirects, provider bodies, or raw transport errors. */
export function backupNotifier(environment, fetcher = fetch) {
  let url;
  const token = environment.NCF_BACKUP_NOTIFY_TOKEN;
  try {
    url = new URL(environment.NCF_BACKUP_NOTIFY_URL);
  } catch {
    throw new Error("backup_monitor_unconfigured");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    typeof token !== "string" ||
    token.length < 16 ||
    token.length > 4096 ||
    !/^[\x21-\x7e]+$/.test(token)
  )
    throw new Error("backup_monitor_unconfigured");
  return async (event) => {
    const controller = new AbortController();
    let timer;
    try {
      const response = await Promise.race([
        fetcher(url, {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
            "idempotency-key": event.id,
          },
          body: JSON.stringify(event),
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("backup_monitor_delivery_failed"));
          }, 10000);
        }),
      ]);
      // Do not read or log arbitrary provider responses. Cancel without extending the acknowledgement deadline.
      void response.body?.cancel().catch(() => {});
      if (!response.ok) throw new Error("backup_monitor_delivery_failed");
    } catch {
      throw new Error("backup_monitor_delivery_failed");
    } finally {
      clearTimeout(timer);
    }
  };
}
