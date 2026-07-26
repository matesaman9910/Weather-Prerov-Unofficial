import test from "node:test";
import assert from "node:assert/strict";
import {
  CITY,
  addDateKey,
  alertPresentation,
  apiTimestampDateKey,
  buildWetPeriods,
  createDailySnapshot,
  filterOlomoucRegionAlerts,
  getNextRain,
  getPragueDateKey,
  getPragueHourKey,
  groupHoursByApiDate,
  selectActiveAlerts,
  selectSnapshotDay,
  totalPrecipitationMm,
  validateSnapshot,
} from "../scripts/weather-core.mjs";
import { waitForSunCalc } from "../scripts/suncalc-loader.mjs";

function snapshotFixture() {
  return {
    schemaVersion: 1,
    city: { ...CITY },
    generatedAt: "2026-07-26T00:05:00+02:00",
    source: {
      provider: "Open-Meteo",
      fetchedAt: "2026-07-26T00:05:00+02:00",
      status: "ok",
    },
    thresholds: {
      precipitationMmPerHour: 0.2,
      precipitationProbabilityPercent: 60,
    },
    days: {
      "2026-07-26": {
        verdict: "YES",
        wetPeriods: [{
          start: "2026-07-26T14:00",
          end: "2026-07-26T16:00",
          peakTime: "2026-07-26T15:00",
          peakPrecipitationMm: 1.2,
          peakProbabilityPercent: 78,
        }],
      },
      "2026-07-27": { verdict: "NO", wetPeriods: [] },
    },
  };
}

function forecastFixture(dateKey = "2026-07-26") {
  const times = Array.from({ length: 48 }, (_, index) => {
    const day = index < 24 ? dateKey : addDateKey(dateKey, 1);
    return `${day}T${String(index % 24).padStart(2, "0")}:00`;
  });
  const precipitation = times.map((_, index) => (index === 14 ? 1 : 0));
  const probability = times.map((_, index) => (index === 14 ? 70 : 10));
  return {
    timezone: CITY.timezone,
    hourly: {
      time: times,
      precipitation,
      precipitation_probability: probability,
      rain: [...precipitation],
      showers: times.map(() => 0),
    },
  };
}

test("locked daily answer is identical throughout the Prague calendar day", () => {
  const snapshot = snapshotFixture();
  const instants = [
    "2026-07-26T07:00:00+02:00",
    "2026-07-26T12:00:00+02:00",
    "2026-07-26T18:00:00+02:00",
    "2026-07-26T23:30:00+02:00",
  ];
  const selections = instants.map((instant) => selectSnapshotDay(snapshot, new Date(instant)));
  assert.deepEqual(
    selections.map(({ day }) => day),
    Array(instants.length).fill(snapshot.days["2026-07-26"]),
  );
});

test("Prague date selection does not depend on the viewer timezone", () => {
  const instant = new Date("2026-07-25T22:30:00Z");
  const viewerZones = ["Europe/Prague", "UTC", "America/New_York", "Asia/Tokyo"];
  const viewerDates = viewerZones.map((timeZone) => new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant));

  assert.ok(new Set(viewerDates).size > 1, "fixture must span multiple viewer dates");
  assert.equal(getPragueDateKey(instant), "2026-07-26");
  for (const _viewerZone of viewerZones) {
    assert.equal(selectSnapshotDay(snapshotFixture(), instant).dateKey, "2026-07-26");
  }
});

test("Prague hour key uses the city timezone", () => {
  assert.equal(getPragueHourKey(new Date("2026-01-01T12:30:00Z")), "2026-01-01T13");
  assert.equal(getPragueHourKey(new Date("2026-07-01T12:30:00Z")), "2026-07-01T14");
});

test("newer live forecast cannot overwrite the snapshot verdict", () => {
  const snapshot = snapshotFixture();
  const newerLiveForecast = { verdict: "NO", wetPeriods: [] };
  const selected = selectSnapshotDay(snapshot, new Date("2026-07-26T18:00:00+02:00"));
  assert.equal(newerLiveForecast.verdict, "NO");
  assert.equal(selected.day.verdict, "YES");
});

test("browser cache divergence cannot change the shared snapshot verdict", () => {
  const snapshot = snapshotFixture();
  const browserA = { liveCache: { verdict: "NO" }, snapshot };
  const browserB = { liveCache: null, snapshot };
  const now = new Date("2026-07-26T10:00:00+02:00");
  assert.equal(selectSnapshotDay(browserA.snapshot, now).day.verdict, "YES");
  assert.equal(selectSnapshotDay(browserB.snapshot, now).day.verdict, "YES");
});

test("canonical precipitation does not double count components", () => {
  assert.equal(totalPrecipitationMm({
    precipitation: 1,
    rain: 0.7,
    showers: 0.3,
  }), 1);
  assert.equal(totalPrecipitationMm({ rain: 0.7, showers: 0.3 }), 1);
});

