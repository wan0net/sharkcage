/**
 * Prefixes each line of a child process's stdout/stderr with a colored tag.
 * Used by `sc start` to distinguish supervisor, openclaw, and proxy output.
 */

import type { ChildProcess } from "node:child_process";

// ANSI color codes
const COLORS: Record<string, string> = {
  supervisor: "\x1b[36m",  // cyan
  openclaw:   "\x1b[35m",  // magenta
  proxy:      "\x1b[33m",  // yellow
  plugin:     "\x1b[32m",  // green
  audit:      "\x1b[90m",  // gray
  sc:         "\x1b[34m",  // blue
};
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

export function prefixOutput(proc: ChildProcess, tag: string): void {
  const color = COLORS[tag] ?? "\x1b[37m"; // default white
  const prefix = `${color}[${tag}]${RESET} `;

  const prefixStream = (stream: NodeJS.ReadableStream | null, target: NodeJS.WritableStream) => {
    if (!stream) return;
    let buffer = "";
    stream.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.trim()) {
          target.write(`${prefix}${line}\n`);
        }
      }
    });
    stream.on("end", () => {
      if (buffer.trim()) {
        target.write(`${prefix}${buffer}\n`);
      }
    });
  };

  prefixStream(proc.stdout, process.stdout);
  prefixStream(proc.stderr, process.stderr);
}

/** Log a message with a colored tag prefix (for sc start's own messages) */
export function log(tag: string, msg: string): void {
  const color = COLORS[tag] ?? "\x1b[37m";
  console.log(`${color}[${tag}]${RESET} ${msg}`);
}

/** Log a dim/secondary message */
export function logDim(tag: string, msg: string): void {
  const color = COLORS[tag] ?? "\x1b[37m";
  console.log(`${color}[${tag}]${RESET} ${DIM}${msg}${RESET}`);
}
