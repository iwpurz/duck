import assert from "node:assert/strict";
import test from "node:test";
import {
  ClusteredGuildScheduler,
  FairGuildScheduler,
  QueueCapacityError,
  describeProviderError,
  fetchWithTimeoutAndRetry,
  modelSupportsVision,
  readBoundedJson,
  readBoundedText,
} from "../src/runtime.js";

const challengeHtml = '<!DOCTYPE html><html><head><title>Just a moment...</title></head></html>';

test("Cloudflare HTML challenges retry with a bounded budget and readable final errors", async () => {
  let calls = 0;
  const policy = { attempts: 2, maxResponseBytes: 4096, retryCloudflareChallenges: true,
    fetchImpl: async () => ++calls === 1 ? new Response(challengeHtml, { status: 403 }) : Response.json({ ok: true }) };
  assert.deepEqual(await (await fetchWithTimeoutAndRetry("https://example.invalid", {}, policy)).json(), { ok: true });
  assert.equal(calls, 2);
  calls = 0;
  policy.fetchImpl = async () => { calls += 1; return new Response(challengeHtml, { status: 403 }); };
  const response = await fetchWithTimeoutAndRetry("https://example.invalid", {}, policy);
  const error = describeProviderError(response, await response.text());
  assert.equal(calls, 2);
  assert.match(error, /Cloudflare/);
  assert.doesNotMatch(error, /<html|<!DOCTYPE/);
});

test("persistent challenges include a safe support reference without leaking the HTML page", () => {
  const response = new Response(challengeHtml, { status: 403, headers: { "cf-ray": "0123456789abcdef-LAX" } });
  const error = describeProviderError(response, challengeHtml);
  assert.match(error, /OpenRouter support/);
  assert.match(error, /0123456789abcdef-LAX/);
  assert.doesNotMatch(error, /temporarily|<html|<!DOCTYPE/);
  const malformed = new Response(challengeHtml, { status: 403, headers: { "cf-ray": "<untrusted>" } });
  assert.doesNotMatch(describeProviderError(malformed, challengeHtml), /<untrusted>/);
});

test("permission and moderation 403s are not retried, and challenges require opt-in", async () => {
  for (const [body, enabled] of [[JSON.stringify({ error: { message: "Request blocked by moderation" } }), true], [challengeHtml, false]]) {
    let calls = 0;
    const response = await fetchWithTimeoutAndRetry("https://example.invalid", {}, {
      attempts: 3, maxResponseBytes: 4096, retryCloudflareChallenges: enabled,
      fetchImpl: async () => { calls += 1; return new Response(body, { status: 403 }); },
    });
    assert.equal(calls, 1);
    assert.equal(await response.text(), body);
  }
});

test("buffered requests time out when headers arrive but the body stalls", async () => {
  let aborted = false;
  await assert.rejects(fetchWithTimeoutAndRetry("https://example.invalid", {}, {
    timeoutMs: 1000, attempts: 1, maxResponseBytes: 4096,
    fetchImpl: async (_url, { signal }) => new Response(new ReadableStream({
      start(controller) {
        signal.addEventListener("abort", () => { aborted = true; controller.error(signal.reason); }, { once: true });
      },
    })),
  }), /timed out/);
  assert.equal(aborted, true);
});

test("cluster queues isolate batches while preserving per-server serialization", async () => {
  const scheduler = new ClusteredGuildScheduler({ resolveClusterId: (guildId) => guildId.startsWith("a") ? "cluster-01" : "cluster-02", clusterCount: 2, globalConcurrency: 2, guildConcurrency: 1, maxQueuedPerGuild: 2, maxQueuedGlobal: 4 });
  const events = []; let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  const first = scheduler.schedule("alpha", async () => { events.push("alpha-start"); await blocker; events.push("alpha-end"); }).promise;
  const second = scheduler.schedule("alpha", async () => events.push("alpha-second")).promise;
  const otherCluster = scheduler.schedule("beta", async () => events.push("beta-start")).promise;
  await otherCluster;
  assert.deepEqual(events.slice(0, 2).sort(), ["alpha-start", "beta-start"]);
  assert.equal(scheduler.snapshot("alpha").clusterId, "cluster-01");
  assert.equal(scheduler.snapshot("beta").clusterId, "cluster-02");
  release(); await Promise.all([first, second]);
  assert.deepEqual(events.slice(-2), ["alpha-end", "alpha-second"]);
});

