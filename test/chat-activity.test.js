import assert from "node:assert/strict";
import test from "node:test";
import { createChatActivity, handleChatActivity } from "../src/chat-activity.js";
import { executeHelperTool } from "../src/helper-tools.js";
import { publicIpv4, publicWebUrl } from "../src/public-web.js";

test("web approval is requester-only, single-use, and denies without a request", async () => {
  let panel;
  const activity = createChatActivity("owner", async (payload) => { panel = payload; });
  let requests = 0;
  const operation = executeHelperTool("read_web_page", { url: "https://example.org/page" }, { userId: "owner", webEnabled: true, approveWeb: activity.approveWeb }, async () => { requests++; return new Response("page"); });
  await new Promise((resolve) => setImmediate(resolve));
  const customId = panel.components[0].toJSON().components[1].custom_id;
  let refusal;
  await handleChatActivity({ customId, user: { id: "other" }, reply: async (data) => { refusal = data.content; } });
  assert.match(refusal, /Only the requester/);
  assert.equal(requests, 0);
  await handleChatActivity({ customId, user: { id: "owner" }, update: async () => {} });
  await assert.rejects(operation, /not approved/);
  assert.equal(requests, 0);
  await handleChatActivity({ customId, user: { id: "owner" }, reply: async (data) => { refusal = data.content; } });
  assert.match(refusal, /already used/);
});

test("each web call needs approval, including previously approved websites", async () => {
  let approvals = 0; let requests = 0;
  const context = { webEnabled: true, userId: "approval-repeat", approveWeb: async (url) => { assert.equal(url, "https://example.org/page"); approvals++; return true; } };
  const fetchImpl = async () => { requests++; return new Response("Hello", { headers: { "content-type": "text/plain" } }); };
  for (let i = 0; i < 2; i++) await executeHelperTool("read_web_page", { url: "https://example.org/page" }, context, fetchImpl);
  assert.equal(approvals, 2); assert.equal(requests, 2);
  await assert.rejects(executeHelperTool("search_web", { query: "duck" }, { webEnabled: true }, fetchImpl), /not approved/);
  assert.equal(requests, 2);
});

test("activity uses actual observations and elapsed time and preserves existing buttons", async () => {
  let now = 0;
  const activity = createChatActivity("owner", async () => {}, () => now);
  await activity.update("search_web", { results: [{}, {}, {}] });
  await activity.update("reverse_image_search", { url: "https://lens.google.com/" });
  now = 7000;
  const final = activity.finish({ content: "Answer", components: [{ type: 1, components: [] }] });
  assert.equal(final.components.length, 2);
  const button = final.components[1].toJSON().components[0];
  assert.match(button.label, /Worked for 7s/);
  // Use a current clock for the click-through privacy check.
  const live = createChatActivity("owner", async () => {});
  await live.update("search_web", { results: [{}, {}, {}] });
  const liveButton = live.finish({}).components[0].toJSON().components[0];
  let reply;
  await handleChatActivity({ customId: liveButton.custom_id, user: { id: "owner" }, reply: async (data) => { reply = data; } });
  assert.match(reply.content, /Found 3 search results/);
  assert.ok(!reply.content.includes("Searched 3 websites"));
  await handleChatActivity({ customId: liveButton.custom_id, user: { id: "other" }, reply: async (data) => { reply = data; } });
  assert.match(reply.content, /Only the person/);
});

test("public web reader blocks private and reserved address ranges", () => {
  for (const ip of ["0.0.0.0", "10.1.2.3", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "100.64.0.1", "198.18.0.1", "224.0.0.1", "::1"]) assert.equal(publicIpv4(ip), false, ip);
  assert.equal(publicIpv4("8.8.8.8"), true);
  for (const url of ["http://example.org", "https://user:pass@example.org", "https://example.org:8443", "https://[::1]", "https://localhost"]) assert.throws(() => publicWebUrl(url));
  assert.equal(publicWebUrl("https://example.org/page").href, "https://example.org/page");
});
