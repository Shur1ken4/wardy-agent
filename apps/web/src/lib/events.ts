// Reads server-sent events from a fetch response. The browser's own EventSource can't send a credential except in the
// URL, and a credential doesn't belong in a URL.
export interface ServerEvent {
  event: string;
  data: unknown;
}

/** Takes text in any size of chunk, and calls back once per complete event. Comments and bad JSON are skipped. */
export function createEventParser(onEvent: (event: ServerEvent) => void) {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    let end = buffer.indexOf("\n\n");
    while (end >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      end = buffer.indexOf("\n\n");
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (data.length === 0) continue;
      try {
        onEvent({ event, data: JSON.parse(data.join("\n")) });
      } catch {
        // A line we can't read isn't worth stopping the feed for.
      }
    }
  };
}

export async function readEvents(response: Response, onEvent: (event: ServerEvent) => void): Promise<void> {
  if (!response.body) return;
  const parse = createEventParser(onEvent);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    parse(value);
  }
}