test("vision is model-aware and Tencent HY3 is never auto-enabled", () => {
  assert.equal(modelSupportsVision("OpenRouter", "tencent/hy3:free"), false);
  assert.equal(modelSupportsVision("OpenRouter", "cohere/north-mini-code:free"), false);
  assert.equal(modelSupportsVision("OpenRouter", "google/gemini-2.5-flash"), true);
  assert.equal(modelSupportsVision("OpenRouter", "custom/model", { models: "custom/model" }), true);
  assert.equal(modelSupportsVision("OpenRouter", "tencent/hy3:free", { mode: "off" }), false);
  assert.equal(modelSupportsVision("OpenRouter", "tencent/hy3:free", { mode: "on" }), false);
});

test("the scheduler serializes one guild while allowing another guild to progress", async () => {
  const scheduler = new FairGuildScheduler({ globalConcurrency: 2, guildConcurrency: 1, maxQueuedPerGuild: 2 });
  const events = [];
  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  const first = scheduler.schedule("guild-a", async () => {
    events.push("a1-start");
    await blocker;
    events.push("a1-end");
  }).promise;
  await new Promise((resolve) => setImmediate(resolve));
  const second = scheduler.schedule("guild-a", async () => events.push("a2")).promise;
  const otherGuild = scheduler.schedule("guild-b", async () => events.push("b1")).promise;
  await otherGuild;
  assert.deepEqual(events, ["a1-start", "b1"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["a1-start", "b1", "a1-end", "a2"]);
  assert.equal(scheduler.snapshot("guild-a").queuedForGuild, 0);
});

test("the scheduler rejects work beyond the per-guild queue cap", async () => {
  const scheduler = new FairGuildScheduler({ globalConcurrency: 1, guildConcurrency: 1, maxQueuedPerGuild: 1 });
  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  const active = scheduler.schedule("guild", () => blocker).promise;
  await new Promise((resolve) => setImmediate(resolve));
  const queued = scheduler.schedule("guild", async () => "queued").promise;
  assert.throws(() => scheduler.schedule("guild", async () => "overflow"), QueueCapacityError);
  release();
  await Promise.all([active, queued]);
});

test("Plus priority gets faster service without starving normal guilds", async () => {
  const scheduler = new FairGuildScheduler({ globalConcurrency: 1, guildConcurrency: 1, maxQueuedPerGuild: 4 });
  const events = [];
  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  const active = scheduler.schedule("active", () => blocker).promise;
  await new Promise((resolve) => setImmediate(resolve));
  const normal = scheduler.schedule("free", async () => events.push("free")).promise;
  const plusOne = scheduler.schedule("plus-a", async () => events.push("plus-a"), { priority: true }).promise;
  const plusTwo = scheduler.schedule("plus-b", async () => events.push("plus-b"), { priority: true }).promise;
  const plusThree = scheduler.schedule("plus-c", async () => events.push("plus-c"), { priority: true }).promise;
  release();
  await Promise.all([active, normal, plusOne, plusTwo, plusThree]);
  assert.deepEqual(events, ["plus-a", "plus-b", "free", "plus-c"]);
});

test("bounded readers accept small JSON and reject oversized responses", async () => {
  assert.deepEqual(await readBoundedJson(new Response('{"ok":true}'), 100), { ok: true });
  await assert.rejects(() => readBoundedText(new Response("x".repeat(101)), 100), /exceeded 100 bytes/);
});

test("network policy retries transient responses and enforces a deadline", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls += 1;
      return calls === 1 ? new Response("busy", { status: 503 }) : new Response("ok");
    };
    const response = await fetchWithTimeoutAndRetry("https://example.invalid", {}, { attempts: 2, timeoutMs: 1_000 });
    assert.equal(await response.text(), "ok");
    assert.equal(calls, 2);

    globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    });
    await assert.rejects(
      () => fetchWithTimeoutAndRetry("https://example.invalid", {}, { attempts: 1, timeoutMs: 1_000 }),
      /timed out/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
