import { NewJobForm } from '@/components/NewJobForm';

export default function NewJobPage() {
  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-2xl font-bold">New video</h1>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          Describe the story in one line, optionally add characters, pick a format, and go.
        </p>
      </div>
      <NewJobForm />
    </div>
  );
}
