// Types for the two react-dom APIs the dashboard calls. `@types/react` covers React itself;
// `@types/react-dom` is not an approved dependency, so `createRoot` and `createPortal` are declared
// here.

declare module "react-dom/client" {
  import type { ReactNode } from "react";

  export interface Root {
    render(children: ReactNode): void;
    unmount(): void;
  }
  export function createRoot(container: Element): Root;
}

declare module "react-dom" {
  import type { ReactNode, ReactPortal } from "react";

  export function createPortal(children: ReactNode, container: Element): ReactPortal;
}
