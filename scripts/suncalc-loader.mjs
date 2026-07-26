export function waitForSunCalc(
  scriptElement,
  windowObject = globalThis.window,
  { timeoutMs = 10_000 } = {},
) {
  if (windowObject?.SunCalc) return Promise.resolve(windowObject.SunCalc);
  if (!scriptElement) return Promise.reject(new Error("SunCalc script element is missing"));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("SunCalc loading timed out"));
    }, timeoutMs);
    const onLoad = () => {
      cleanup();
      if (windowObject?.SunCalc) resolve(windowObject.SunCalc);
      else reject(new Error("SunCalc loaded without exposing its API"));
    };
    const onError = () => {
      cleanup();
      reject(new Error("SunCalc failed to load"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      scriptElement.removeEventListener("load", onLoad);
      scriptElement.removeEventListener("error", onError);
    };
    scriptElement.addEventListener("load", onLoad, { once: true });
    scriptElement.addEventListener("error", onError, { once: true });
  });
}
