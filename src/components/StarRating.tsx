import React, { useState } from 'react';

interface StarRatingProps {
  rating: number | undefined;
  maxRating?: number;
  onRate?: (rating: number) => void;
  size?: 'sm' | 'md' | 'lg';
  readonly?: boolean;
  showTrash?: boolean;
}

export const StarRating: React.FC<StarRatingProps> = ({
  rating,
  maxRating = 5,
  onRate,
  size = 'md',
  readonly = false,
  showTrash = false
}) => {
  const [hoverRating, setHoverRating] = useState<number | null>(null);
  
  const displayRating = hoverRating ?? (rating || 0);
  const isTrash = rating === 0 && showTrash;
  
  const sizeClass = {
    sm: 'text-sm',
    md: 'text-lg',
    lg: 'text-2xl'
  }[size];
  
  const handleClick = (value: number) => {
    if (!readonly && onRate) {
      onRate(value);
    }
  };
  
  const current = rating || 0;
  const stars = Array.from({ length: maxRating }, (_, i) => i + 1);

  if (readonly || !onRate) {
    return (
      <span
        className={`star-rating inline-flex gap-0.5 ${sizeClass}`}
        role="img"
        aria-label={isTrash ? 'Marked as trash' : current ? `Rated ${current} of ${maxRating}` : 'Not rated'}
        title={isTrash ? 'Marked as trash' : undefined}
      >
        {isTrash ? <span className="text-red-500" aria-hidden="true">🗑️</span> : stars.map(star => (
          <span key={star} aria-hidden="true" className={star <= current ? 'text-yellow-400' : 'text-gray-600'}>★</span>
        ))}
      </span>
    );
  }

  // Roving tabindex radiogroup: arrows change the value, Home/End jump, 0 = trash when enabled.
  const minValue = showTrash ? 0 : 1;
  const focusedValue = rating === undefined ? (showTrash ? 1 : minValue) : rating;
  const handleKeyDown = (e: React.KeyboardEvent) => {
    let next: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = Math.min(maxRating, focusedValue + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = Math.max(minValue, focusedValue - 1);
    else if (e.key === 'Home') next = minValue;
    else if (e.key === 'End') next = maxRating;
    else if (/^[0-9]$/.test(e.key)) {
      const n = Number(e.key);
      if (n >= minValue && n <= maxRating) next = n;
    }
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    handleClick(next);
    const group = e.currentTarget as HTMLElement;
    requestAnimationFrame(() => group.querySelector<HTMLElement>(`[data-value="${next}"]`)?.focus());
  };

  const radioClass = 'transition-colors rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-purple-400';

  return (
    <div
      className={`star-rating inline-flex gap-0.5 cursor-pointer ${sizeClass}`}
      role="radiogroup"
      aria-label="Rating"
      onMouseLeave={() => setHoverRating(null)}
      onKeyDown={handleKeyDown}
    >
      {showTrash && (
        <button
          type="button"
          role="radio"
          data-value={0}
          aria-checked={rating === 0}
          aria-label="Trash"
          tabIndex={focusedValue === 0 ? 0 : -1}
          className={`${radioClass} ${isTrash ? 'opacity-100 text-red-500' : 'opacity-50 hover:opacity-100'}`}
          onClick={(e) => { e.stopPropagation(); handleClick(0); }}
          title="Mark as trash"
        >
          🗑️
        </button>
      )}
      {stars.map((star) => (
        <button
          type="button"
          role="radio"
          key={star}
          data-value={star}
          aria-checked={rating === star}
          aria-label={`${star} star${star === 1 ? '' : 's'}`}
          tabIndex={focusedValue === star ? 0 : -1}
          className={`${radioClass} ${
            !isTrash && star <= displayRating
              ? 'text-yellow-400'
              : 'text-gray-600 hover:text-gray-400'
          }`}
          onMouseEnter={() => setHoverRating(star)}
          onClick={(e) => { e.stopPropagation(); handleClick(star); }}
        >
          ★
        </button>
      ))}
    </div>
  );
};
