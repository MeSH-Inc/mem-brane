import { useEffect, useState, type ImgHTMLAttributes } from 'react';
import { replica } from '../services/api';
import { localAsset } from '../services/local-assets';
export function useAssetUrl(id: string) {
  const [asset, setAsset] = useState<{ id: string; url: string }>();
  const [error, setError] = useState('');
  useEffect(() => {
    if (!replica.actor) return;
    let active = true;
    let url: string | undefined;
    setError('');
    void localAsset(id)
      .then((blob) => {
        if (active) {
          url = URL.createObjectURL(blob);
          setAsset({ id, url });
        }
      })
      .catch(() => {
        if (active)
          setError(
            'Attachment is not saved on this device. Reconnect and reopen this brane to download it.',
          );
      });
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [id, replica.actor]);
  return {
    url: !replica.actor ? `/api/assets/${id}` : asset?.id === id ? asset.url : undefined,
    error,
  };
}
export function LocalImage({
  assetId,
  ...props
}: Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & { assetId: string }) {
  const { url, error } = useAssetUrl(assetId);
  return error ? <p>{error}</p> : url ? <img {...props} src={url} /> : <p>Loading image…</p>;
}
