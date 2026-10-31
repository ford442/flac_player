// Load a track from a URL, or queue the demo playlist.
import React, { useCallback, useState } from 'react';
import './UrlLoader.css';

interface UrlLoaderProps {
  /** Returns an error message, or null when the URL was accepted. */
  onLoadUrl: (url: string) => string | null;
  onLoadDemo: () => void;
}

export const UrlLoader: React.FC<UrlLoaderProps> = ({ onLoadUrl, onLoadDemo }) => {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    const result = onLoadUrl(value);
    setError(result);
    if (!result) setValue('');
  }, [value, onLoadUrl]);

  return (
    <div className="url-loader">
      <form className="url-loader__form" onSubmit={submit} noValidate>
        <input
          type="url"
          className="url-loader__input"
          placeholder="https://…/track.flac"
          aria-label="Track URL"
          value={value}
          onChange={(e) => { setValue(e.target.value); setError(null); }}
        />
        <button type="submit" className="url-loader__btn" disabled={!value.trim()}>Load</button>
      </form>
      {error && <div className="url-loader__error" role="alert">{error}</div>}
      <button type="button" className="url-loader__btn url-loader__demo" onClick={onLoadDemo}>
        ▶ Demo playlist
      </button>
    </div>
  );
};

export default UrlLoader;
