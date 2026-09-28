import Link from 'next/link';

const STEPS = [
  ['Story idea', 'One line from you.'],
  ['Story engine', 'Script, dialogue, scene breakdown, emotional beats.'],
  ['Characters & images', 'Consistent character sheets and scene keyframes.'],
  ['Video generation', 'Image-to-video with motion and camera moves.'],
  ['Audio', 'Voiceover, dialogue, music and sound effects.'],
  ['Automated editor', 'Cuts, transitions, subtitles, loudness, aspect ratio.'],
  ['Final MP4', 'Ready to publish.'],
];

export default function HomePage() {
  return (
    <div className="grid gap-10">
      <section className="grid gap-4 py-8">
        <h1 className="text-4xl font-bold tracking-tight md:text-5xl">
          Type one line. <span style={{ color: 'var(--accent)' }}>Get a finished video.</span>
        </h1>
        <p className="max-w-2xl text-lg" style={{ color: 'var(--muted)' }}>
          Storyframe turns a one-line story idea into a fully produced short film: script,
          consistent characters, animated scenes, voice, music, sound effects and subtitles. No
          editing, no prompt engineering.
        </p>
        <div className="flex gap-3">
          <Link href="/new" className="btn">
            Make a video
          </Link>
          <Link href="/jobs" className="btn btn-ghost">
            See my videos
          </Link>
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-7">
        {STEPS.map(([title, body], i) => (
          <div key={title} className="panel p-4">
            <div className="text-xs" style={{ color: 'var(--accent)' }}>
              {i + 1}
            </div>
            <div className="mt-1 font-semibold">{title}</div>
            <div className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
              {body}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
