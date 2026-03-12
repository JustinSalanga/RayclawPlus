/// <reference types="vite/client" />

declare module "react-syntax-highlighter" {
  import type { ComponentType } from "react";
  export const Prism: ComponentType<{
    language: string;
    style?: Record<string, unknown>;
    PreTag?: keyof JSX.IntrinsicElements;
    codeTagProps?: { style?: Record<string, unknown> };
    customStyle?: Record<string, unknown>;
    className?: string;
    showLineNumbers?: boolean;
    children?: string;
  }>;
}

declare module "react-syntax-highlighter/dist/esm/styles/prism/one-dark" {
  const style: Record<string, unknown>;
  export default style;
}
