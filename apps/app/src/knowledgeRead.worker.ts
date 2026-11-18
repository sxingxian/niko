// Reads a file's text into pieces and sheets in a background thread (see prepare in knowledge.ts), so a huge or
// hostile file can't freeze the page; the page stops this thread if it runs past its time limit.
import { prepareText, type KnKind } from '@niko/shared';

self.onmessage = (e: MessageEvent<{ kind: KnKind; name: string; text: string; fromCloudflare: boolean }>) => {
  try { self.postMessage({ ok: true, out: prepareText(e.data.kind, e.data.name, e.data.text, e.data.fromCloudflare) }); }
  catch (err) { self.postMessage({ ok: false, error: (err as Error)?.message || 'That file couldn’t be read.' }); }
};
