/** The few Node globals the scripts use; avoids pulling @types/node into the Worker's type space. */
declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exitCode?: number;
};

declare module "node:fs/promises" {
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  export function writeFile(path: string, data: string): Promise<void>;
  export function mkdir(path: string, options: { recursive: true }): Promise<unknown>;
}
