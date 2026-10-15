/** Bad arguments, or an unknown/ambiguous version. Maps to exit code 2. */
export class VcsUsageError extends Error {
  readonly exitCode = 2;
  constructor(message: string) {
    super(message);
    this.name = "VcsUsageError";
  }
}

/** A safety rule refused the request (unsaved changes, nothing to restore, ...). Maps to exit code 1. */
export class VcsRefusedError extends Error {
  readonly exitCode = 1;
  constructor(message: string) {
    super(message);
    this.name = "VcsRefusedError";
  }
}

export type CommitFailureCause = "signing" | "hook" | "other";

/** Git rejected the commit. The message names the cause in plain language. Maps to exit code 1. */
export class VcsCommitFailedError extends Error {
  readonly exitCode = 1;
  constructor(
    message: string,
    readonly reason: CommitFailureCause,
  ) {
    super(message);
    this.name = "VcsCommitFailedError";
  }
}

const SIGNING = /gpg failed to sign|cannot run gpg|failed to sign the data|ssh-keygen|couldn't load public key|no secret key|signing (failed|error)/i;
const HOOK = /hook/i;

/** Git's own stderr when the executor kept it, else the error message without execFile's `Command failed:` line. */
export function stderrOf(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const stderr = (err as { stderr?: unknown }).stderr;
    if (typeof stderr === "string" && stderr.trim() !== "") return stderr;
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string") return message.replace(/^Command failed:[^\n]*\n?/, "");
  }
  return String(err);
}

export function firstLine(text: string): string {
  return text.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
}

export function classifyCommitFailure(err: unknown): VcsCommitFailedError {
  const stderr = stderrOf(err);
  const line = firstLine(stderr);
  if (SIGNING.test(stderr)) {
    return new VcsCommitFailedError(
      `Saving failed because your git setup signs versions and signing failed: ${line}`,
      "signing",
    );
  }
  if (HOOK.test(stderr)) {
    return new VcsCommitFailedError(`Saving failed because a git hook rejected it: ${line}`, "hook");
  }
  return new VcsCommitFailedError(`Saving failed: ${line}`, "other");
}
