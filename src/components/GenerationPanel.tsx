import { useEffect, useMemo, useRef, useState } from 'react';
import { PlaylistTrack } from '../audioLoader';
import {
  fetchGenerationJob,
  GenerationApiError,
  GenerationJob,
  GenerationRequest,
  GenerationService,
  submitGeneration,
} from '../api/generationApi';

interface GenerationDraft {
  title: string;
  service: GenerationService;
  prompt: string;
  lyrics: string;
  style: string;
}

interface GenerationPanelProps {
  variationTrack?: PlaylistTrack | null;
  onCompleted: (songId: string) => Promise<void> | void;
  onVariationConsumed?: () => void;
}

const CURATED_PROMPTS: GenerationDraft[] = [
  {
    title: 'The Viking Mariachi',
    service: 'minimax',
    prompt: 'A mournful Nordic Viking folk song driven by bowed lyre and frame drum that erupts into a lively Mexican Mariachi serenade with trumpets and vihuelas, while the lyrics remain focused on Valhalla and raiding.',
    lyrics: 'The longship sails into the freezing mist...\nAy, ay, ay! Valhalla is calling to me!',
    style: 'Nordic folk and traditional Mariachi fusion; cinematic dynamic transition; full-throated lead vocal.',
  },
  {
    title: 'Gregorian Breakcore',
    service: 'minimax',
    prompt: 'A frantic 220 BPM Breakcore track with chopped Amen breaks and distorted gabber kicks, built around a solemn reverb-heavy choir of medieval monks singing Latin Gregorian chants in time with the chaos.',
    lyrics: 'Kyrie eleison, Christe eleison...\nDies irae, dies illa!',
    style: 'Breakcore, gabber, Gregorian choir, extreme rhythmic contrast, cathedral reverb.',
  },
  {
    title: 'Neon Rain Study',
    service: 'musicgen',
    prompt: 'Nocturnal ambient synthwave, slow analog arpeggios, distant saxophone, rain on glass, warm sub bass, restrained cinematic drums, spacious and melancholic.',
    lyrics: '',
    style: '',
  },
];

