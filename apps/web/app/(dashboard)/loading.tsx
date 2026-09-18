import { Skeleton } from "@/components/ui";

export default function DashboardLoading() {
  return (
    <div className="stack" role="status">
      <span className="sr-only">Yükleniyor...</span>
      <Skeleton lines={1} />
      <div className="card">
        <Skeleton lines={4} />
      </div>
    </div>
  );
}
