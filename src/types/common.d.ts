export interface Article {
  id: number | string;
  title: string;
  url: string;
  canonicalUrl?: string;
  created_at: string;
}
