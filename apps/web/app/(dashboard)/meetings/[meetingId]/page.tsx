export default function MeetingDetailPage({
  params,
}: {
  params: { meetingId: string };
}) {
  return (
    <section>
      <h1>Meeting {params.meetingId}</h1>
      <h2>Roll call</h2>
      <h2>Report</h2>
    </section>
  );
}
