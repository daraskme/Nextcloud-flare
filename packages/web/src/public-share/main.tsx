import { createRoot } from "react-dom/client";
import { PublicClient } from "./client";
import { PublicApp } from "./view";
import "./style.css";

const root = createRoot(document.getElementById("root")!);
let client: PublicClient | undefined;
let generation = 0;
function openLink() {
  // Same-document navigation can supply another capability without reloading the page.
  let fragment = location.hash.slice(1);
  history.replaceState(null, "", location.pathname);
  client?.close();
  client = new PublicClient(
    location.pathname.split("/")[2]!,
    /^[A-Za-z0-9_-]{43}$/.test(fragment) ? fragment : null,
  );
  fragment = "";
  root.render(<PublicApp key={++generation} client={client} />);
}
openLink();
addEventListener("hashchange", () => {
  // Ignore an already-consumed hash if rapid navigations queued multiple events.
  if (location.hash) openLink();
});
