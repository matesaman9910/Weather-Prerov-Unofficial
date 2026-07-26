import test from "node:test";
import assert from "node:assert/strict";
import {
  filterRegionItems,
  mapSeverity,
  normalizeRegion,
  parseFeed,
  rank,
} from "../worker/worker.js";

function entry({
  id,
  title,
  area,
  code,
  severity = "Moderate",
  onset = "2026-07-26T10:00:00+00:00",
  expires = "2026-07-26T18:00:00+00:00",
}) {
  return `
    <entry>
      <id>${id}</id>
      <title>${title}</title>
      <cap:event>Rain &amp; flooding</cap:event>
      <cap:severity>${severity}</cap:severity>
      <cap:onset>${onset}</cap:onset>
      <cap:expires>${expires}</cap:expires>
      <cap:areaDesc>${area}</cap:areaDesc>
      <cap:geocode>
        <cap:valueName>EMMA_ID</cap:valueName>
        <cap:value>${code}</cap:value>
      </cap:geocode>
    </entry>`;
}

const feed = `
  <feed xmlns="http://www.w3.org/2005/Atom" xmlns:cap="urn:oasis:names:tc:emergency:cap:1.2">
    ${entry({
      id: "ol-1",
      title: "Yellow Rain Warning - Olomoucký kraj (Přerov)",
      area: "Olomoucký kraj (Přerov)",
      code: "CZ07108",
    })}
    ${entry({
      id: "ol-2",
      title: "Yellow Rain Warning - Olomoucký kraj (Přerov)",
      area: "Olomoucký kraj (Přerov)",
      code: "CZ07109",
    })}
    ${entry({
      id: "pa-1",
      title: "Orange Wind Warning - Pardubický kraj",
      area: "Pardubický kraj",
      code: "CZ05303",
      severity: "Severe",
    })}
    ${entry({
      id: "ol-expired",
      title: "Red Warning - Olomoucký kraj",
      area: "Olomoucký kraj",
      code: "CZ07101",
      severity: "Extreme",
      expires: "2026-07-26T09:00:00+00:00",
    })}
  </feed>`;

test("Worker parser extracts structured CAP area and geocode data", () => {
  const parsed = parseFeed(feed);
  assert.equal(parsed.length, 4);
  assert.equal(parsed[0].area, "Olomoucký kraj (Přerov)");
  assert.deepEqual(parsed[0].geocodes, [{ name: "EMMA_ID", value: "CZ07108" }]);
  assert.equal(parsed[0].event, "Rain & flooding");
  assert.equal(parsed[2].level, "orange");
});

test("Worker strictly filters Olomouc geocodes, removes expired entries, and deduplicates", () => {
  const filtered = filterRegionItems(
    parseFeed(feed),
    "olomoucky",
    new Date("2026-07-26T12:00:00Z"),
  );
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].region, "olomoucky");
  assert.equal(filtered[0].regionVerified, true);
  assert.match(filtered[0].title, /Olomoucký/);
});

test("Worker never falls back to nationwide alerts when a region has no matches", () => {
  const filtered = filterRegionItems(
    parseFeed(feed),
    "zlinsky",
    new Date("2026-07-26T12:00:00Z"),
  );
  assert.deepEqual(filtered, []);
});

test("Worker normalizes region aliases and ranks severity", () => {
  assert.equal(normalizeRegion("Olomoucký kraj"), "olomoucky");
  assert.equal(normalizeRegion("Prague"), "praha");
  assert.equal(mapSeverity("Extreme"), "red");
  assert.equal(rank(["yellow", "red", "orange"]), "red");
  assert.equal(rank([]), "green");
});

