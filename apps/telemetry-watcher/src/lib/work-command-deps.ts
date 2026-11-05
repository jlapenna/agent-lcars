export interface WorkCommandDeps {
  runId?: string;
  runToken?: string;
  fetchImpl: typeof fetch;
  token: () => Promise<string>;
  origin: string;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}
