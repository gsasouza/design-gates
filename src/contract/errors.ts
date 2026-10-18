/** A contract file that is missing, unreadable or malformed; the message names the file. The check CLI turns it into a UsageError. */
export class ContractLoadError extends Error {
  readonly file: string;
  constructor(file: string, reason: string) {
    super(`${file}: ${reason}`);
    this.name = "ContractLoadError";
    this.file = file;
  }
}
