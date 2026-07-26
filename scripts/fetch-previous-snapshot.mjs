#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { validateSnapshot } from "./weather-core.mjs";

const [url, output = "data/previous-daily-snapshot.json"] = process.argv.slice(2);
if (!url) {
  process.stderr.write("Usage: fetch-previous-snapshot.mjs URL [OUTPUT]\n");
  process.exit(2);
}

async function main() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      process.stdout.write(`No prior deployed snapshot available (HTTP ${response.status}).\n`);
      return;
    }
    const snapshot = await response.json();
    validateSnapshot(snapshot);
    const outputPath = resolve(output);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    process.stdout.write(`Downloaded prior deployed snapshot to ${output}.\n`);
  } catch (error) {
    process.stdout.write(`Prior snapshot unavailable: ${error.message}\n`);
  } finally {
    clearTimeout(timer);
  }
}

await main();
