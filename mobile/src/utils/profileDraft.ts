/** Values for a PATCH are deliberately three-state:
 * - undefined: the field is unchanged and must be omitted;
 * - null: the user explicitly cleared it;
 * - string: a newly uploaded URL should replace it. */
export function mediaPatchValue(
  originalUrl: string | null | undefined,
  draftUrl: string,
  uploadedUrl?: string,
): string | null | undefined {
  if (uploadedUrl) return uploadedUrl.trim();

  const original = (originalUrl ?? '').trim();
  const draft = draftUrl.trim();
  if (draft === original) return undefined;
  return draft || null;
}

export function hasPersistedHome(user: {
  home_lat?: number | null;
  home_lng?: number | null;
  home_label?: string | null;
} | null | undefined): boolean {
  return Boolean(user?.home_label?.trim()) || user?.home_lat != null || user?.home_lng != null;
}