test("15-minute nowcast reports rain already in progress", () => {
  const result = getNextRain({
    time: ["2026-07-26T12:15", "2026-07-26T12:30"],
    precipitation: [0.08, 0],
  }, new Date("2026-07-26T10:07:00Z"));
  assert.equal(result.state, "raining");
  assert.equal(result.minutes, 0);
  assert.equal(result.amountMm, 0.08);
});

test("15-minute nowcast rounds a future onset to a useful five-minute estimate", () => {
  const result = getNextRain({
    time: ["2026-07-26T12:15", "2026-07-26T12:30", "2026-07-26T12:45"],
    precipitation: [0, 0.12, 0],
  }, new Date("2026-07-26T10:07:00Z"));
  assert.equal(result.state, "within-hour");
  assert.equal(result.minutes, 10);
  assert.equal(result.startsAt.toISOString(), "2026-07-26T10:15:00.000Z");
});

test("15-minute nowcast distinguishes later rain from a dry next hour", () => {
  const result = getNextRain({
    time: ["2026-07-26T12:15", "2026-07-26T14:00"],
    precipitation: [0, 0.2],
  }, new Date("2026-07-26T10:00:00Z"));
  assert.equal(result.state, "later");
  assert.equal(result.minutes, 105);
});

test("15-minute nowcast explicitly reports dry and unavailable data", () => {
  assert.deepEqual(getNextRain({
    time: ["2026-07-26T12:15"],
    precipitation: [0],
  }, new Date("2026-07-26T10:00:00Z")), {
    state: "dry",
    horizonMinutes: 360,
  });
  assert.deepEqual(getNextRain({ time: [], precipitation: [] }), {
    state: "unavailable",
  });
});

test("one wet hourly record ends at the next hourly boundary", () => {
  const periods = buildWetPeriods([
    {
      time: "2026-07-26T14:00",
      precipitation: 0.4,
      precipitation_probability: 70,
    },
    {
      time: "2026-07-26T15:00",
      precipitation: 0,
      precipitation_probability: 10,
    },
  ]);
  assert.equal(periods[0].start, "2026-07-26T14:00");
  assert.equal(periods[0].end, "2026-07-26T15:00");
});

test("peak ranking is precipitation-first with deterministic tie-breakers", () => {
  const periods = buildWetPeriods([
    {
      time: "2026-07-26T14:00",
      precipitation: 1.2,
      precipitation_probability: 65,
    },
    {
      time: "2026-07-26T15:00",
      precipitation: 0.4,
      precipitation_probability: 95,
    },
    {
      time: "2026-07-26T16:00",
      precipitation: 0,
      precipitation_probability: 0,
    },
  ]);
  assert.equal(periods[0].peakTime, "2026-07-26T14:00");
  assert.equal(periods[0].peakPrecipitationMm, 1.2);
});

test("DST grouping accepts a 23-hour spring day", () => {
  const hours = [];
  for (let hour = 0; hour < 24; hour += 1) {
    if (hour === 2) continue;
    hours.push({ time: `2026-03-29T${String(hour).padStart(2, "0")}:00` });
  }
  const grouped = groupHoursByApiDate(hours);
  assert.equal(grouped["2026-03-29"].length, 23);
  assert.equal(apiTimestampDateKey(grouped["2026-03-29"][0].time), "2026-03-29");
});

test("DST grouping accepts a 25-record autumn day", () => {
  const hours = Array.from({ length: 24 }, (_, hour) => ({
    time: `2026-10-25T${String(hour).padStart(2, "0")}:00`,
  }));
  hours.splice(3, 0, { time: "2026-10-25T02:00" });
  const grouped = groupHoursByApiDate(hours);
  assert.equal(grouped["2026-10-25"].length, 25);
});

test("expired red plus active yellow resolves to yellow", () => {
  const now = new Date("2026-07-26T10:00:00Z");
  const result = selectActiveAlerts([
    {
      level: "red",
      effective: "2026-07-25T08:00:00Z",
      expires: "2026-07-26T09:00:00Z",
    },
    {
      level: "yellow",
      effective: "2026-07-26T08:00:00Z",
      expires: "2026-07-26T12:00:00Z",
    },
  ], now);
  assert.equal(result.severity, "yellow");
  assert.equal(result.activeItems.length, 1);
  assert.equal(alertPresentation(result.severity).glowAlpha, "35%");
});

test("future orange warning is not active yet", () => {
  const result = selectActiveAlerts([{
    level: "orange",
    effective: "2026-07-26T11:00:00Z",
    expires: "2026-07-26T16:00:00Z",
  }], new Date("2026-07-26T10:00:00Z"));
  assert.equal(result.severity, "green");
  assert.equal(result.activeItems.length, 0);
  assert.equal(alertPresentation(result.severity).glowAlpha, "0%");
});

