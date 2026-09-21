import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "./App";
import "./styles.css";

const root = document.querySelector<HTMLElement>("#root");
if (root === null) {
  throw new Error("Application root is missing");
}
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
