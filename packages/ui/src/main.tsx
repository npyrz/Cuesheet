/**
 * Entry point. `StrictMode` is on deliberately: it double-invokes effects in
 * development, which is exactly the pressure the socket's connect/disconnect
 * path needs — a listener that leaks under StrictMode leaks in production too.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("index.html is missing #root");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
