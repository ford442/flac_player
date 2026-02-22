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
  
  if (isTrash) {
    return (
      <span className={`${sizeClass} text-red-500`} title="Marked as trash">
        🗑️
      </span>
    );
  }
  
  return (
    <div 
      className={`star-rating inline-flex gap-0.5 ${readonly ? '' : 'cursor-pointer'}`}
      onMouseLeave={() => setHoverRating(null)}
    >
      {showTrash && (
        <button
          className={`${sizeClass} opacity-50 hover:opacity-100 hover:text-red-500 transition-opacity`}
          onClick={() => handleClick(0)}
          title="Mark as trash"
        >
          🗑️
        </button>
      )}
      {Array.from({ length: maxRating }, (_, i) => i + 1).map((star) => (
        <span
          key={star}
          className={`${sizeClass} transition-colors ${
            star <= displayRating 
              ? 'text-yellow-400' 
              : 'text-gray-600 hover:text-gray-400'
          }`}
          onMouseEnter={() => !readonly && setHoverRating(star)}
          onClick={() => handleClick(star)}
        >
          ★
        </span>
      ))}
    </div>
  );
};
