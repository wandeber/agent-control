import { readFileSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";

const MAX_ICON_BYTES = 2 * 1024 * 1024;

/** Embed declared package images so the embedded console needs no file endpoint
 * or remote image permission. Resolve source assets against the installed copy first. */
export function capabilityIcon(candidates: unknown[], roots: string[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate || /^[a-z][a-z\d+.-]*:/i.test(candidate)) continue;
    const paths = isAbsolute(candidate)
      ? roots.filter(root => inside(candidate, root)).flatMap(root => roots.map(target => resolve(target, relative(root, candidate))))
      : roots.map(root => resolve(root, candidate));
    for (const path of new Set(paths)) {
      try {
        const canonical = realpathSync(path);
        if (!roots.some(root => { try { return inside(canonical, realpathSync(root)); } catch { return false; } })) continue;
        const stat = statSync(canonical);
        if (!stat.isFile() || stat.size > MAX_ICON_BYTES) continue;
        const bytes = readFileSync(canonical);
        const mime = imageMime(extname(canonical).toLowerCase(), bytes);
        if (mime) return `data:${mime};base64,${bytes.toString("base64")}`;
      } catch { /* Missing or invalid artwork leaves the ordinary category icon. */ }
    }
  }
  return undefined;
}

function inside(path: string, root: string): boolean {
  const part = relative(resolve(root), resolve(path));
  return !isAbsolute(part) && part !== ".." && !part.startsWith("../") && !part.startsWith("..\\");
}

function imageMime(extension: string, bytes: Buffer): string | undefined {
  if (extension === ".svg" && /^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/.test(bytes.toString("utf8").trimStart())) return "image/svg+xml";
  if (extension === ".png" && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if ([".jpg", ".jpeg"].includes(extension) && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (extension === ".webp" && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (extension === ".gif" && /^GIF8[79]a/.test(bytes.toString("ascii", 0, 6))) return "image/gif";
  return undefined;
}
