import { useState } from 'react';
import { Search, Plus, Minus, Globe, Tag, Zap } from 'lucide-react';
import { detectUrlTypeClient } from '../utils/urlDetector.js';

export default function InputForm({ onExtract, isLoading }) {
  const [eventName, setEventName] = useState('');
  const [urls, setUrls]           = useState(['']);

  function addUrl() {
    setUrls(u => [...u, '']);
  }

  function removeUrl(i) {
    setUrls(u => u.filter((_, idx) => idx !== i));
  }

  function updateUrl(i, val) {
    setUrls(u => u.map((v, idx) => (idx === i ? val : v)));
  }

  function handleSubmit(e) {
    e.preventDefault();
    const validUrls = urls.map(u => u.trim()).filter(Boolean);
    if (!eventName.trim() || validUrls.length === 0) return;
    onExtract({ eventName: eventName.trim(), urls: validUrls });
  }

  const canSubmit = eventName.trim() && urls.some(u => u.trim()) && !isLoading;

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="flex items-center gap-2 mb-1">
        <Zap size={16} className="text-indigo-400" />
        <h2 className="font-semibold text-white text-sm">Extract Exhibitor Data</h2>
      </div>

      {/* Event Name */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-slate-400 flex items-center gap-1.5">
          <Tag size={12} />
          Event Name
        </label>
        <input
          type="text"
          className="input-field"
          placeholder="e.g. CES 2025, NAB Show, SXSW..."
          value={eventName}
          onChange={e => setEventName(e.target.value)}
          disabled={isLoading}
          required
        />
      </div>

      {/* URLs */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-slate-400 flex items-center gap-1.5">
          <Globe size={12} />
          URL(s)
          <span className="badge badge-slate ml-1">Floor Plan or Directory</span>
        </label>

        <div className="space-y-2">
          {urls.map((url, i) => {
            const urlType = detectUrlTypeClient(url);
            return (
              <div key={i} className="flex gap-2 items-center">
                <div className="relative flex-1">
                  <input
                    type="url"
                    className="input-field pr-28"
                    placeholder="https://example.com/exhibitors"
                    value={url}
                    onChange={e => updateUrl(i, e.target.value)}
                    disabled={isLoading}
                  />
                  {url && (
                    <span className={`absolute right-3 top-1/2 -translate-y-1/2 badge text-[10px] ${
                      urlType === 'floor_plan' ? 'badge-amber' :
                      urlType === 'directory'  ? 'badge-emerald' : 'badge-slate'
                    }`}>
                      {urlType === 'floor_plan' ? '📐 Floor Plan' :
                       urlType === 'directory'  ? '📋 Directory' : '🔍 Auto-detect'}
                    </span>
                  )}
                </div>
                {urls.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeUrl(i)}
                    className="text-slate-600 hover:text-red-400 transition-colors p-1.5"
                    disabled={isLoading}
                  >
                    <Minus size={15} />
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {urls.length < 5 && (
          <button
            type="button"
            onClick={addUrl}
            className="text-indigo-400 hover:text-indigo-300 text-xs flex items-center gap-1 mt-1 transition-colors"
            disabled={isLoading}
          >
            <Plus size={13} />
            Add another URL
          </button>
        )}
      </div>

      {/* Submit */}
      <div className="flex items-center gap-3 pt-1">
        <button
          type="submit"
          className="btn-primary px-6"
          disabled={!canSubmit}
        >
          {isLoading ? (
            <>
              <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              Extracting...
            </>
          ) : (
            <>
              <Search size={15} />
              Extract Exhibitors
            </>
          )}
        </button>
        {urls.length > 1 && (
          <p className="text-xs text-slate-500">
            {urls.filter(u => u.trim()).length} URL{urls.filter(u => u.trim()).length !== 1 ? 's' : ''} queued
          </p>
        )}
      </div>
    </form>
  );
}
