/** Caller delimiters are per request; literal boundary tags never retain markup syntax. */
export function neutralizeCallerText(text: string): string {
  return text.replace(/<\/?(?:requested_action|context)/gi, (tag) => `&lt;${tag.slice(1)}`);
}

export function createBoundary(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (n) => n.toString(16).padStart(2, '0')).join('');
}

export function wrapCaller(kind: 'requested_action' | 'context', text: string, boundary: string): string {
  if (!/^[0-9a-f]{16}$/.test(boundary)) throw new Error('Invalid caller boundary');
  return `<${kind} id='${boundary}'>\n${neutralizeCallerText(text)}\n</${kind} id='${boundary}'>`;
}

/** Keep the useful beginning and end, counting the omission marker in the budget. */
export function excerpt(text: string, maxChars: number, marker: string): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 0) return '';
  if (maxChars <= marker.length) return marker.slice(0, maxChars);
  const keep = maxChars - marker.length;
  return text.slice(0, Math.ceil(keep / 2)) + marker + text.slice(text.length - Math.floor(keep / 2));
}