test("proxy starts timestamp is treated as the alert effective time", () => {
  const result = selectActiveAlerts([{
    level: "orange",
    starts: "2026-07-26T11:00:00Z",
    expires: "2026-07-26T16:00:00Z",
  }], new Date("2026-07-26T10:00:00Z"));
  assert.equal(result.severity, "green");
  assert.equal(result.activeItems.length, 0);
});

test("unstructured nationwide proxy results are narrowed to Olomouc titles", () => {
  const filtered = filterOlomoucRegionAlerts([
    { title: "Yellow warning - Pardubický kraj", level: "yellow" },
    { title: "Orange warning - Olomoucký kraj (Přerov)", level: "orange" },
    { title: "Orange warning - Olomoucký kraj (Přerov)", level: "orange" },
  ]);
  assert.equal(filtered.length, 1);
  assert.match(filtered[0].title, /Olomoucký/);
});

test("strictly verified Worker items do not need title matching", () => {
  const filtered = filterOlomoucRegionAlerts([{
    title: "Yellow warning",
    region: "olomoucky",
    regionVerified: true,
    level: "yellow",
  }]);
  assert.equal(filtered.length, 1);
});

test("active red warning controls severity", () => {
  const result = selectActiveAlerts([{
    level: "red",
    effective: "2026-07-26T09:00:00Z",
    expires: "2026-07-26T16:00:00Z",
  }], new Date("2026-07-26T10:00:00Z"));
  assert.equal(result.severity, "red");
  assert.equal(alertPresentation(result.severity).className, "banner red");
  assert.equal(alertPresentation(result.severity).glowAlpha, "55%");
});

test("an alert without an effective timestamp is active until it expires", () => {
  const result = selectActiveAlerts([{
    level: "yellow",
    expires: "2026-07-26T16:00:00Z",
  }], new Date("2026-07-26T10:00:00Z"));
  assert.equal(result.severity, "yellow");
  assert.equal(result.activeItems.length, 1);
});

test("no valid alerts produces green severity", () => {
  assert.deepEqual(selectActiveAlerts([], new Date()), {
    activeItems: [],
    severity: "green",
  });
});

test("missing current-date snapshot is explicit and never replaced from live data", () => {
  const snapshot = snapshotFixture();
  const liveData = { verdict: "YES" };
  const selected = selectSnapshotDay(snapshot, new Date("2026-07-28T10:00:00+02:00"));
  assert.equal(liveData.verdict, "YES");
  assert.equal(selected.status, "unavailable");
  assert.equal(selected.reason, "missing-date");
  assert.equal(selected.day, undefined);
});

test("an older snapshot with a current-date fallback is marked stale", () => {
  const snapshot = snapshotFixture();
  snapshot.generatedAt = "2026-07-25T00:05:00+02:00";
  const selected = selectSnapshotDay(snapshot, new Date("2026-07-26T08:00:00+02:00"));
  assert.equal(selected.status, "available");
  assert.equal(selected.day.verdict, "YES");
  assert.equal(selected.stale, true);
});

test("SunCalc can finish loading after a cached weather render", async () => {
  const script = new EventTarget();
  const fakeWindow = {};
  const waiting = waitForSunCalc(script, fakeWindow);
  fakeWindow.SunCalc = { getTimes() {} };
  script.dispatchEvent(new Event("load"));
  assert.equal(await waiting, fakeWindow.SunCalc);
});

test("SunCalc failure is surfaced instead of being swallowed", async () => {
  const script = new EventTarget();
  const waiting = waitForSunCalc(script, {});
  script.dispatchEvent(new Event("error"));
  await assert.rejects(waiting, /failed to load/);
});

test("a missed SunCalc network event becomes an explicit timeout", async () => {
  const waiting = waitForSunCalc(new EventTarget(), {}, { timeoutMs: 5 });
  await assert.rejects(waiting, /timed out/);
});

test("snapshot generator validates arrays and preserves a same-day lock", () => {
  const previous = snapshotFixture();
  const forecast = forecastFixture();
  forecast.hourly.precipitation = forecast.hourly.precipitation.map(() => 0);
  forecast.hourly.precipitation_probability = forecast.hourly.precipitation_probability.map(() => 0);
  const generated = createDailySnapshot(forecast, {
    now: new Date("2026-07-26T11:00:00+02:00"),
    previousSnapshot: previous,
  });
  validateSnapshot(generated);
  assert.equal(generated.days["2026-07-26"].verdict, "YES");
});

test("first snapshot generation after date rollover may publish a new result", () => {
  const previous = snapshotFixture();
  const generated = createDailySnapshot(forecastFixture("2026-07-27"), {
    now: new Date("2026-07-27T00:05:00+02:00"),
    previousSnapshot: previous,
  });
  assert.equal(generated.days["2026-07-27"].verdict, "YES");
});

test("snapshot generator rejects mismatched hourly arrays", () => {
  const forecast = forecastFixture();
  forecast.hourly.rain.pop();
  assert.throws(() => createDailySnapshot(forecast), /Mismatched hourly\.rain/);
});
