const CONTROL = new RegExp(
  "[" +
    String.fromCharCode(0) +
    "-" +
    String.fromCharCode(8) +
    String.fromCharCode(11) +
    "-" +
    String.fromCharCode(31) +
    String.fromCharCode(127) +
    "]",
  "g",
);
const ELLIPSIS = String.fromCharCode(8230);

export function boundedText(value: string, max: number): string {
  if (!Number.isSafeInteger(max) || max < 0) {
    throw new RangeError("max must be a non-negative safe integer");
  }

  const clean = value.replace(CONTROL, "");
  if (clean.length <= max) return clean;
  if (max === 0) return "";
  return clean.slice(0, max - 1) + ELLIPSIS;
}

export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "about:invalid";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    const text = url.toString();
    return url.pathname === "/" && !raw.endsWith("/") ? text.replace(/\/$/, "") : text;
  } catch {
    return "about:invalid";
  }
}

export function isNavigableUrl(raw: string): boolean {
  try {
    const { protocol } = new URL(raw);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
