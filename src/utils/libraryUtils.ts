import { PlaylistTrack, LibraryStats, TagInfo, AudioLoader, getCachedLibrary, setCachedLibrary } from '../audioLoader';

export const formatTime = (seconds: number): string => {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

export const loadLibraryWithFilters = async (
  loader: AudioLoader,
  minRating: number,
  selectedTags: string[],
  untaggedOnly: boolean,
  searchQuery: string,
  sortBy: string
): Promise<PlaylistTrack[]> => {
  const { tracks } = await loader.fetchLibrary({
    ratingGte: minRating,
    tags: selectedTags.length > 0 ? selectedTags : undefined,
    untagged: untaggedOnly,
    search: searchQuery || undefined,
    sortBy: sortBy as any,
    sortDesc: true,
    limit: 1000
  });
  return tracks;
};

export const getCachedLibraryData = () => {
  return getCachedLibrary();
};

export const setCachedLibraryData = (
  tracks: PlaylistTrack[],
  tags: TagInfo[],
  stats: LibraryStats
) => {
  setCachedLibrary(tracks, tags, stats);
};

export const updateTrackInLibrary = (
  library: PlaylistTrack[],
  trackId: string,
  updates: Partial<PlaylistTrack>
): PlaylistTrack[] => {
  return library.map(t => t.id === trackId ? { ...t, ...updates } : t);
};

export const removeTrackFromLibrary = (
  library: PlaylistTrack[],
  trackId: string
): PlaylistTrack[] => {
  return library.filter(t => t.id !== trackId);
};

export const findSimilarTracks = async (
  loader: AudioLoader,
  currentTrackId: string,
  tags: string[],
  limit: number,
  maxTracks: number
): Promise<PlaylistTrack[]> => {
  return loader.findSimilarTracks(currentTrackId, tags, limit, maxTracks);
};
