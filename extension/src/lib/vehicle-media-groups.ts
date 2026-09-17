import type { Database } from './database.types';

type MediaClassification = Pick<
  Database['public']['Tables']['vehicle_media']['Row'],
  'media_type' | 'caption'
>;

/** Existing spec storage, with an explicit marker for reference documents. */
export const CERTIFICATION_TEMPLATE_PREFIX = '[certification-template] ';

export function isCertificationTemplate(media: MediaClassification): boolean {
  return media.media_type === 'spec'
    && !!media.caption?.startsWith(CERTIFICATION_TEMPLATE_PREFIX);
}

export function groupVehicleMedia<T extends MediaClassification>(items: readonly T[]) {
  const groups: { image: T[]; video: T[]; spec: T[]; certificationTemplates: T[] } = {
    image: [], video: [], spec: [], certificationTemplates: [],
  };
  for (const item of items) {
    if (isCertificationTemplate(item)) groups.certificationTemplates.push(item);
    else groups[item.media_type].push(item);
  }
  return groups;
}

export function displayVehicleMediaCaption(media: MediaClassification): string {
  return isCertificationTemplate(media)
    ? media.caption!.slice(CERTIFICATION_TEMPLATE_PREFIX.length)
    : media.caption ?? '';
}

/** Editing or clearing a note must not silently reclassify a reference as a spec sheet. */
export function updatedVehicleMediaCaption(media: MediaClassification, caption: string): string | null {
  return isCertificationTemplate(media)
    ? CERTIFICATION_TEMPLATE_PREFIX + caption.trim()
    : caption.trim() || null;
}
