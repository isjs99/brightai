import { useEffect, useState } from 'react';

/** A short burst of confetti, for a deal marked ready to sign or an onboarding completed. */
export function Confetti({ run, onDone }: { run: number; onDone?: () => void }) {
  const [pieces, setPieces] = useState<{ id: number; left: number; delay: number; color: string; dx: number; dur: number }[]>([]);
  useEffect(() => {
    if (!run) return;
    const colors = ['#1d3df0', '#1e8f4e', '#b7791f', '#c8322d', '#0f0f10', '#6b82ff'];
    setPieces(Array.from({ length: 70 }, (_, i) => ({ id: run * 1000 + i, left: Math.random() * 100, delay: Math.random() * 0.4, color: colors[i % colors.length], dx: (Math.random() - 0.5) * 240, dur: 1.6 + Math.random() * 1.2 })));
    const t = setTimeout(() => { setPieces([]); onDone?.(); }, 3200);
    return () => clearTimeout(t);
  }, [run]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!pieces.length) return null;
  return <div className="confetti" aria-hidden="true">{pieces.map((p) => <i key={p.id} style={{ left: `${p.left}%`, background: p.color, animationDelay: `${p.delay}s`, animationDuration: `${p.dur}s`, ['--dx' as string]: `${p.dx}px` }} />)}</div>;
}
