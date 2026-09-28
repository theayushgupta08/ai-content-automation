import { describe, expect, it } from 'vitest';
import { assertJobInput, assertScenePlan, assertTimeline, isJobInput } from './index';

describe('contracts', () => {
  it('accepts a minimal valid job input', () => {
    const input = assertJobInput({
      prompt: 'A lonely lighthouse keeper befriends a storm.',
      characters: [{ name: 'Mara', description: '60s, weathered, yellow raincoat' }],
      options: {
        style: 'cinematic_realism',
        aspectRatio: '9:16',
        targetDurationSec: 30,
        language: 'en',
        mode: 'auto',
        videoTier: 'standard',
      },
    });
    expect(input.options.aspectRatio).toBe('9:16');
  });

  it('rejects a prompt that is too short', () => {
    expect(
      isJobInput({
        prompt: 'short',
        characters: [],
        options: {
          style: 'x',
          aspectRatio: '9:16',
          targetDurationSec: 30,
          language: 'en',
          mode: 'auto',
          videoTier: 'standard',
        },
      }),
    ).toBe(false);
  });

  it('rejects a character reference with neither id nor name+description', () => {
    expect(() =>
      assertJobInput({
        prompt: 'A lonely lighthouse keeper befriends a storm.',
        characters: [{ name: 'Mara' }],
        options: {
          style: 'x',
          aspectRatio: '9:16',
          targetDurationSec: 30,
          language: 'en',
          mode: 'auto',
          videoTier: 'standard',
        },
      }),
    ).toThrow(/JobInput failed validation/);
  });

  it('validates a scene plan and a timeline', () => {
    const plan = assertScenePlan({
      version: 1,
      title: 't',
      logline: 'l',
      style: { preset: 'p', negative: 'text' },
      characters: [],
      scenes: [
        {
          index: 0,
          durationSec: 5,
          location: 'x',
          characters: [],
          keyframes: [{ position: 'start', prompt: 'p' }],
          motion: { camera: 'static', subject: 'none', intensity: 0.1 },
          dialogue: [],
          sfx: [],
          music: { cue: 'intro', energy: 0.2 },
          transitionOut: 'cut',
        },
      ],
      music: { mood: 'calm' },
      subtitleStyle: 'bold_center',
    });
    expect(plan.scenes).toHaveLength(1);

    const timeline = assertTimeline({
      version: 1,
      fps: 30,
      width: 1080,
      height: 1920,
      durationSec: 5,
      video: [{ src: 'scenes/0/clip.mp4', inSec: 0, outSec: 5, at: 0 }],
      audio: [],
      subtitles: { style: 'none', burnIn: false, cues: [] },
    });
    expect(timeline.video[0].outSec).toBe(5);
  });
});
