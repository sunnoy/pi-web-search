import { titleFromUrl } from "./results.ts";

export interface AnthropicServerTools {
    search: boolean;
    fetch: boolean;
}

export interface FetchedDocument {
    url: string;
    title: string;
}

export function buildAnthropicServerTools(enabled: AnthropicServerTools): any[] {
    const tools: any[] = [];
    if (enabled.search) {
        tools.push({
            type: "web_search_20260209",
            name: "web_search",
            max_uses: 10,
            // Keep direct search compatible with models without programmatic tool calling.
            allowed_callers: ["direct"],
        });
    }
    if (enabled.fetch) {
        tools.push({
            type: "web_fetch_20260318",
            name: "web_fetch",
            max_uses: 10,
            allowed_callers: ["direct"],
            citations: { enabled: true },
            max_content_tokens: 50000,
        });
    }
    return tools;
}

/**
 * Describe a successful web_fetch result without its document body: PDF/base64
 * payloads can be very large and must not end up in tool details.
 */
export function describeFetchedDocument(result: any): { document: FetchedDocument; raw: Record<string, any> } {
    const url: string = result.url;
    const doc = result.content;
    const title: string = doc?.title || titleFromUrl(url);
    return {
        document: { url, title },
        raw: {
            url,
            title,
            retrievedAt: result.retrieved_at,
            documentType: doc?.type,
            mediaType: doc?.source?.media_type,
            sourceType: doc?.source?.type,
        },
    };
}

/**
 * char_location citations carry no URL. Match the cited document by title
 * first, then by index into the fetch order; otherwise the citation is dropped.
 */
export function resolveFetchedDocument(citation: any, fetched: FetchedDocument[]): FetchedDocument | undefined {
    const title = citation?.document_title;
    if (title) {
        const matches = fetched.filter((doc) => doc.title === title);
        if (matches.length === 1) return matches[0];
    }
    const index = citation?.document_index;
    if (Number.isInteger(index)) return fetched[index];
    return undefined;
}
