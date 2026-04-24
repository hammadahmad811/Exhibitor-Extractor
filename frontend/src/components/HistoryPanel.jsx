import { Trash2, ArrowDownToLine, Clock, Globe, Database } from 'lucide-react';

export default function HistoryPanel({ history, onLoad, onDelete }) {
  if (history.length === 0) {
    return (
      <div className="p-6 text-center">
        <Clock size={24} className="text-slate-700 mx-auto mb-2" />
        <p className="text-slate-500 text-sm">No extractions yet</p>
        <p className="text-slate-600 text-xs mt-1">Past jobs will appear here</p>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-slate-800/60 max-h-[60vh] overflow-y-auto">
      {history.map((item) => (
        <li key={item.id} className="p-3 hover:bg-slate-800/30 transition-colors group">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-slate-200 truncate">{item.eventName}</p>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                <span className="badge badge-indigo text-[10px]">
                  <Database size={9} />
                  {item.count} exhibitors
                </span>
                <span className={`badge text-[10px] ${
                  item.urlType === 'floor_plan' ? 'badge-amber' : 'badge-emerald'
                }`}>
                  {item.urlType === 'floor_plan' ? '📐 Floor Plan' : '📋 Directory'}
                </span>
              </div>
              <div className="flex items-center gap-1 mt-1.5">
                <Globe size={9} className="text-slate-600 shrink-0" />
                <p className="text-[10px] text-slate-500 truncate">
                  {Array.isArray(item.urls) ? item.urls[0] : item.url}
                </p>
              </div>
              <p className="text-[10px] text-slate-600 mt-1 flex items-center gap-1">
                <Clock size={9} />
                {new Date(item.extractedAt).toLocaleString()}
              </p>
            </div>

            <div className="flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={() => onLoad(item)}
                title="Load results"
                className="p-1.5 text-slate-500 hover:text-indigo-400 transition-colors rounded"
              >
                <ArrowDownToLine size={13} />
              </button>
              <button
                onClick={() => onDelete(item.id)}
                title="Delete"
                className="p-1.5 text-slate-500 hover:text-red-400 transition-colors rounded"
              >
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
