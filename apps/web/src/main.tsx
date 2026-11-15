// Must run first: see zod-jitless.ts (strict CSP, decision 0017).
import "./zod-jitless";
import "./index.css";
import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createQueryClient } from "./queries";

const root = document.getElementById("root");
if (root === null) throw new Error("#root is missing from index.html");
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={createQueryClient()}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
