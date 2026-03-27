import fs from "node:fs";
import readline from "node:readline/promises";

export type TtyContext = {
  inputFd: number;
  outputFd: number;
};

export function openTty(): TtyContext | null {
  try {
    const inputFd = fs.openSync("/dev/tty", "r");
    const outputFd = fs.openSync("/dev/tty", "w");
    return { inputFd, outputFd };
  } catch {
    return null;
  }
}

export function closeTty(tty: TtyContext | null): void {
  if (!tty) {
    return;
  }
  try {
    fs.closeSync(tty.inputFd);
  } catch {
    // ignore close errors
  }
  try {
    fs.closeSync(tty.outputFd);
  } catch {
    // ignore close errors
  }
}

export async function promptRetry(tty: TtyContext): Promise<boolean> {
  const input = fs.createReadStream("", { fd: tty.inputFd, autoClose: false });
  const output = fs.createWriteStream("", { fd: tty.outputFd, autoClose: false });
  const rl = readline.createInterface({ input, output });

  try {
    const answer = (await rl.question("rsync failed. Retry? [Y/n]: ")).trim().toLowerCase();
    if (answer === "" || answer === "y" || answer === "yes") {
      return true;
    }
    return false;
  } finally {
    rl.close();
    input.destroy();
    output.destroy();
  }
}
