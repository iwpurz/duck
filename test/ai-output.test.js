import assert from "node:assert/strict";
import test from "node:test";
import { hasRawToolMarkup } from "../src/ai-output.js";
import { personalAnswer } from "../src/personal-app.js";

const malformed = "<tool_calls:6124c78e>\n<tool_call:6124c78e>search_web<tool_sep:6124c78e>\n<arg_key:6124c78e>query</arg_key:6124c78e>\n<arg_value:6124c78e>RTX 5090 review";

test("detects leaked tool serialization including the screenshot's truncated format", () => {
  assert.equal(hasRawToolMarkup(malformed), true);
  assert.equal(hasRawToolMarkup("<|tool_call_begin|>search_web"), true);
  assert.equal(hasRawToolMarkup("The RTX 5090 has < 40 GB of memory."), false);
  assert.equal(hasRawToolMarkup("Use search_web to search."), false);
});

test("malformed tool output retries through native tools without executing raw text", async () => {
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-only";
  let calls = 0;
  try {
    const answer = await personalAnswer("Calculate 2+2", "classic", { userId: "format-recovery", webEnabled: false }, async (_url, options) => {
      calls++;
      if (calls === 1) return Response.json({ choices: [{ message: { content: malformed } }] });
      const body = JSON.parse(options.body);
      assert.ok(body.messages.some((item) => item.role === "system" && item.content.includes("native tool_calls")));
      if (calls === 2) return Response.json({ choices: [{ message: { content: null, tool_calls: [{ id: "calc", type: "function", function: { name: "calculate", arguments: '{"expression":"2+2"}' } }] } }] });
      assert.equal(JSON.parse(body.messages.at(-1).content).result, 4);
      return Response.json({ choices: [{ message: { content: "4" } }] });
    });
    assert.equal(answer, "4");
    assert.equal(calls, 3);
  } finally { if (previous === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = previous; }
});

test("repeated malformed output fails cleanly after one correction", async () => {
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-only";
  let calls = 0;
  try {
    await assert.rejects(personalAnswer("Search", "classic", { userId: "format-failure", webEnabled: true }, async () => {
      calls++;
      return Response.json({ choices: [{ message: { content: malformed } }] });
    }), (error) => /invalid tool request/.test(error.message) && !hasRawToolMarkup(error.message));
    assert.equal(calls, 2);
  } finally { if (previous === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = previous; }
});
