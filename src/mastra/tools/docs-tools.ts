import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

const indexUrl = 'https://mastra.ai/llms.txt';
let cachedIndex: { text: string; expiresAt: number } | undefined;

async function fetchMarkdown(url: string) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  if (!response.ok) {
    throw new Error(`Documentation request failed: ${response.status} ${url}`);
  }
  return response.text();
}

async function getPages() {
  if (!cachedIndex || cachedIndex.expiresAt <= Date.now()) {
    const text = await fetchMarkdown(indexUrl);
    cachedIndex = { text, expiresAt: Date.now() + 5 * 60_000 };
  }

  return Array.from(
    cachedIndex.text.matchAll(/\[([^\]]+)\]\((https:\/\/mastra\.ai\/[^\s)]+)\)/g),
    ([, title, url]) => ({ title, url }),
  );
}

export const searchDocs = createTool({
  id: 'search-docs',
  description:
    'Find documentation pages in mastra.ai/llms.txt by title and URL. This searches the index, not page contents. Use short topic keywords; matching any keyword returns a result, ranked by how many match.',
  inputSchema: z.object({
    keywords: z.array(z.string().trim().min(1)).min(1).max(6)
      .describe('Topic keywords, e.g. ["memory", "threads"] or ["createTool"].'),
  }),
  execute: async ({ keywords }) => {
    const terms = [...new Set(keywords.map(keyword => keyword.toLowerCase()))];
    const matches = (await getPages())
      .map(page => ({
        ...page,
        score: terms.filter(term => `${page.title} ${page.url}`.toLowerCase().includes(term)).length,
      }))
      .filter(page => page.score > 0)
      .sort((a, b) => b.score - a.score);

    return {
      source: indexUrl,
      totalMatches: matches.length,
      pages: matches.slice(0, 20).map(({ title, url }) => ({ title, url })),
    };
  },
});

export const readDocs = createTool({
  id: 'read-docs',
  description:
    'Read the full Markdown of a Mastra documentation page found with searchDocs. Returns a source URL to cite in the answer.',
  inputSchema: z.object({
    url: z.url().describe('The exact Markdown page URL returned by searchDocs.'),
  }),
  execute: async ({ url }) => {
    const page = (await getPages()).find(page => page.url === url);
    if (!page) {
      throw new Error('Choose a page URL returned by searchDocs. Only indexed Mastra pages can be read.');
    }
    return {
      title: page.title,
      url: page.url.replace(/\.md$/, ''),
      content: await fetchMarkdown(page.url),
    };
  },
});
