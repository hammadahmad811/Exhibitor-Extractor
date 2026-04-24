import { useState, useEffect, useRef } from 'react';
import toast from 'react-hot-toast';
import axios from 'axios';
import InputForm from './components/InputForm.jsx';
import DataTable from './components/DataTable.jsx';
import ExportButtons from './components/ExportButtons.jsx';
import HistoryPanel from './components/HistoryPanel.jsx';
import StatusBanner from './components/StatusBanner.jsx';
import { Building2, History, X, ClipboardList, BarChart2, ExternalLink } from 'lucide-react';

const API = '';  // proxied via Vite → localhost:3001

export default function App() {
  const [jobState, setJobState]   = useState({ status: 'idle', progress: 0, message: '' });
  const [exhibitors, setExhibitors] = useState([]);
  const [eventMeta, setEventMeta] = useState({ eventName: '', urls: [] });
  const [history, setHistory]     = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const eventSourceRef = useRef(null);

  // Load history on mount
  useEffect(() => {
    fetchHistory();
  }, []);

  async function fetchHistory() {
    try {
      const { data } = await axios.get(`${API}/api/history`);
      setHistory(data);
    } catch {
      // History load failure is non-critical
    }
  }

  // ─── Start extraction job ───────────────────────────────────────────────────
  async function handleExtract({ eventName, urls }) {
    // Close any existing stream
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    setExhibitors([]);
    setEventMeta({ eventName, urls });
    setJobState({ status: 'running', progress: 0, message: 'Starting...' });

    try {
      const { data } = await axios.post(`${API}/api/extract`, { eventName, urls });
      const { jobId } = data;

      // Open SSE stream
      const es = new EventSource(`${API}/api/extract/stream/${jobId}`);
      eventSourceRef.current = es;

      es.onmessage = (e) => {
        const payload = JSON.parse(e.data);

        if (payload.type === 'progress') {
          setJobState({ status: 'running', progress: payload.progress, message: payload.message });
        } else if (payload.type === 'complete') {
          setJobState({ status: 'done', progress: 100, message: payload.message });
          setExhibitors(payload.data || []);
          es.close();
          fetchHistory();
          if (payload.data?.length > 0) {
            toast.success(`Extracted ${payload.data.length} exhibitors!`);
          } else {
            toast.error('No exhibitors found. Try a different URL.');
          }
        } else if (payload.type === 'error') {
          setJobState({ status: 'error', progress: 0, message: payload.error || 'Unknown error' });
          es.close();
          toast.error(payload.error || 'Extraction failed');
        }
      };

      es.onerror = () => {
        setJobState(s => ({
          ...s,
          status: 'error',
          message: 'Connection lost. Please try again.',
        }));
        es.close();
      };
    } catch (err) {
      const msg = err.response?.data?.error || err.message || 'Failed to start extraction';
      setJobState({ status: 'error', progress: 0, message: msg });
      toast.error(msg);
    }
  }

  // ─── Load from history ──────────────────────────────────────────────────────
  function handleLoadHistory(item) {
    setExhibitors(item.data || []);
    setEventMeta({ eventName: item.eventName, urls: item.urls || [item.url] });
    setJobState({ status: 'done', progress: 100, message: `Loaded from history: ${item.count} exhibitors` });
    setShowHistory(false);
    toast.success(`Loaded "${item.eventName}" from history`);
  }

  async function handleDeleteHistory(id) {
    try {
      await axios.delete(`${API}/api/history/${id}`);
      setHistory(h => h.filter(item => item.id !== id));
      toast.success('History item deleted');
    } catch {
      toast.error('Failed to delete history item');
    }
  }

  const isRunning = jobState.status === 'running';

  return (
    <div className="min-h-screen flex flex-col">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur-sm sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-indigo-600 rounded-lg flex items-center justify-center">
              <Building2 size={18} className="text-white" />
            </div>
            <div>
              <h1 className="text-base font-semibold text-white leading-none">Exhibitor Extractor</h1>
              <p className="text-xs text-slate-500 mt-0.5">Event data intelligence</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* History Intelligence page — all extractions unified */}
            <a
              href="/history.html"
              className="btn-secondary flex items-center gap-1.5 relative"
              title="View all extraction history, compare runs, enrich websites"
            >
              <History size={15} />
              <span>History</span>
              {history.length > 0 && (
                <span className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-indigo-500 text-white text-[10px] rounded-full flex items-center justify-center font-bold">
                  {Math.min(history.length, 9)}
                </span>
              )}
            </a>

            {/* Data Intelligence / Analytics page */}
            <a
              href="/intelligence.html"
              className="btn-secondary flex items-center gap-1.5"
              title="Charts, trends and global search across all extractions"
            >
              <BarChart2 size={15} />
              <span>Analytics</span>
            </a>
          </div>
        </div>
      </header>

      {/* ── Main layout ────────────────────────────────────────────────────── */}
      <div className="flex flex-1 max-w-7xl mx-auto w-full px-6 py-8 gap-6">
        {/* Main column */}
        <main className="flex-1 min-w-0 space-y-6">

          {/* Input card */}
          <div className="card p-6">
            <InputForm onExtract={handleExtract} isLoading={isRunning} />
          </div>

          {/* Status banner */}
          {jobState.status !== 'idle' && (
            <StatusBanner
              status={jobState.status}
              progress={jobState.progress}
              message={jobState.message}
            />
          )}

          {/* Results */}
          {exhibitors.length > 0 && (
            <div className="card overflow-hidden">
              {/* Results header */}
              <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <h2 className="font-semibold text-white">Results</h2>
                  <span className="badge badge-indigo">
                    {exhibitors.length.toLocaleString()} exhibitors
                  </span>
                  {eventMeta.eventName && (
                    <span className="badge badge-slate">{eventMeta.eventName}</span>
                  )}
                </div>
                <ExportButtons
                  exhibitors={exhibitors}
                  eventName={eventMeta.eventName}
                  urls={eventMeta.urls}
                />
              </div>
              <DataTable exhibitors={exhibitors} />
            </div>
          )}

          {/* Empty state */}
          {jobState.status === 'idle' && exhibitors.length === 0 && (
            <div className="card p-16 text-center">
              <div className="w-16 h-16 bg-slate-800 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <Building2 size={28} className="text-slate-600" />
              </div>
              <p className="text-slate-400 font-medium">Enter an event URL to get started</p>
              <p className="text-slate-600 text-sm mt-1">
                Supports exhibitor directories, floor plans, and event portals
              </p>
            </div>
          )}
        </main>

        {/* History moved to /history.html — full History Intelligence page */}
      </div>
    </div>
  );
}