const countTokens = (value: string): number => value.trim() ? value.trim().split(/\s+/).length : 0;
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export function parseSuggestionMarkdown(markdown: string): GenerationDraft | null {
  const field = (name: string): string => {
    const match = markdown.match(new RegExp(`\\*\\*${name}:\\*\\*\\s*([\\s\\S]*?)(?=\\n\\s*\\*\\*[A-Za-z ]+:\\*\\*|\\n\\s*###|$)`, 'i'));
    return match?.[1]?.trim() || '';
  };
  const title = markdown.match(/###\s*Title:\s*([^\n]+)/i)?.[1]?.trim() || '';
  const prompt = field('Prompt');
  if (!prompt) return null;
  const serviceText = field('Service').toLowerCase();
  return {
    title,
    service: serviceText.includes('musicgen') ? 'musicgen' : 'minimax',
    prompt,
    lyrics: field('Lyrics').replace(/\s*\(Minimax only, optional\)\s*/i, ''),
    style: field('Styles Prompt') || field('Style'),
  };
}

export const GenerationPanel: React.FC<GenerationPanelProps> = ({
  variationTrack,
  onCompleted,
  onVariationConsumed,
}) => {
  const [service, setService] = useState<GenerationService>('minimax');
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [lyrics, setLyrics] = useState('');
  const [style, setStyle] = useState('');
  const [sourceSongId, setSourceSongId] = useState<string | undefined>();
  const [importText, setImportText] = useState('');
  const [job, setJob] = useState<GenerationJob | null>(null);
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const pollRun = useRef(0);

  useEffect(() => () => { pollRun.current += 1; }, []);

  useEffect(() => {
    if (!variationTrack) return;
    setTitle(`${variationTrack.title || variationTrack.name} variation`);
    setPrompt(variationTrack.prompt || '');
    setService(variationTrack.generation_model?.toLowerCase().includes('musicgen') ? 'musicgen' : 'minimax');
    setLyrics('');
    setStyle('Preserve the core identity while varying arrangement, instrumentation, and dynamics.');
    setSourceSongId(variationTrack.id);
    setError('');
    onVariationConsumed?.();
  }, [variationTrack, onVariationConsumed]);

  const promptTokens = countTokens(prompt);
  const lyricsTokens = countTokens(lyrics);
  const promptLimit = service === 'musicgen' ? 128 : 256;
  const validationError = useMemo(() => {
    if (!prompt.trim()) return 'Enter a prompt.';
    if (promptTokens > promptLimit) return `Prompt exceeds the ${promptLimit}-token limit.`;
    if (service === 'minimax' && lyricsTokens > 512) return 'Lyrics exceed the 512-token limit.';
    if (service === 'minimax' && lyrics.length > 3500) return 'Lyrics exceed the 3500-character UI limit.';
    if (service === 'minimax' && style.length > 2000) return 'Style exceeds the 2000-character limit.';
    return '';
  }, [lyrics, lyricsTokens, prompt, promptLimit, promptTokens, service, style]);

  const applyDraft = (draft: GenerationDraft) => {
    setTitle(draft.title);
    setService(draft.service);
    setPrompt(draft.prompt);
    setLyrics(draft.lyrics);
    setStyle(draft.style);
    setSourceSongId(undefined);
    setError('');
  };

  const finishJob = async (completedJob: GenerationJob) => {
    if (!completedJob.song_id) throw new Error('Generation completed without a song ID.');
    setJob(completedJob);
    await onCompleted(completedJob.song_id);
  };

  const pollJob = async (initialJob: GenerationJob, run: number) => {
    let current = initialJob;
    let consecutiveErrors = 0;
    for (let attempt = 0; attempt < 120 && pollRun.current === run; attempt += 1) {
      if (current.status === 'completed') { await finishJob(current); return; }
      if (current.status === 'failed') throw new Error(current.error || 'Generation failed.');
      await wait(3000);
      if (pollRun.current !== run) return;
      try {
        current = await fetchGenerationJob(current.job_id);
        consecutiveErrors = 0;
        setError('');
        if (pollRun.current === run) setJob(current);
      } catch (pollError) {
        if (pollError instanceof GenerationApiError && pollError.status === 429) {
          setError(`Status checks are rate limited. Retrying in ${pollError.retryAfter || 5}s.`);
          await wait((pollError.retryAfter || 5) * 1000);
          continue;
        }
        consecutiveErrors += 1;
        if (consecutiveErrors <= 3) continue;
        throw pollError;
      }
    }
    if (pollRun.current === run) throw new Error('Generation is still running. Return later to check the job status.');
  };

  const handleSubmit = async () => {
    if (validationError || isSubmitting) return;
    const run = ++pollRun.current;
    setIsSubmitting(true);
    setError('');
    setJob(null);
    const payload: GenerationRequest = {
      service,
      title: title.trim() || undefined,
      prompt: prompt.trim(),
      source_song_id: sourceSongId,
      ...(service === 'minimax' ? {
        lyrics: lyrics.trim() || undefined,
        style: style.trim() || undefined,
      } : {}),
    };
    try {
      const submitted = await submitGeneration(payload);
      if (!submitted.job_id) throw new Error('Generation service did not return a job ID.');
      setJob(submitted);
      await pollJob(submitted, run);
    } catch (submitError) {
      if (pollRun.current !== run) return;
      if (submitError instanceof GenerationApiError && submitError.status === 429) {
        setError(`Generation limit reached. Try again in ${submitError.retryAfter || 'a few'} seconds.`);
      } else {
        setError(submitError instanceof Error ? submitError.message : 'Could not start generation.');
      }
    } finally {
      if (pollRun.current === run) setIsSubmitting(false);
    }
  };

  const statusLabel = job?.status === 'completed' ? 'Ready to play' : job?.status === 'processing' ? 'Generating audio' : job?.status === 'queued' ? 'Queued' : '';

  return (
    <section className="max-w-3xl mx-auto space-y-6" aria-label="Music generation">
      <div>
        <h2 className="text-2xl font-semibold text-white">Create a track</h2>
        <p className="text-sm text-gray-400 mt-1">Imagine → generate → play → rate → tag → mix.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {(['musicgen', 'minimax'] as GenerationService[]).map(option => (
          <button key={option} type="button" onClick={() => setService(option)}
            aria-pressed={service === option}
            className={`p-4 rounded-xl border text-left ${service === option ? 'border-purple-400 bg-purple-500/20' : 'border-white/10 bg-white/5 hover:bg-white/10'}`}>
            <div className="font-semibold">{option === 'musicgen' ? 'MusicGen' : 'Minimax Audio'}</div>
            <div className="text-xs text-gray-400 mt-1">{option === 'musicgen' ? '128-token text prompt' : '256-token prompt + lyrics + style controls'}</div>
          </button>
        ))}
      </div>

      <div className="bg-white/5 border border-white/10 rounded-xl p-5 space-y-4">
        <label className="block text-sm text-gray-300">Title
          <input value={title} onChange={event => setTitle(event.target.value)} maxLength={200}
            className="mt-1 w-full px-3 py-2 bg-black/20 border border-white/20 rounded-lg text-white" placeholder="Optional track title" />
        </label>
        <label className="block text-sm text-gray-300">Prompt
          <textarea value={prompt} onChange={event => setPrompt(event.target.value)} rows={6}
            className="mt-1 w-full px-3 py-2 bg-black/20 border border-white/20 rounded-lg text-white" placeholder="Describe genre, mood, instrumentation, structure, and production..." />
          <span className={`block text-right text-xs mt-1 ${promptTokens > promptLimit ? 'text-red-400' : 'text-gray-500'}`}>{promptTokens}/{promptLimit} tokens</span>
        </label>
        {service === 'minimax' && <>
          <label className="block text-sm text-gray-300">Lyrics <span className="text-gray-500">(optional)</span>
            <textarea value={lyrics} onChange={event => setLyrics(event.target.value)} rows={7}
              className="mt-1 w-full px-3 py-2 bg-black/20 border border-white/20 rounded-lg text-white" />
            <span className={`block text-right text-xs mt-1 ${lyricsTokens > 512 || lyrics.length > 3500 ? 'text-red-400' : 'text-gray-500'}`}>{lyricsTokens}/512 tokens · {lyrics.length}/3500 chars</span>
          </label>
          <label className="block text-sm text-gray-300">Style <span className="text-gray-500">(optional)</span>
            <textarea value={style} onChange={event => setStyle(event.target.value)} rows={3}
              className="mt-1 w-full px-3 py-2 bg-black/20 border border-white/20 rounded-lg text-white" />
            <span className={`block text-right text-xs mt-1 ${style.length > 2000 ? 'text-red-400' : 'text-gray-500'}`}>{style.length}/2000 chars</span>
          </label>
        </>}

        {validationError && prompt.length > 0 && <p className="text-sm text-amber-300">{validationError}</p>}
        {error && <div role="alert" className="p-3 rounded-lg bg-red-500/15 border border-red-500/30 text-red-200 text-sm">{error}</div>}
        {job && <div role="status" className="p-3 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-200 text-sm flex justify-between">
          <span>{statusLabel || job.status}</span><span>{job.progress !== undefined ? `${Math.round(job.progress)}%` : `Job ${job.job_id}`}</span>
        </div>}
        <button type="button" onClick={handleSubmit} disabled={!!validationError || isSubmitting}
          className="w-full px-4 py-3 rounded-lg bg-purple-500 text-white font-semibold hover:bg-purple-400 disabled:opacity-40 disabled:cursor-not-allowed">
          {isSubmitting ? 'Generating…' : 'Generate track'}
        </button>
      </div>

      <div className="bg-white/5 border border-white/10 rounded-xl p-5 space-y-3">
        <h3 className="font-medium">Import an idea</h3>
        <select aria-label="Curated prompt" defaultValue="" onChange={event => {
          const draft = CURATED_PROMPTS[Number(event.target.value)];
          if (draft) applyDraft(draft);
        }} className="w-full px-3 py-2 bg-white/10 border border-white/20 rounded-lg">
          <option value="" disabled>Pick from song_suggestions.md…</option>
          {CURATED_PROMPTS.map((draft, index) => <option key={draft.title} value={index}>{draft.title}</option>)}
        </select>
        <textarea aria-label="Paste suggestion markdown" value={importText} onChange={event => setImportText(event.target.value)} rows={5}
          className="w-full px-3 py-2 bg-black/20 border border-white/20 rounded-lg text-white" placeholder="Paste a ### Title / **Service:** / **Prompt:** suggestion…" />
        <button type="button" onClick={() => {
          const parsed = parseSuggestionMarkdown(importText);
          if (parsed) applyDraft(parsed); else setError('Could not find a **Prompt:** field in that suggestion.');
        }} className="px-3 py-2 bg-white/10 rounded-lg hover:bg-white/20">Import pasted suggestion</button>
      </div>
    </section>
  );
};
