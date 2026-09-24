// ntfy's public hosted service uses topic URLs such as
// https://ntfy.sh/my-topic. Keep this narrowly scoped so ordinary webhooks
// continue receiving Aura's existing JSON payload unchanged.
export function isHostedNtfyTopicUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "ntfy.sh" && url.pathname.length > 1;
  } catch {
    return false;
  }
}

// Fetch header values are ByteStrings, so a raw Hebrew/emoji alert message
// throws before the ntfy request starts. ntfy supports RFC 2047 encoded
// headers; 45 UTF-8 bytes per word keeps each encoded-word below 75 chars.
export function encodeNtfyHeader(value) {
  const text = String(value || "").replace(/[\r\n]+/g, " ").slice(0, 1000);
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  const encoder = new TextEncoder();
  const words = [];
  let bytes = [];
  const pushWord = () => {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    words.push(`=?UTF-8?B?${btoa(binary)}?=`);
  };
  // Iterate code points, not UTF-16 units, so a chunk never divides one
  // UTF-8 character and leaves ntfy with an invalid encoded-word.
  for (const character of text) {
    const next = [...encoder.encode(character)];
    if (bytes.length && bytes.length + next.length > 45) {
      pushWord();
      bytes = [];
    }
    bytes.push(...next);
  }
  if (bytes.length) pushWord();
  return words.join(" ");
}
