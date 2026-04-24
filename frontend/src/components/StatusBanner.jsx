import { CheckCircle2, XCircle, Loader2, Info } from 'lucide-react';

export default function StatusBanner({ status, progress, message }) {
  const configs = {
    running: {
      icon: <Loader2 size={16} className="animate-spin text-indigo-400" />,
      bg: 'bg-indigo-500/10 border-indigo-500/25',
      text: 'text-indigo-300',
      bar: 'bg-indigo-500',
    },
    done: {
      icon: <CheckCircle2 size={16} className="text-emerald-400" />,
      bg: 'bg-emerald-500/10 border-emerald-500/25',
      text: 'text-emerald-300',
      bar: 'bg-emerald-500',
    },
    error: {
      icon: <XCircle size={16} className="text-red-400" />,
      bg: 'bg-red-500/10 border-red-500/25',
      text: 'text-red-300',
      bar: 'bg-red-500',
    },
  };

  const cfg = configs[status] || configs.running;

  return (
    <div className={`rounded-xl border px-4 py-3 ${cfg.bg}`}>
      <div className="flex items-center gap-2.5">
        {cfg.icon}
        <p className={`text-sm font-medium ${cfg.text} flex-1 truncate`}>{message}</p>
        {status === 'running' && (
          <span className="text-xs text-slate-500 font-mono shrink-0">{progress}%</span>
        )}
      </div>

      {/* Progress bar */}
      {status === 'running' && (
        <div className="mt-2.5 h-1.5 bg-slate-800 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${cfg.bar}`}
            style={{ width: `${Math.max(4, progress)}%` }}
          />
        </div>
      )}
    </div>
  );
}
