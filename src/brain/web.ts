/** Looking things up: a quick web search and a Wikipedia summary. No key, no account. */
import type { Fetch } from './weather';

const strip = (html: string): string =>
  html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15' };

export type Hit = { title: string; snippet: string; url: string };

export function parseDuck(html: string): Hit[] {
  const out: Hit[] = [];
  // Each result starts at its title link; the snippet, if any, follows before the next title.
  const chunks = html.split(/(?=<a[^>]+class="[^"]*result__a)/).slice(1);
  for (const chunk of chunks.slice(0, 6)) {
    const link = chunk.match(/^<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    let url = link[1].replace(/&amp;/g, '&');
    const redirect = url.match(/[?&]uddg=([^&]+)/);
    if (redirect) url = decodeURIComponent(redirect[1]);
    if (url.startsWith('//')) url = 'https:' + url;
    const snip = chunk.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div|span)>/);
    out.push({ title: strip(link[2]), snippet: strip(snip?.[1] ?? ''), url });
  }
  return out;
}

export async function webSearch(fetcher: Fetch, query: string): Promise<Hit[]> {
  const res = await fetcher(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { headers: UA });
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  return parseDuck(await res.text());
}

export async function wikipedia(fetcher: Fetch, query: string): Promise<{ title: string; extract: string; url: string } | null> {
  const s = await fetcher(`https://en.wikipedia.org/w/api.php?action=query&list=search&srlimit=1&format=json&srsearch=${encodeURIComponent(query)}`, { headers: UA });
  if (!s.ok) return null;
  const title = ((await s.json()) as { query?: { search?: { title: string }[] } }).query?.search?.[0]?.title;
  if (!title) return null;
  const r = await fetcher(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`, { headers: UA });
  if (!r.ok) return null;
  const j = (await r.json()) as { title: string; extract?: string; content_urls?: { desktop?: { page?: string } } };
  return j.extract ? { title: j.title, extract: j.extract, url: j.content_urls?.desktop?.page ?? '' } : null;
}

export async function readPage(fetcher: Fetch, url: string, max = 2500): Promise<string> {
  const res = await fetcher(url, { headers: UA });
  if (!res.ok) throw new Error(`Could not open the page (${res.status})`);
  return strip(await res.text()).slice(0, max);
}
