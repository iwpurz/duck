// Some providers leak their model's internal tool serialization into content.
// Never execute that text or present it as an answer; require native tool_calls.
export function hasRawToolMarkup(content) {
  return typeof content === "string" && /<(?:\|)?\/?(?:tool_calls?|tool_sep|arg_key|arg_value)(?=[:\s>|])|<\|(?:tool_call_begin|tool_call_end|tool_calls_begin|tool_calls_end)\|>/i.test(content);
}

export const TOOL_FORMAT_RETRY = "Your last response used invalid internal tool markup. If a tool is needed, call it using the API's native tool_calls field with valid JSON arguments. Otherwise write a normal user-facing answer. Never print tool serialization tags. No tool has run from that invalid text; do not claim you searched or read anything unless actual tool results are present.";
export const TOOL_FORMAT_ERROR = "Duck's AI model returned an invalid tool request. No web request was sent from it. Please try again or select another model.";
