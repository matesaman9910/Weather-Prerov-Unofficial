#!/usr/bin/env node
import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const output = resolve(process.argv[2] || "_site");
const root = resolve(".");
if (output === root || !output.startsWith(`${root}\\`) && !output.startsWith(`${root}/`)) {
  throw new Error("Output directory must be inside the project");
}

await rm(output, { recursive: true, force: true });
await mkdir(resolve(output, "scripts"), { recursive: true });
await mkdir(resolve(output, "data"), { recursive: true });

for (const file of ["index.html", "Weather.html", "README.md"]) {
  await cp(resolve(file), resolve(output, file));
}
for (const file of ["app.mjs", "weather-core.mjs", "suncalc-loader.mjs"]) {
  await cp(resolve("scripts", file), resolve(output, "scripts", file));
}
await cp(
  resolve("data", "daily-snapshot.json"),
  resolve(output, "data", "daily-snapshot.json"),
);

process.stdout.write(`Prepared static Pages artifact at ${output}\n`);
