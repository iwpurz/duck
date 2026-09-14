import assert from "node:assert/strict";
import test from "node:test";
import { HELPER_TOOLS, approvedWebUrl, calculate, claimHelperQuota, attachmentMetadata, reverseImageLink, executeHelperTool } from "../src/helper-tools.js";
import { buildPersonalCommands, handlePersonalCommand, personalAnswer } from "../src/personal-app.js";
import { getPublicGuildSettings, makeSettingsPatch } from "../src/dashboard-config.js";
import { personalityPrompt } from "../src/personality.js";
import { executeAiReadTool, registerCommands, validateSlashCommandDispatchers } from "../src/core.js";

test("arithmetic respects precedence without evaluating code", () => {
  assert.equal(calculate("(12 + 3) * 4 / 2").result, 30);
  assert.equal(calculate("-2 + 3 * (4 - 1)").result, 7);
  for (const input of ["process.exit()", "1/0", "1+", "(1+2", "1;fetch('x')", "2**3", "9".repeat(181)]) assert.throws(() => calculate(input));
});

test("internet helpers reject private destinations, credentials, lookalike hosts and disabled access", async () => {
  for (const url of ["http://en.wikipedia.org/", "https://127.0.0.1/", "https://169.254.169.254/", "https://en.wikipedia.org.evil.test/", "https://user:pass@docs.discord.com/", "https://docs.discord.com:444/", "file:///etc/passwd"]) assert.throws(() => approvedWebUrl(url));
  assert.equal(approvedWebUrl("https://docs.discord.com/developers/intro").hostname, "docs.discord.com");
  let called = false;
  await assert.rejects(executeHelperTool("search_web", { query: "ducks" }, { webEnabled: false }, async () => { called = true; }), /disabled/);
  assert.equal(called, false);
});

test("reference search uses bounded, credential-free, redirect-free requests and gives sources", async () => {
  const result = await executeHelperTool("search_web", { query: "Duck" }, { webEnabled: true, userId: "search-user", guildId: "search-guild" }, async (url, options) => {
    assert.equal(new URL(url).hostname, "en.wikipedia.org");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, undefined);
    return Response.json({ query: { search: [{ title: "Duck", snippet: "<b>Duck</b> is a bird." }] } });
  });
  assert.equal(result.untrusted, true);
  assert.equal(result.results[0].summary, "Duck is a bird.");
  assert.equal(result.results[0].url, "https://en.wikipedia.org/wiki/Duck");
});

test("helper quotas expire and prevent per-user flooding", () => {
  const now = Date.now();
  for (let i = 0; i < 5; i += 1) claimHelperQuota("quota-user", "quota-guild", now);
  assert.throws(() => claimHelperQuota("quota-user", "quota-guild", now), /limit/);
  claimHelperQuota("quota-user", "quota-guild", now + 60_001);
});

test("metadata exports known fields only and reverse image search requires an image attachment", async () => {
  const attachment = { id: "123", name: "bird.png", contentType: "image/png", width: 20, height: 30, size: 90, url: "https://cdn.discordapp.com/attachments/1/2/bird.png?ex=123", secret: "never-export" };
  const metadata = attachmentMetadata(attachment);
  assert.equal(metadata.width, 20);
  assert.doesNotMatch(JSON.stringify(metadata), /never-export|ex=123/);
  assert.equal(new URL(reverseImageLink(attachment)).hostname, "lens.google.com");
  assert.throws(() => reverseImageLink({ ...attachment, url: "https://127.0.0.1/private" }));
  assert.throws(() => reverseImageLink({ ...attachment, contentType: "application/pdf" }));
  await assert.rejects(executeHelperTool("file_metadata", { attachment_id: "other" }, { attachments: new Map([["123", attachment]]) }), /attached/);
});

test("free personalities and opt-in internet survive settings normalization", () => {
  const { settings } = makeSettingsPatch({}, { aiPersonalityPreset: "calm", aiWebEnabled: true });
  const publicSettings = getPublicGuildSettings(settings);
  assert.equal(publicSettings.aiPersonalityPreset, "calm");
  assert.equal(publicSettings.aiWebEnabled, true);
  assert.match(personalityPrompt(publicSettings), /Patient/);
  assert.equal(getPublicGuildSettings({}).aiWebEnabled, false);
  assert.throws(() => makeSettingsPatch({}, { aiPersonalityPreset: "__proto__" }));
});

test("personal commands work without guild data while moderation remains server-only", async () => {
  for (const command of buildPersonalCommands().map((item) => item.toJSON())) {
    assert.deepEqual(command.integration_types, [0, 1]);
    assert.deepEqual(command.contexts, [0, 1, 2]);
  }
  const commands = await registerCommands(null, { dryRun: true });
  assert.ok(commands.length <= 100);
  assert.ok(validateSlashCommandDispatchers(commands));
  assert.deepEqual(commands.find((command) => command.name === "ban").contexts, [0]);
  let reply;
  await handlePersonalCommand({ commandName: "vote", reply: async (data) => { reply = data; } });
  assert.match(reply.components[0].toJSON().components[0].url, /top.gg/);
});

test("guild AI dispatches a helper without giving it Discord mutation access", async () => {
  const result = await executeAiReadTool({ author: { id: "calculator" }, guildId: null }, { function: { name: "calculate", arguments: '{"expression":"4*5"}' } });
  assert.equal(result.result, 20);
  assert.ok(HELPER_TOOLS.every((tool) => !tool.function.name.startsWith("propose_")));
});

test("personal AI completes a bounded tool loop without server context", async () => {
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key";
  let calls = 0;
  try {
    const answer = await personalAnswer("What is 2+2?", "professional", { userId: "personal-ai", webEnabled: false }, async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(JSON.stringify(body).includes("serverContext"), false);
      assert.deepEqual(body.tools.map((tool) => tool.function.name), ["calculate"]);
      calls += 1;
      if (calls === 1) return Response.json({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call1", type: "function", function: { name: "calculate", arguments: '{"expression":"2+2"}' } }] } }] });
      assert.equal(JSON.parse(body.messages.at(-1).content).result, 4);
      return Response.json({ choices: [{ message: { content: "4" } }] });
    });
    assert.equal(answer, "4");
    assert.equal(calls, 2);
  } finally { if (previous == null) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = previous; }
});
