import { createRoot } from "react-dom/client";
import { PublicClient } from "./client";
import { PublicApp } from "./view";
import "./style.css";

// Capture the capability only in memory, before mounting or making any API request.
let fragment = location.hash.slice(1);
history.replaceState(null, "", location.pathname);
const client = new PublicClient(
  location.pathname.split("/")[2]!,
  /^[A-Za-z0-9_-]{43}$/.test(fragment) ? fragment : null,
);
fragment = "";
createRoot(document.getElementById("root")!).render(<PublicApp client={client} />);
