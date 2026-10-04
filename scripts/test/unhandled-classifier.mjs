const networkLoss =
  "uncaught exception; source = Uncaught (in promise); stack = Error: Network connection lost.";
const shortBodyNative =
  /^exception = kj\/async-io\.c\+\+:[0-9]+: disconnected: fixed-length pipe ended prematurely$/;

/** The sole platform exception is confined to the isolated real-R2 short-body test process. */
export function createUnhandledClassifier(shortBody) {
  let expectedDisconnects = 0;
  let unhandled = 0;
  return {
    inspect(line) {
      const value = line.trimEnd();
      if (shortBody && shortBodyNative.test(value)) return;
      if (shortBody && value.startsWith("stack:")) return;
      if (value === networkLoss && shortBody && expectedDisconnects < 2) {
        expectedDisconnects++;
      } else if (
        /uncaught exception; source = Uncaught \(in promise\)/i.test(value) ||
        value.startsWith("exception = ")
      ) {
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
