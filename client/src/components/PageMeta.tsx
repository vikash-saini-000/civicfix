import { useEffect } from 'react';

const DEFAULT_DESCRIPTION = 'Report civic problems and track them until the fix is verified.';

export function PageMeta({ title, description = DEFAULT_DESCRIPTION }: { title: string; description?: string }) {
  useEffect(() => {
    document.title = title === 'CivicFix' ? title : `${title} · CivicFix`;
    const descriptionTag = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    descriptionTag?.setAttribute('content', description);
  }, [description, title]);

  return null;
}
