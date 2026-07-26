export const CITY = Object.freeze({
  name: "Přerov",
  latitude: 49.4551,
  longitude: 17.4509,
  timezone: "Europe/Prague",
});

export const THRESHOLDS = Object.freeze({
  precipitationMmPerHour: 0.2,
  precipitationProbabilityPercent: 60,
});

export const NOWCAST_THRESHOLD_MM_PER_15_MINUTES = 0.05;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const API_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const SEVERITY_RANK = Object.freeze({ green: 0, yellow: 1, orange: 2, red: 3 });

function zonedParts(date, timeZone = CITY.timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  return Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
  );
}

export function getPragueDateKey(now = new Date()) {
  const p = zonedParts(now);
  return `${p.year}-${p.month}-${p.day}`;
}

export function getPragueHourKey(now = new Date()) {
  const p = zonedParts(now);
  return `${p.year}-${p.month}-${p.day}T${p.hour}`;
}

export function apiTimestampDateKey(timestamp) {
  if (typeof timestamp !== "string" || !API_TIMESTAMP_RE.test(timestamp)) {
    throw new TypeError(`Invalid Open-Meteo timestamp: ${String(timestamp)}`);
  }
  return timestamp.slice(0, 10);
}

export function apiTimestampHourKey(timestamp) {
  if (typeof timestamp !== "string" || !API_TIMESTAMP_RE.test(timestamp)) {
    throw new TypeError(`Invalid Open-Meteo timestamp: ${String(timestamp)}`);
  }
  return timestamp.slice(0, 13);
}

export function addDateKey(dateKey, days) {
  if (!DATE_RE.test(dateKey) || !Number.isInteger(days)) {
    throw new TypeError("addDateKey requires YYYY-MM-DD and an integer day count");
  }
  const [year, month, day] = dateKey.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days, 12));
  return shifted.toISOString().slice(0, 10);
}

