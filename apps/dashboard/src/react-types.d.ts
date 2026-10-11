// Type declarations for the parts of React 19 the dashboard uses. React ships no types, and
// `@types/react` is not in the setup inventory, so this file declares the few APIs the dashboard
// calls. Add an API here when a page starts using it.

declare module "react" {
  /** An element React rendered from JSX; opaque to the dashboard. */
  export interface ReactElement {
    readonly type: unknown;
    readonly props: unknown;
    readonly key: string | null;
  }
  export type ReactNode = ReactElement | string | number | bigint | boolean | null | undefined | Iterable<ReactNode>;
  export type SetStateAction<S> = S | ((previous: S) => S);

  export function useState<S>(initial: S | (() => S)): [S, (action: SetStateAction<S>) => void];
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  export function useCallback<T extends (...args: never[]) => unknown>(callback: T, deps: readonly unknown[]): T;
  export function StrictMode(props: { children?: ReactNode }): ReactElement;
}

declare module "react/jsx-runtime" {
  import type { ReactElement, ReactNode } from "react";

  /** Props of an HTML element; React passes a synthetic event with the DOM event's fields. */
  interface IntrinsicProps {
    readonly children?: ReactNode;
    readonly className?: string;
    readonly onClick?: (event: MouseEvent) => void;
    readonly [attribute: string]: unknown;
  }

  export namespace JSX {
    type Element = ReactElement;
    type ElementType = string | ((props: never) => ReactNode);
    interface ElementChildrenAttribute {
      children: object;
    }
    interface IntrinsicAttributes {
      key?: string | number;
    }
    interface IntrinsicElements {
      [tag: string]: IntrinsicProps;
    }
  }

  export function jsx(type: unknown, props: unknown, key?: string): ReactElement;
  export function jsxs(type: unknown, props: unknown, key?: string): ReactElement;
  export const Fragment: unique symbol;
}

declare module "react-dom/client" {
  import type { ReactNode } from "react";

  export interface Root {
    render(children: ReactNode): void;
    unmount(): void;
  }
  export function createRoot(container: Element): Root;
}
