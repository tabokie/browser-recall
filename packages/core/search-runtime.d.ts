export const RankingAlgorithm: Readonly<{
  Content: 0;
  0: 'Content';
}>;

export type SearchQueryWord = {
  text: string;
  exact: boolean;
};

export function parseSearchQueryWords(query: string): SearchQueryWord[];

export function scoreSearchFields(
  words: SearchQueryWord[],
  fields: Array<{ text?: string | null; weight: number }>,
): number | null;

export class HistoryEntry {
  constructor(url: string, title: string);
  content: string;
  timestamp: bigint;
  title: string;
  userTitle: string;
  url: string;
  free(): void;
  setContent(content: string): void;
  [Symbol.dispose](): void;
}

export class SearchEngine {
  constructor();
  addEntry(entry: HistoryEntry): void;
  free(): void;
  search(
    query: string,
    algorithm?: number,
  ): Promise<
    Array<{
      url: string;
      title: string;
      timestamp: number;
      score: number;
    }>
  >;
  [Symbol.dispose](): void;
}
