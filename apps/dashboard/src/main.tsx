import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app.tsx";
import { holdTransitionsOnThemeSwitch } from "./motion.tsx";

const container = document.getElementById("root");
if (container === null) throw new Error("index.html has no #root element");
holdTransitionsOnThemeSwitch();
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
