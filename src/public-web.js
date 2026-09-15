import { lookup } from "node:dns/promises";
import { request } from "node:https";

export function publicWebUrl(value) {
  if (String(value).length > 1500) throw new Error("URL is too long.");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || !url.hostname.includes(".") || /[\[\]:]/.test(url.hostname)) throw new Error("Use a public HTTPS website without credentials or a custom port.");
  url.hash = "";
  return url;
}

export function publicIpv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((v) => !Number.isInteger(v) || v < 0 || v > 255)) return false;
  const [a, b] = parts;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 2, 168].includes(b)) || (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0));
}

// Pin a validated public address so a second DNS lookup cannot reach a private host.
export async function fetchPublicWeb(value) {
  const url = publicWebUrl(value);
  let timer;
  const deadline = AbortSignal.timeout(10000);
  try {
    return await Promise.race([
      (async () => {
        const addresses = await lookup(url.hostname, { all: true, family: 4 });
        if (!addresses.length || addresses.some(({ address }) => !publicIpv4(address))) throw new Error("Private and reserved network destinations are blocked.");
        deadline.throwIfAborted();
        return new Promise((resolve, reject) => {
          const req = request(url, { method: "GET", agent: false, signal: deadline, lookup: (_host, options, callback) => callback(null, ...(options.all ? [[addresses[0]]] : [addresses[0].address, 4])), headers: { Accept: "text/html, text/plain, application/json, application/rss+xml, text/xml", "User-Agent": "DuckDiscordBot/1.3" } }, (res) => {
            if (res.statusCode !== 200 || !/^(text\/(html|plain|xml)|application\/(json|rss\+xml|xml))\b/i.test(res.headers["content-type"] || "")) { res.destroy(); reject(new Error(`Website returned HTTP ${res.statusCode} or unsupported content. Redirects are not followed.`)); return; }
            const chunks = []; let size = 0;
            res.on("data", (chunk) => { size += chunk.length; if (size > 512 * 1024) { res.destroy(new Error("Webpage exceeds 512 KiB.")); } else chunks.push(chunk); });
            res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
            res.on("error", reject);
          });
          req.on("error", reject); req.end();
        });
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Website lookup timed out.")), 10000); }),
    ]);
  } finally { clearTimeout(timer); }
}
