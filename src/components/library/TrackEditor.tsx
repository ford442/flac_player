import React from 'react';
import type { PlaylistTrack } from '../../types/library';
import { StarRating } from '../StarRating';
import { TagInput } from '../TagInput';
import { MusicBrainzPanel } from '../MusicBrainzPanel';
import type { TrackEditing } from './useTrackEditing';

interface TrackEditorProps {
  track: PlaylistTrack;
  editing: TrackEditing;
  tagNames: string[];
  onNotify?: (message: string, type: 'success' | 'error' | 'info') => void;
  className?: string;
}

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

/** Rating, tags and MusicBrainz lookup for one track: the card overlay and the list's expanded row. */
export const TrackEditor: React.FC<TrackEditorProps> = ({ track, editing, tagNames, onNotify, className = '' }) => {
  const { state } = editing;
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- containment, see below
    <div
      className={`flex flex-col gap-3 ${className}`}
      // Clicks and keys stay in the editor instead of playing the card/row underneath.
      onClick={stop}
      onDoubleClick={stop}
      onKeyDown={stop}
      role="group"
      aria-label={`Edit ${track.title || track.name}`}
    >
      <div>
        <span className="text-xs text-gray-400">Rating</span>
        <StarRating rating={state.rating} maxRating={5} onRate={editing.setRating} showTrash />
      </div>
      <div className="flex-1">
        <span className="text-xs text-gray-400">Tags</span>
        <TagInput
          tags={state.tags}
          availableTags={tagNames}
          onChange={editing.setTags}
          maxTags={8}
          suggestedTags={state.suggestedTags}
          suggestionsLoading={state.suggestionsLoading}
        />
      </div>
      <button
        type="button"
        onClick={editing.toggleMusicBrainz}
        aria-expanded={state.showMusicBrainz}
        className="self-start text-xs text-purple-300 hover:text-purple-200 underline"
      >
        {state.showMusicBrainz ? 'Hide MusicBrainz' : 'Look up on MusicBrainz'}
      </button>
      {state.showMusicBrainz && (
        <MusicBrainzPanel
          track={track}
          onApply={(updates) => editing.applyMetadata(track, updates)}
          onNotify={onNotify}
          onClose={editing.toggleMusicBrainz}
        />
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => { void editing.save(); }}
          disabled={state.isSaving}
          className="flex-1 px-3 py-1.5 bg-purple-600 text-white rounded text-sm hover:bg-purple-700 disabled:opacity-50"
        >
          {state.isSaving ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={editing.cancel}
          className="px-3 py-1.5 bg-white/10 text-white rounded text-sm hover:bg-white/20"
        >
          Cancel
        </button>
      </div>
    </div>
  );
};
