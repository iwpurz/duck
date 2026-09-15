function getOpenRouterChatEndpoint() {
  const gatewayToken = String(process.env.CLOUDFLARE_GATEWAY_API_TOKEN || "").trim();
  if (!gatewayToken) return "https://openrouter.ai/api/v1/chat/completions";
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || "61c882f49c7471d3aecb09ecbd3fc374";
  const gatewayId = process.env.CLOUDFLARE_GATEWAY_ID || "ai-openrouter-gateway";
  return `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(accountId)}/${encodeURIComponent(gatewayId)}/openrouter/chat/completions`;
}

function getOpenRouterChatApiKey() {
  return String(process.env.OPENROUTER_API_KEY || process.env.AI_API_KEY || "").trim();
}

function getOpenRouterGatewayHeaders() {
  const token = String(process.env.CLOUDFLARE_GATEWAY_API_TOKEN || "").trim();
  return token ? { "cf-aig-authorization": `Bearer ${token}` } : {};
}

export { getOpenRouterChatEndpoint, getOpenRouterChatApiKey, getOpenRouterGatewayHeaders };
