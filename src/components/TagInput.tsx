import React, { useState, useRef, useEffect, useId } from 'react';

interface TagInputProps {
  tags: string[];
  availableTags: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
  maxTags?: number;
  /** Tags suggested for this track by the API (`/suggest-tags`); shown as one-click chips. */
  suggestedTags?: string[];
  /** True while suggestions are being fetched. */
  suggestionsLoading?: boolean;
  label?: string;
}

export const TagInput: React.FC<TagInputProps> = ({
  tags,
  availableTags,
  onChange,
  placeholder = 'Add tags...',
  maxTags = 10,
  suggestedTags = [],
  suggestionsLoading = false,
  label = 'Tags'
}) => {
  const listboxId = useId();
  const [inputValue, setInputValue] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  const normalizedInput = inputValue.toLowerCase().trim();
  
  // Filter suggestions based on input
  const suggestions = normalizedInput
    ? availableTags
        .filter(tag => 
          tag.toLowerCase().includes(normalizedInput) &&
          !tags.includes(tag)
        )
        .slice(0, 8)
    : availableTags
        .filter(tag => !tags.includes(tag))
        .slice(0, 5);
  
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);
  
  const addTag = (tag: string) => {
    const trimmed = tag.trim();
    if (trimmed && !tags.includes(trimmed) && tags.length < maxTags) {
      onChange([...tags, trimmed]);
    }
    setInputValue('');
    setShowSuggestions(false);
    inputRef.current?.focus();
  };
  
  const removeTag = (tagToRemove: string) => {
    onChange(tags.filter(tag => tag !== tagToRemove));
  };
  
  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Typing in the input shouldn't reach row-level key handlers (Escape may bubble to close the editor).
    if (e.key !== 'Escape') e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      if (suggestions[selectedIndex]) {
        addTag(suggestions[selectedIndex]);
      } else if (inputValue.trim()) {
        addTag(inputValue);
      }
    } else if (e.key === 'Backspace' && !inputValue && tags.length > 0) {
      removeTag(tags[tags.length - 1]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev => (prev + 1) % Math.max(suggestions.length, 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(prev => (prev - 1 + suggestions.length) % Math.max(suggestions.length, 1));
    } else if (e.key === 'Escape') {
      if (showSuggestions) e.stopPropagation();
      setShowSuggestions(false);
    }
  };
  
  return (
    <div ref={containerRef} className="tag-input relative">
      <div className="flex flex-wrap gap-1.5 p-2 bg-white/10 border border-white/20 rounded-lg min-h-[40px]">
        {tags.map(tag => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 px-2 py-0.5 bg-purple-500/30 text-purple-200 text-sm rounded-full"
          >
            {tag}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); removeTag(tag); inputRef.current?.focus(); }}
              aria-label={`Remove tag ${tag}`}
              className="hover:text-white transition-colors rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-purple-400"
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => {
            setInputValue(e.target.value);
            setShowSuggestions(true);
            setSelectedIndex(0);
          }}
          onKeyDown={handleKeyDown}
          onFocus={() => setShowSuggestions(true)}
          placeholder={tags.length === 0 ? placeholder : ''}
          role="combobox"
          aria-label={label}
          aria-autocomplete="list"
          aria-expanded={showSuggestions && suggestions.length > 0}
          aria-controls={listboxId}
          aria-activedescendant={showSuggestions && suggestions[selectedIndex] ? `${listboxId}-${selectedIndex}` : undefined}
          onClick={(e) => e.stopPropagation()}
          className="flex-1 min-w-[80px] bg-transparent text-white placeholder-gray-500 outline-none text-sm"
        />
      </div>
      
      {showSuggestions && suggestions.length > 0 && (
        <div id={listboxId} role="listbox" aria-label={`${label} suggestions`} className="absolute z-50 mt-1 w-full bg-[#1a1a2e] border border-white/20 rounded-lg shadow-xl max-h-48 overflow-auto">
          {suggestions.map((suggestion, index) => (
            <button
              type="button"
              key={suggestion}
              id={`${listboxId}-${index}`}
              role="option"
              aria-selected={index === selectedIndex}
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => { e.stopPropagation(); addTag(suggestion); }}
              className={`w-full text-left px-3 py-2 text-sm transition-colors ${
                index === selectedIndex
                  ? 'bg-purple-500/30 text-white'
                  : 'text-gray-300 hover:bg-white/10'
              }`}
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}
      {(suggestionsLoading || suggestedTags.some(t => !tags.includes(t))) && (
        <div className="mt-1 flex flex-wrap items-center gap-1 text-xs" aria-label="Suggested tags" role="group">
          <span className="text-gray-500">{suggestionsLoading ? 'Finding suggestions…' : 'Suggested:'}</span>
          {suggestedTags.filter(t => !tags.includes(t)).slice(0, 8).map(tag => (
            <button
              type="button"
              key={tag}
              onClick={(e) => { e.stopPropagation(); addTag(tag); }}
              disabled={tags.length >= maxTags}
              aria-label={`Add suggested tag ${tag}`}
              className="px-1.5 py-0.5 rounded-full border border-dashed border-purple-400/50 text-purple-200 hover:bg-purple-500/20 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-purple-400"
            >
              + {tag}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
