import { Badge } from "./ui/badge";

const TONES = { QUEUED: "neutral", RUNNING: "primary", COMPLETED: "ok", FAILED: "critical" } as const;
const LABELS = { QUEUED: "Queued", RUNNING: "Running", COMPLETED: "Completed", FAILED: "Failed" } as const;

export function StatusBadge({ status }: { status: keyof typeof TONES }) {
  return <Badge tone={TONES[status]}>{LABELS[status]}</Badge>;
}
