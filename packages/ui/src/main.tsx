/**
 * Entry point. `StrictMode` is on deliberately: it double-invokes effects in
 * development, which is exactly the pressure the socket's connect/disconnect
 * path needs — a listener that leaks under StrictMode leaks in production too.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { Pocket } from "./components/Pocket.js";
import { pairingToken } from "./pocket.js";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("index.html is missing #root");

const pocket = location.pathname === "/pocket";
const invitation = pocket ? pairingToken(location.hash) : null;
// Consume the fragment once, before StrictMode can run any effects twice.
if (pocket && location.hash) history.replaceState(null, "", location.pathname);

createRoot(container).render(
  <StrictMode>
    {pocket ? <Pocket invitation={invitation} /> : <App />}
  </StrictMode>,
);
