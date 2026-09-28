'use client';

import type { JobInput } from '@avg/contracts';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { api, ApiRequestError, type Estimate } from '@/lib/api';
import { useAuthHeaders } from '@/lib/auth';

const STYLES = [
  ['cinematic_realism', 'Cinematic realism'],
  ['pixar_3d', 'Stylised 3D'],
  ['anime', 'Anime'],
] as const;

interface CharacterDraft {
  name: string;
  description: string;
}

export function NewJobForm() {
  const router = useRouter();
  const getHeaders = useAuthHeaders();
  const [prompt, setPrompt] = useState('');
  const [characters, setCharacters] = useState<CharacterDraft[]>([]);
  const [style, setStyle] = useState<string>(STYLES[0][0]);
  const [aspectRatio, setAspectRatio] = useState<JobInput['options']['aspectRatio']>('9:16');
  const [duration, setDuration] = useState(30);
  const [videoTier, setVideoTier] = useState<JobInput['options']['videoTier']>('standard');
  const [mode, setMode] = useState<JobInput['options']['mode']>('auto');
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const input = useMemo<JobInput>(
    () => ({
      prompt: prompt.trim(),
      characters: characters
        .filter((c) => c.name.trim() && c.description.trim())
        .map((c) => ({
          name: c.name.trim(),
          description: c.description.trim(),
        })) as JobInput['characters'],
      options: { style, aspectRatio, targetDurationSec: duration, language: 'en', mode, videoTier },
    }),
    [prompt, characters, style, aspectRatio, duration, mode, videoTier],
  );
  const valid = input.prompt.length >= 10 && input.prompt.length <= 300;

  useEffect(() => {
    if (!valid) {
      setEstimate(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const est = await api.estimate(input, await getHeaders());
        if (!cancelled) setEstimate(est);
      } catch {
        if (!cancelled) setEstimate(null);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [input, valid, getHeaders]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const job = await api.createJob(input, await getHeaders());
      router.push(`/jobs/${job.id}`);
    } catch (err) {
      setError(err instanceof ApiRequestError ? `${err.code}: ${err.message}` : String(err));
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-6 md:grid-cols-[2fr_1fr]">
      <div className="grid gap-5">
        <div className="panel grid gap-4 p-5">
          <div>
            <label className="label" htmlFor="prompt">
              Story idea
            </label>
            <textarea
              id="prompt"
              className="field min-h-24"
              placeholder="A lonely lighthouse keeper befriends a storm."
              value={prompt}
              maxLength={300}
              onChange={(e) => setPrompt(e.target.value)}
            />
            <div className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
              {prompt.trim().length}/300 · at least 10 characters
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="label" style={{ marginBottom: 0 }}>
                Characters (optional, up to 4)
              </span>
              <button
                type="button"
                className="btn btn-ghost"
                style={{ padding: '0.3rem 0.7rem', fontSize: '0.8rem' }}
                disabled={characters.length >= 4}
                onClick={() => setCharacters([...characters, { name: '', description: '' }])}
              >
                + Add character
              </button>
            </div>
            <div className="grid gap-3">
              {characters.map((c, i) => (
                <div key={i} className="grid gap-2 md:grid-cols-[1fr_2fr_auto]">
                  <input
                    className="field"
                    placeholder="Name"
                    value={c.name}
                    maxLength={60}
                    onChange={(e) =>
                      setCharacters(
                        characters.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                      )
                    }
                  />
                  <input
                    className="field"
                    placeholder="Appearance, age, outfit, signature props"
                    value={c.description}
                    maxLength={600}
                    onChange={(e) =>
                      setCharacters(
                        characters.map((x, j) =>
                          j === i ? { ...x, description: e.target.value } : x,
                        ),
                      )
                    }
                  />
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => setCharacters(characters.filter((_, j) => j !== i))}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="panel grid gap-4 p-5 md:grid-cols-2">
          <div>
            <label className="label" htmlFor="style">
              Visual style
            </label>
            <select
              id="style"
              className="field"
              value={style}
              onChange={(e) => setStyle(e.target.value)}
            >
              {STYLES.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="aspect">
              Format
            </label>
            <select
              id="aspect"
              className="field"
              value={aspectRatio}
              onChange={(e) => setAspectRatio(e.target.value as JobInput['options']['aspectRatio'])}
            >
              <option value="9:16">Vertical 9:16 (Shorts, Reels, TikTok)</option>
              <option value="16:9">Landscape 16:9 (YouTube)</option>
              <option value="1:1">Square 1:1</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="duration">
              Target length: {duration}s
            </label>
            <input
              id="duration"
              type="range"
              min={10}
              max={90}
              step={5}
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
              className="w-full"
            />
          </div>
          <div>
            <label className="label" htmlFor="tier">
              Video quality
            </label>
            <select
              id="tier"
              className="field"
              value={videoTier}
              onChange={(e) => setVideoTier(e.target.value as JobInput['options']['videoTier'])}
            >
              <option value="standard">Standard (1× credits)</option>
              <option value="premium">Premium (2× credits)</option>
            </select>
          </div>
          <div className="md:col-span-2">
            <label className="label">Mode</label>
            <div className="flex gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="radio" checked={mode === 'auto'} onChange={() => setMode('auto')} />{' '}
                Auto: no interaction needed
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={mode === 'director'}
                  onChange={() => setMode('director')}
                />{' '}
                Director: approve script and characters
              </label>
            </div>
          </div>
        </div>
      </div>

      <aside className="panel h-fit p-5">
        <div className="text-sm" style={{ color: 'var(--muted)' }}>
          Cost preview
        </div>
        <div className="mt-1 text-3xl font-bold">
          {estimate ? `${estimate.credits} credits` : '—'}
        </div>
        {estimate && (
          <div className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>
            {estimate.breakdown.base} for {duration}s × {estimate.breakdown.tierMultiplier} +{' '}
            {estimate.breakdown.overhead} overhead · about{' '}
            {Math.round(estimate.estimatedSeconds / 60)} min to render
          </div>
        )}
        {error && (
          <div className="mt-3 text-sm" style={{ color: 'var(--bad)' }}>
            {error}
          </div>
        )}
        <button
          type="submit"
          className="btn mt-5 w-full justify-center"
          disabled={!valid || submitting}
        >
          {submitting ? 'Starting…' : 'Generate video'}
        </button>
      </aside>
    </form>
  );
}
