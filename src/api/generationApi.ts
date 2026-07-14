import { getApiBaseUrl } from './songApi';

export type GenerationService = 'musicgen' | 'minimax';
export type GenerationStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface GenerationRequest {
  service: GenerationService;
  title?: string;
  prompt: string;
  lyrics?: string;
  style?: string;
  source_song_id?: string;
}

export interface GenerationJob {
  job_id: string;
  status: GenerationStatus;
  song_id?: string;
  progress?: number;
  error?: string;
}

export class GenerationApiError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfter?: number) {
    super(message);
    this.name = 'GenerationApiError';
  }
}

async function readResponse(response: Response): Promise<GenerationJob> {
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const retryAfterHeader = response.headers.get('Retry-After');
    const retryAfter = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : undefined;
    const detail = typeof body.detail === 'string' ? body.detail : `Generation request failed (${response.status})`;
    throw new GenerationApiError(detail, response.status, retryAfter);
  }
  return body as unknown as GenerationJob;
}

export async function submitGeneration(payload: GenerationRequest): Promise<GenerationJob> {
  const response = await fetch(`${getApiBaseUrl()}/api/generate`, {
    method: 'POST',
    mode: 'cors',
    credentials: 'omit',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return readResponse(response);
}

export async function fetchGenerationJob(jobId: string): Promise<GenerationJob> {
  const response = await fetch(`${getApiBaseUrl()}/api/generate/${encodeURIComponent(jobId)}`, {
    mode: 'cors',
    credentials: 'omit',
  });
  return readResponse(response);
}
