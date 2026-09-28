import { JobList } from '@/components/JobList';

export default function JobsPage() {
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-bold">My videos</h1>
      <JobList />
    </div>
  );
}
