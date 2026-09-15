import { publicWebUrl, fetchPublicWeb } from "./public-web.js";
import { fetchWithTimeoutAndRetry, readBoundedText } from "./runtime.js";

const VOTE_URL = "https://top.gg/bot/1507850959642955816/vote";
const USER_INSTALL_URL = "https://discord.com/oauth2/authorize?client_id=1507850959642955816&integration_type=1&scope=applications.commands";
const WEB_HOSTS = new Set(["en.wikipedia.org", "developer.mozilla.org", "docs.discord.com", "support.google.com"]);
const usage = new Map();
let activeWebRequests = 0;

function claimHelperQuota(userId, guildId, now = Date.now()) {
  const limits = [[`user:${userId}`, 5], ...(guildId ? [[`guild:${guildId}`, 20]] : []), ["global", 60]];
  for (const [key, state] of usage) if (state.until <= now) usage.delete(key);
  if (usage.size + limits.filter(([key]) => !usage.has(key)).length > 5000) throw new Error("Duck's helper capacity is full. Try again in a minute.");
  for (const [key, limit] of limits) if ((usage.get(key)?.count || 0) >= limit) throw new Error("Helper limit reached. Try again in a minute (5/user, 20/server). ");
  for (const [key] of limits) {
    const state = usage.get(key) || { count: 0, until: now + 60_000 };
    state.count += 1;
    usage.set(key, state);
  }
}

function approvedWebUrl(value) {
  if (String(value).length > 1500) throw new Error("URL must be 1500 characters or fewer.");
  let url;
  try { url = new URL(value); } catch { throw new Error("Provide a valid HTTPS URL."); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || !WEB_HOSTS.has(url.hostname)) {
    throw new Error(`Web reading is limited to HTTPS pages on ${[...WEB_HOSTS].join(", ")}.`);
  }
  url.hash = "";
  return url;
}

function plainText(html) {
  return String(html).replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ").replace(/&(?:nbsp|amp|lt|gt|quot|#39);/g, (entity) => ({ "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" })[entity])
    .replace(/\s+/g, " ").trim();
}

async function getWebText(url, context, fetchImpl) {
  publicWebUrl(url);
  if (typeof context.approveWeb !== "function" || !await context.approveWeb(String(url))) throw new Error("Web access was not approved.");
  if (activeWebRequests >= 4) throw new Error("Duck's web readers are busy. Try again shortly.");
  claimHelperQuota(context.userId, context.guildId);
  activeWebRequests += 1;
  try {
    if (!fetchImpl) return await fetchPublicWeb(url);
    const response = await fetchWithTimeoutAndRetry(String(url), {
      method: "GET", redirect: "error",
      headers: { Accept: "text/html, application/json, text/plain", "User-Agent": "DuckDiscordBot/1.3 (public reference lookup)" },
    }, { attempts: 1, timeoutMs: 8000, maxResponseBytes: 512 * 1024, fetchImpl });
    if (!response.ok) throw new Error(`Reference site returned HTTP ${response.status}.`);
    if (!/^(text\/(html|plain|xml)|application\/(json|rss\+xml|xml))\b/i.test(response.headers.get("content-type") || "")) throw new Error("Reference site returned an unsupported content type.");
    return await readBoundedText(response, 512 * 1024);
  } finally { activeWebRequests -= 1; }
}

async function searchWeb(query, context, fetchImpl) {
  if (typeof query !== "string" || !query.trim() || query.length > 180) throw new Error("Search must be 1–180 characters.");
  const url = new URL("https://www.bing.com/search");
  url.search = new URLSearchParams({ q: query.trim(), format: "rss" });
  const xml = await getWebText(url, context, fetchImpl);
  if (!/<rss\b/i.test(xml)) throw new Error("Web search returned an unsupported response.");
  const field = (item, name) => plainText(item.match(new RegExp("<" + name + ">([\\s\\S]*?)</" + name + ">", "i"))?.[1] || "");
  const results = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0, 5).map((match) => ({ title: field(match[1], "title").slice(0, 180), summary: field(match[1], "description").slice(0, 600), url: field(match[1], "link") })).filter((item) => { try { publicWebUrl(item.url); return true; } catch { return false; } });
  return { source: "Bing web search", untrusted: true, results };
}

async function readWebPage(url, context, fetchImpl) {
  const approved = publicWebUrl(url);
  const text = plainText(await getWebText(approved, context, fetchImpl));
  return { url: approved.href, untrusted: true, text: text.slice(0, 6000), truncated: text.length > 6000 };
}

