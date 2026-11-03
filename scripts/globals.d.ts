/** The few Node globals the scripts use; avoids pulling @types/node into the Worker's type space. */
declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exitCode?: number;
};
