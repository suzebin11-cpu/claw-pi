import { useEffect, useState } from "react";

function formatRemaining(ms: number): string {
  if (ms <= 0) return "00:00:00";
  const totalSec = Math.floor(ms / 1000);
  const h = String(Math.floor(totalSec / 3600)).padStart(2, "0");
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, "0");
  const s = String(totalSec % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

export function useCountdown(targetIso: string): string {
  const [remaining, setRemaining] = useState(() =>
    targetIso ? new Date(targetIso).getTime() - Date.now() : 0,
  );

  useEffect(() => {
    if (!targetIso) return;
    const target = new Date(targetIso).getTime();
    setRemaining(target - Date.now());
    const id = setInterval(() => {
      const diff = target - Date.now();
      setRemaining(diff > 0 ? diff : 0);
    }, 1000);
    return () => clearInterval(id);
  }, [targetIso]);

  return formatRemaining(remaining);
}
