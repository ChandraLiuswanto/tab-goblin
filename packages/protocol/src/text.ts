const CONTROL = new RegExp(
  "[" +
    String.fromCharCode(0) +
    "-" +
    String.fromCharCode(8) +
    String.fromCharCode(11) +
    "-" +
    String.fromCharCode(31) +
    String.fromCharCode(127) +
    "-" +
    String.fromCharCode(159) +
    "]",
  "g",
);
const ELLIPSIS = String.fromCharCode(8230);
const REPLACEMENT = String.fromCharCode(0xfffd);

function replaceLoneSurrogates(value: string): string {
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result.push(value[index], value[index + 1]);
        index += 1;
      } else {
        result.push(REPLACEMENT);
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      result.push(REPLACEMENT);
    } else {
      result.push(value[index]);
    }
  }
  return result.join("");
}

export function boundedText(value: string, max: number): string {
  if (!Number.isSafeInteger(max) || max < 0) {
    throw new RangeError("max must be a non-negative safe integer");
  }

  const clean = replaceLoneSurrogates(value).replace(CONTROL, "");
  if (clean.length <= max) return clean;
  if (max === 0) return "";

  const budget = max - ELLIPSIS.length;
  const prefix: string[] = [];
  let length = 0;
  for (const codePoint of clean) {
    if (length + codePoint.length > budget) break;
    prefix.push(codePoint);
    length += codePoint.length;
  }
  return prefix.join("") + ELLIPSIS;
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
