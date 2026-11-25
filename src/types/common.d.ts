export interface Article {
  id: number | string;
  title: string;
  url: string;
  givenUrl?: string;
  canonicalUrl?: string;
  canonicalGivenUrl?: string;
  created_at: string;
}
