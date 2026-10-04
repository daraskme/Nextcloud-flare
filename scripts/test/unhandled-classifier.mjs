const networkLoss =
  "uncaught exception; source = Uncaught (in promise); stack = Error: Network connection lost.";
/** The sole platform exception is confined to the isolated real-R2 short-body test process. */
export function createUnhandledClassifier(shortBody) {
  let expectedDisconnects = 0;
  let unhandled = 0;
  return {
    inspect(line) {
      const value = line.trimEnd();
      // Workerd also prints `exception = ...` for handled stream cancellation.
      // Only its explicit uncaught-in-promise marker is a rejection signal.
      if (value === networkLoss && shortBody && expectedDisconnects < 2) {
        expectedDisconnects++;
      } else if (/uncaught exception; source = Uncaught \(in promise\)/i.test(value)) {
        unhandled++;
      }
    },
    get expectedDisconnects() {
      return expectedDisconnects;
    },
    get unhandled() {
      return unhandled;
    },
  };
}