// A small arithmetic grammar, not JavaScript evaluation.
function calculate(expression) {
  if (typeof expression !== "string" || !expression.trim() || expression.length > 180) throw new Error("Use an arithmetic expression of 1–180 characters.");
  const input = expression.replace(/\s+/g, "");
  const tokens = input.match(/(?:\d+(?:\.\d*)?|\.\d+)|[()+*/%-]/g) || [];
  if (tokens.join("") !== input) throw new Error("Only numbers, parentheses, and + - * / % are supported.");
  let position = 0;
  const primary = () => {
    const token = tokens[position++];
    if (token === "+") return primary();
    if (token === "-") return -primary();
    if (token === "(") { const result = sum(); if (tokens[position++] !== ")") throw new Error("Unbalanced parentheses."); return result; }
    if (!token || !/^(?:\d|\.)/.test(token)) throw new Error("Expected a number.");
    return Number(token);
  };
  const product = () => {
    let result = primary();
    while (["*", "/", "%"].includes(tokens[position])) { const op = tokens[position++]; const right = primary(); result = op === "*" ? result * right : op === "/" ? result / right : result % right; }
    return result;
  };
  const sum = () => {
    let result = product();
    while (["+", "-"].includes(tokens[position])) { const op = tokens[position++]; const right = product(); result = op === "+" ? result + right : result - right; }
    return result;
  };
  const result = sum();
  if (position !== tokens.length || !Number.isFinite(result)) throw new Error("Invalid expression or division by zero.");
  return { expression, result };
}

function attachmentMetadata(attachment) {
  if (!attachment?.id) throw new Error("Choose a file attached to this request.");
  return {
    source: "Discord attachment metadata", exportedAt: new Date().toISOString(),
    id: String(attachment.id), name: String(attachment.name || attachment.filename || "file").slice(0, 256),
    contentType: attachment.contentType || attachment.content_type || null,
    sizeBytes: attachment.size ?? null, width: attachment.width ?? null, height: attachment.height ?? null,
    durationSeconds: attachment.duration ?? attachment.duration_secs ?? null,
    description: attachment.description ? String(attachment.description).slice(0, 1024) : null,
    spoiler: Boolean(attachment.spoiler || String(attachment.name || "").startsWith("SPOILER_")),
    note: "Describes the attachment Discord received. File contents, embedded EXIF/GPS, and original camera metadata are not read or exported.",
  };
}

function reverseImageLink(attachment) {
  if (!attachment?.url || !/^image\//i.test(attachment.contentType || attachment.content_type || "")) throw new Error("Choose an image attachment.");
  const url = new URL(attachment.url);
  if (url.protocol !== "https:" || !["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname) || url.username || url.password || url.port) throw new Error("Only Discord image attachments can be searched.");
  return `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(url.href)}`;
}

const tool = (name, description, properties, required) => ({ type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } });
const HELPER_TOOLS = Object.freeze([
  tool("calculate", "Evaluate arithmetic with + - * / % and parentheses.", { expression: { type: "string" } }, ["expression"]),
  tool("search_web", "Search the web using Bing after the requester approves the exact search URL. Never include private conversation, personal data, or secrets.", { query: { type: "string" } }, ["query"]),
  tool("read_web_page", "Read one public HTTPS webpage after explicit requester approval. No redirects, private networks, or login sessions.", { url: { type: "string" } }, ["url"]),
  tool("file_metadata", "Inspect Discord metadata of an attachment supplied in the CURRENT request. Does not read embedded EXIF or file bytes.", { attachment_id: { type: "string" } }, ["attachment_id"]),
  tool("reverse_image_search", "Make a Google Lens link for a current image attachment. The user opens it to share the image with Google; no search results are fetched.", { attachment_id: { type: "string" } }, ["attachment_id"]),
]);

async function executeHelperTool(name, args, context, fetchImpl) {
  if (name === "calculate") return calculate(args.expression);
  if (["search_web", "read_web_page"].includes(name) && context.webEnabled !== true) throw new Error("Internet helpers are disabled for this request.");
  if (name === "search_web") return searchWeb(args.query, context, fetchImpl);
  if (name === "read_web_page") return readWebPage(args.url, context, fetchImpl);
  if (name === "file_metadata") return attachmentMetadata(context.attachments?.get(String(args.attachment_id)));
  if (name === "reverse_image_search") return { url: reverseImageLink(context.attachments?.get(String(args.attachment_id))), note: "Open this link to send the image URL to Google Lens. No search has run yet." };
  throw new Error("Unknown helper tool.");
}

export { VOTE_URL, USER_INSTALL_URL, WEB_HOSTS, HELPER_TOOLS, claimHelperQuota, approvedWebUrl, calculate, searchWeb, readWebPage, attachmentMetadata, reverseImageLink, executeHelperTool };
