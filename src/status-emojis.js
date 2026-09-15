const STATUS_EMOJIS = Object.freeze({
  thinking: "<a:thinking:1549172822058737775>",
  loading: "<a:loading:1549171575675293888>",
});

function statusTitle(title, status) {
  return STATUS_EMOJIS[status] ? `${STATUS_EMOJIS[status]} ${title}` : title;
}

function statusPayload(status) {
  return {
    content: null,
    embeds: [{ title: statusTitle(status === "thinking" ? "Duck is thinking" : "Loading", status), color: 0x718096 }],
    allowedMentions: { parse: [] },
  };
}

export { STATUS_EMOJIS, statusTitle, statusPayload };
