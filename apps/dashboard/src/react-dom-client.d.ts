// Types for the one react-dom API the dashboard calls. `@types/react` covers React itself;
// `@types/react-dom` is not an approved dependency, so `createRoot` is declared here.

declare module "react-dom/client" {
  import type { ReactNode } from "react";

  export interface Root {
    render(children: ReactNode): void;
    unmount(): void;
  }
  export function createRoot(container: Element): Root;
}
