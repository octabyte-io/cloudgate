import slug from 'slugify';

/** Strip non-alphanumerics (empty becomes `service`), then strict slugify. */
export const slugify = (text: string | undefined) => {
  if (!text) {
    return '';
  }

  const cleanedText = text.trim().replace(/[^a-zA-Z0-9\s]/g, '') || 'service';

  return slug(cleanedText, {
    lower: true,
    trim: true,
    strict: true,
  });
};
