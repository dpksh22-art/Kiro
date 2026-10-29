export async function* parseSse(response: Response): AsyncGenerator<{ event?: string; data: string }> {
  if (!response.body) throw new Error("Provider response has no stream body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event: string | undefined;
  let data: string[] = [];

  const emit = () => {
    if (data.length === 0) return undefined;
    const value = { event, data: data.join("\n") };
    event = undefined;
    data = [];
    return value;
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = done ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      if (line === "") {
        const item = emit();
        if (item) yield item;
      } else if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (done) break;
  }
  const item = emit();
  if (item) yield item;
}

export async function* parseNdjson(response: Response): AsyncGenerator<unknown> {
  if (!response.body) throw new Error("Provider response has no stream body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = done ? "" : (lines.pop() ?? "");
    for (const line of lines) if (line.trim()) yield JSON.parse(line);
    if (done) break;
  }
  if (buffer.trim()) yield JSON.parse(buffer);
}
