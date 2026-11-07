// Laptop A in one command: the hub (with .env.local) and Laptop A's actors.
//   npm run a
import { spawn } from "node:child_process";

const kids = [
  { name: "hub", args: ["--env-file-if-exists=.env.local", "src/net/hub.ts"] },
  { name: "A  ", args: ["src/live/laptop.ts", "A"] },
].map(({ name, args }, i) => {
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  const prefix = (chunk: Buffer) =>
    String(chunk)
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach((line) => console.log(`[${name}] ${line}`));
  child.stdout.on("data", prefix);
  child.stderr.on("data", prefix);
  child.on("exit", (code) => console.log(`[${name}] exited (${code})`));
  void i;
  return child;
});

const stop = () => {
  for (const k of kids) k.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
console.log("Laptop A running. Open http://localhost:8080/ for HQ. Ctrl+C stops both.");