export function formatPragueTime(value, locale = "cs-CZ") {
  if (typeof value === "string" && API_TIMESTAMP_RE.test(value) && !/[zZ]|[+-]\d{2}:\d{2}$/.test(value)) {
    return value.slice(11, 16);
  }

  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat(locale, {
    timeZone: CITY.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

export function formatPragueDay(dateKey, locale = "cs-CZ") {
  if (!DATE_RE.test(dateKey)) return "—";
  const instant = pragueLocalDateToInstant(dateKey, 12, 0);
  return new Intl.DateTimeFormat(locale, {
    timeZone: CITY.timezone,
    weekday: "short",
  }).format(instant);
}

export function pragueLocalDateToInstant(dateKey, hour = 12, minute = 0) {
  if (!DATE_RE.test(dateKey)) throw new TypeError(`Invalid date key: ${dateKey}`);
  const [year, month, day] = dateKey.split("-").map(Number);
  const desiredAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = new Date(desiredAsUtc);

  for (let i = 0; i < 3; i += 1) {
    const p = zonedParts(guess);
    const representedAsUtc = Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour),
      Number(p.minute),
      Number(p.second),
    );
    guess = new Date(guess.getTime() + desiredAsUtc - representedAsUtc);
  }
  return guess;
}

export function apiTimestampToPragueInstant(timestamp) {
  if (typeof timestamp !== "string" || !API_TIMESTAMP_RE.test(timestamp)) {
    throw new TypeError(`Invalid Open-Meteo timestamp: ${String(timestamp)}`);
  }
  const [dateKey, time] = timestamp.slice(0, 16).split("T");
  const [hour, minute] = time.split(":").map(Number);
  return pragueLocalDateToInstant(dateKey, hour, minute);
}

export function formatPragueIso(now = new Date()) {
  const p = zonedParts(now);
  const localAsUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
  const offsetMinutes = Math.round((localAsUtc - now.getTime()) / 60000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const offsetHour = String(Math.floor(absolute / 60)).padStart(2, "0");
  const offsetMinute = String(absolute % 60).padStart(2, "0");
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${sign}${offsetHour}:${offsetMinute}`;
}

export function totalPrecipitationMm(hour) {
  if (Number.isFinite(hour?.precipitation)) return hour.precipitation;
  return (Number(hour?.rain) || 0) + (Number(hour?.showers) || 0);
}

export function getNextRain(minutely15, now = new Date(), {
  thresholdMm = NOWCAST_THRESHOLD_MM_PER_15_MINUTES,
  nearTermMinutes = 60,
  horizonMinutes = 360,
} = {}) {
  const times = minutely15?.time;
  const precipitation = minutely15?.precipitation;
  if (!Array.isArray(times) || !Array.isArray(precipitation)
    || !times.length || times.length !== precipitation.length) {
    return { state: "unavailable" };
  }

  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return { state: "unavailable" };
  const horizonMs = nowMs + horizonMinutes * 60_000;

  for (let index = 0; index < times.length; index += 1) {
    const amountMm = Number(precipitation[index]);
    if (!Number.isFinite(amountMm) || amountMm < thresholdMm) continue;

    let intervalEnd;
    try {
      intervalEnd = apiTimestampToPragueInstant(times[index]);
    } catch {
      continue;
    }
    const intervalEndMs = intervalEnd.getTime();
    const intervalStartMs = intervalEndMs - 15 * 60_000;
    if (intervalEndMs <= nowMs) continue;
    if (intervalStartMs > horizonMs) break;

    const exactMinutes = Math.max(0, (intervalStartMs - nowMs) / 60_000);
    const minutes = exactMinutes <= 0 ? 0 : Math.max(5, Math.ceil(exactMinutes / 5) * 5);
    const common = {
      minutes,
      amountMm,
      startsAt: new Date(intervalStartMs),
      intervalEnd,
    };
    if (minutes === 0) return { state: "raining", ...common };
    if (minutes <= nearTermMinutes) return { state: "within-hour", ...common };
    return { state: "later", ...common };
  }

  return {
    state: "dry",
    horizonMinutes,
  };
}

export function isWetHour(hour, thresholds = THRESHOLDS) {
  const probability = Number(hour?.precipitation_probability) || 0;
  return (
    totalPrecipitationMm(hour) >= thresholds.precipitationMmPerHour
    || probability >= thresholds.precipitationProbabilityPercent
  );
}

function addOneApiHour(timestamp) {
  if (!API_TIMESTAMP_RE.test(timestamp)) return timestamp;
  const [datePart, timePart] = timestamp.slice(0, 16).split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute] = timePart.split(":").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day, hour + 1, minute));
  return next.toISOString().slice(0, 16);
}

function peakForHour(hour) {
  return {
    peakTime: hour.time,
    peakPrecipitationMm: totalPrecipitationMm(hour),
    peakProbabilityPercent: Number(hour.precipitation_probability) || 0,
  };
}

function isBetterPeak(candidate, current) {
  if (candidate.peakPrecipitationMm !== current.peakPrecipitationMm) {
    return candidate.peakPrecipitationMm > current.peakPrecipitationMm;
  }
  if (candidate.peakProbabilityPercent !== current.peakProbabilityPercent) {
    return candidate.peakProbabilityPercent > current.peakProbabilityPercent;
  }
  return candidate.peakTime < current.peakTime;
}

export function buildWetPeriods(hours, thresholds = THRESHOLDS) {
  if (!Array.isArray(hours)) throw new TypeError("hours must be an array");
  const periods = [];
  let current = null;
  let finalWetIndex = -1;

  hours.forEach((hour, index) => {
    if (!hour || typeof hour.time !== "string") {
      throw new TypeError(`Hourly record ${index} has no timestamp`);
    }
    const wet = isWetHour(hour, thresholds);

    if (wet) {
      const candidate = peakForHour(hour);
      if (!current) {
        current = { start: hour.time, ...candidate };
      } else if (isBetterPeak(candidate, current)) {
        Object.assign(current, candidate);
      }
      finalWetIndex = index;
      return;
    }

    if (current) {
      const previousWetTime = hours[finalWetIndex].time;
      current.end = hour.time > previousWetTime ? hour.time : addOneApiHour(previousWetTime);
      periods.push(current);
      current = null;
      finalWetIndex = -1;
    }
  });

  if (current) {
    current.end = hours[finalWetIndex + 1]?.time || addOneApiHour(hours[finalWetIndex].time);
    periods.push(current);
  }

  return periods;
}

export function recordsFromHourly(hourly) {
  const required = ["time", "precipitation_probability", "precipitation", "rain", "showers"];
  if (!hourly || typeof hourly !== "object") throw new TypeError("Missing hourly forecast");
  const length = Array.isArray(hourly.time) ? hourly.time.length : -1;
  if (length <= 0) throw new TypeError("Hourly time array is empty");

  for (const field of required) {
    if (!Array.isArray(hourly[field])) throw new TypeError(`Missing hourly.${field}`);
    if (hourly[field].length !== length) {
      throw new TypeError(`Mismatched hourly.${field} length`);
    }
  }

  return hourly.time.map((time, index) => ({
    time,
    precipitation_probability: hourly.precipitation_probability[index],
    precipitation: hourly.precipitation[index],
    rain: hourly.rain[index],
    showers: hourly.showers[index],
    temperature_2m: hourly.temperature_2m?.[index],
    apparent_temperature: hourly.apparent_temperature?.[index],
    relative_humidity_2m: hourly.relative_humidity_2m?.[index],
    cloud_cover: hourly.cloud_cover?.[index],
    pressure_msl: hourly.pressure_msl?.[index],
    wind_speed_10m: hourly.wind_speed_10m?.[index],
    wind_gusts_10m: hourly.wind_gusts_10m?.[index],
    uv_index: hourly.uv_index?.[index],
  }));
}

export function groupHoursByApiDate(hours) {
  const grouped = {};
  for (const hour of hours) {
    const dateKey = apiTimestampDateKey(hour.time);
    (grouped[dateKey] ||= []).push(hour);
  }
  return grouped;
}

export function validateForecastForSnapshot(forecast) {
  if (!forecast || typeof forecast !== "object") throw new TypeError("Forecast must be an object");
  if (forecast.error) throw new TypeError(`Open-Meteo error: ${forecast.reason || "unknown"}`);
  if (forecast.timezone !== CITY.timezone) {
    throw new TypeError(`Expected timezone ${CITY.timezone}, received ${forecast.timezone || "none"}`);
  }
  return recordsFromHourly(forecast.hourly);
}

export function createDailySnapshot(forecast, {
  now = new Date(),
  previousSnapshot = null,
} = {}) {
  const records = validateForecastForSnapshot(forecast);
  const grouped = groupHoursByApiDate(records);
  const days = {};

  for (const dateKey of Object.keys(grouped).sort()) {
    const wetPeriods = buildWetPeriods(grouped[dateKey]);
    days[dateKey] = {
      verdict: wetPeriods.length ? "YES" : "NO",
      wetPeriods,
    };
  }

  if (!Object.keys(days).length) throw new TypeError("No dated daily entries were generated");

  const generatedAt = formatPragueIso(now);
  const todayKey = getPragueDateKey(now);
  if (previousSnapshot) {
    validateSnapshot(previousSnapshot);
    const previousGenerationDate = getPragueDateKey(new Date(previousSnapshot.generatedAt));
    if (previousGenerationDate === todayKey && previousSnapshot.days[todayKey]) {
      days[todayKey] = structuredClone(previousSnapshot.days[todayKey]);
    }
  }

  const snapshot = {
    schemaVersion: 1,
    city: { ...CITY },
    generatedAt,
    source: {
      provider: "Open-Meteo",
      fetchedAt: generatedAt,
      status: "ok",
    },
    thresholds: { ...THRESHOLDS },
    days,
  };
  validateSnapshot(snapshot);
  return snapshot;
}

export function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") throw new TypeError("Snapshot must be an object");
  if (snapshot.schemaVersion !== 1) throw new TypeError("Unsupported snapshot schemaVersion");
  if (snapshot.city?.timezone !== CITY.timezone) throw new TypeError("Snapshot timezone is not Europe/Prague");
  if (snapshot.city?.name !== CITY.name) throw new TypeError("Snapshot city is not Přerov");
  if (!Number.isFinite(Date.parse(snapshot.generatedAt))) throw new TypeError("Invalid snapshot generatedAt");
  if (snapshot.source?.provider !== "Open-Meteo") throw new TypeError("Invalid snapshot provider");
  if (!snapshot.days || typeof snapshot.days !== "object" || !Object.keys(snapshot.days).length) {
    throw new TypeError("Snapshot contains no daily entries");
  }

  for (const [dateKey, day] of Object.entries(snapshot.days)) {
    if (!DATE_RE.test(dateKey)) throw new TypeError(`Invalid snapshot date: ${dateKey}`);
    if (!["YES", "NO"].includes(day?.verdict)) throw new TypeError(`Invalid verdict for ${dateKey}`);
    if (!Array.isArray(day.wetPeriods)) throw new TypeError(`Missing wetPeriods for ${dateKey}`);
    if (day.verdict === "NO" && day.wetPeriods.length) {
      throw new TypeError(`NO verdict has wet periods for ${dateKey}`);
    }
    if (day.verdict === "YES" && !day.wetPeriods.length) {
      throw new TypeError(`YES verdict has no wet periods for ${dateKey}`);
    }
    for (const period of day.wetPeriods) {
      for (const field of ["start", "end", "peakTime"]) {
        if (typeof period[field] !== "string" || !API_TIMESTAMP_RE.test(period[field])) {
          throw new TypeError(`Invalid ${field} for ${dateKey}`);
        }
      }
      if (!Number.isFinite(period.peakPrecipitationMm)) {
        throw new TypeError(`Invalid peak precipitation for ${dateKey}`);
      }
      if (!Number.isFinite(period.peakProbabilityPercent)) {
        throw new TypeError(`Invalid peak probability for ${dateKey}`);
      }
    }
  }
  return snapshot;
}

export function selectSnapshotDay(snapshot, now = new Date()) {
  const dateKey = getPragueDateKey(now);
  if (!snapshot) return { status: "unavailable", dateKey, reason: "missing-snapshot" };
  try {
    validateSnapshot(snapshot);
  } catch {
    return { status: "unavailable", dateKey, reason: "invalid-snapshot" };
  }
  const day = snapshot.days[dateKey];
  if (!day) return { status: "unavailable", dateKey, reason: "missing-date" };
  const generatedDate = getPragueDateKey(new Date(snapshot.generatedAt));
  return {
    status: "available",
    dateKey,
    day,
    generatedAt: snapshot.generatedAt,
    stale: generatedDate !== dateKey,
  };
}

export function normalizeSeverity(level) {
  const normalized = String(level || "").toLowerCase();
  return Object.hasOwn(SEVERITY_RANK, normalized) ? normalized : "green";
}

export function alertPresentation(level) {
  const normalized = normalizeSeverity(level);
  const glow = {
    yellow: { color: "#f59e0b", alpha: "35%" },
    orange: { color: "#fb923c", alpha: "45%" },
    red: { color: "#ef4444", alpha: "55%" },
  }[normalized] || { color: "transparent", alpha: "0%" };
  return {
    level: normalized,
    className: `banner ${normalized}`,
    glowColor: glow.color,
    glowAlpha: glow.alpha,
  };
}

export function filterOlomoucRegionAlerts(items) {
  const unique = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const workerVerified = item?.regionVerified === true || item?.region === "olomoucky";
    const searchable = `${item?.title || ""} ${item?.area || ""}`
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase();
    if (!workerVerified
      && !searchable.includes("olomoucky kraj")
      && !searchable.includes("olomouc region")
      && !searchable.includes("prerov")) {
      continue;
    }
    const key = [
      item?.title || "",
      item?.effective || item?.starts || "",
      item?.expires || "",
      normalizeSeverity(item?.level),
    ].join("|");
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()];
}

export function selectActiveAlerts(items, now = new Date()) {
  const nowMs = now.getTime();
  const activeItems = (Array.isArray(items) ? items : []).filter((item) => {
    const effectiveValue = item?.effective || item?.starts;
    const effective = effectiveValue ? Date.parse(effectiveValue) : Number.NEGATIVE_INFINITY;
    const expires = item?.expires ? Date.parse(item.expires) : Number.POSITIVE_INFINITY;
    const validEffective = !effectiveValue || Number.isFinite(effective);
    const validExpiry = !item?.expires || Number.isFinite(expires);
    return validEffective && validExpiry && effective <= nowMs && nowMs < expires;
  });

  const severity = activeItems.reduce((best, item) => {
    const candidate = normalizeSeverity(item.level);
    return SEVERITY_RANK[candidate] > SEVERITY_RANK[best] ? candidate : best;
  }, "green");

  return { activeItems, severity };
}
