#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  CITY,
  createDailySnapshot,
  validateSnapshot,
} from "./weather-core.mjs";

function parseArguments(argv) {
  const options = {
    output: "data/daily-snapshot.json",
    previous: null,
    input: null,
    now: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!["--output", "--previous", "--input", "--now"].includes(key)) {
      throw new TypeError(`Unknown argument: ${key}`);
    }
    const value = argv[index + 1];
    if (!value) throw new TypeError(`Missing value for ${key}`);
    options[key.slice(2)] = value;
    index += 1;
  }
  return options;
}

function forecastUrl() {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.search = new URLSearchParams({
    latitude: String(CITY.latitude),
    longitude: String(CITY.longitude),
    timezone: CITY.timezone,
    forecast_days: "7",
    hourly: [
      "precipitation_probability",
      "precipitation",
      "rain",
      "showers",
    ].join(","),
    daily: [
      "weather_code",
      "precipitation_sum",
      "precipitation_probability_max",
    ].join(","),
  });
  return url;
}

async function fetchJsonWithRetry(url, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Open-Meteo returned HTTP ${response.status}`);
      const data = await response.json();
      if (data?.error) throw new Error(`Open-Meteo error: ${data.reason || "unknown"}`);
      return data;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 600 * (attempt + 1)));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

async function readJson(path) {
  return JSON.parse(await readFile(resolve(path), "utf8"));
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const now = options.now ? new Date(options.now) : new Date();
  if (!Number.isFinite(now.getTime())) throw new TypeError(`Invalid --now value: ${options.now}`);

  const forecast = options.input
    ? await readJson(options.input)
    : await fetchJsonWithRetry(forecastUrl());

  let previousSnapshot = null;
  if (options.previous) {
    previousSnapshot = await readJson(options.previous);
    validateSnapshot(previousSnapshot);
  }

  const snapshot = createDailySnapshot(forecast, { now, previousSnapshot });
  validateSnapshot(snapshot);

  const outputPath = resolve(options.output);
  const temporaryPath = `${outputPath}.tmp`;
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  await rename(temporaryPath, outputPath);
  process.stdout.write(
    `Generated ${Object.keys(snapshot.days).length} locked day entries at ${options.output}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
