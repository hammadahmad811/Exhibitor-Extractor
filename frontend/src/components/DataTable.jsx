import { useState, useMemo } from 'react';
import {
  Search, ChevronUp, ChevronDown, ChevronsUpDown,
  ExternalLink, ChevronLeft, ChevronRight
} from 'lucide-react';

const PAGE_SIZES = [25, 50, 100];

export default function DataTable({ exhibitors }) {
  const [search, setSearch]         = useState('');
  const [sortKey, setSortKey]       = useState('boothNumber');
  const [sortDir, setSortDir]       = useState('asc');
  const [page, setPage]             = useState(1);
  const [pageSize, setPageSize]     = useState(25);

  // Filter
  const filtered = useMemo(() => {
    if (!search.trim()) return exhibitors;
    const q = search.toLowerCase();
    return exhibitors.filter(e =>
      e.name.toLowerCase().includes(q) ||
      e.boothNumber.toLowerCase().includes(q) ||
      e.boothSize.toLowerCase().includes(q) ||
      e.website.toLowerCase().includes(q) ||
      e.category.toLowerCase().includes(q)
    );
  }, [exhibitors, search]);

  // Sort
  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      let valA = a[sortKey] || '';
      let valB = b[sortKey] || '';
      // Numeric-aware sort for booth numbers
      const cmp = valA.localeCompare(valB, undefined, { numeric: true, sensitivity: 'base' });
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [filtered, sortKey, sortDir]);

  // Paginate
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const paginated = sorted.slice((page - 1) * pageSize, page * pageSize);

  function handleSort(key) {
    if (sortKey === key) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
    setPage(1);
  }

  function handleSearch(val) {
    setSearch(val);
    setPage(1);
  }

  const SortIcon = ({ col }) => {
    if (sortKey !== col) return <ChevronsUpDown size={13} className="text-slate-600" />;
    return sortDir === 'asc'
      ? <ChevronUp size={13} className="text-indigo-400" />
      : <ChevronDown size={13} className="text-indigo-400" />;
  };

  const ColHeader = ({ col, label }) => (
    <th
      className="px-4 py-3 text-left text-xs font-medium text-slate-400 cursor-pointer select-none
                 hover:text-slate-200 transition-colors whitespace-nowrap"
      onClick={() => handleSort(col)}
    >
      <span className="flex items-center gap-1.5">
        {label}
        <SortIcon col={col} />
      </span>
    </th>
  );

  return (
    <div className="flex flex-col">
      {/* Toolbar */}
      <div className="px-4 py-3 border-b border-slate-800 flex items-center gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            className="input-field pl-8 py-2 text-xs"
            placeholder="Search exhibitors..."
            value={search}
            onChange={e => handleSearch(e.target.value)}
          />
        </div>
        <span className="text-xs text-slate-500 ml-auto">
          {filtered.length !== exhibitors.length
            ? `${filtered.length} of ${exhibitors.length}`
            : exhibitors.length.toLocaleString()} results
        </span>
        <select
          className="input-field w-auto py-2 text-xs"
          value={pageSize}
          onChange={e => { setPageSize(Number(e.target.value)); setPage(1); }}
        >
          {PAGE_SIZES.map(s => (
            <option key={s} value={s}>{s} per page</option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-800/50 border-b border-slate-800">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 w-8">#</th>
              <ColHeader col="name" label="Exhibitor Name" />
              <ColHeader col="boothNumber" label="Booth #" />
              <ColHeader col="boothSize" label="Booth Size" />
              <ColHeader col="category" label="Category" />
              <ColHeader col="website" label="Website" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60">
            {paginated.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-slate-500 text-sm">
                  No results found.
                </td>
              </tr>
            ) : (
              paginated.map((ex, idx) => (
                <tr key={ex.id} className="hover:bg-slate-800/30 transition-colors group">
                  <td className="px-4 py-3 text-xs text-slate-600 font-mono">
                    {(page - 1) * pageSize + idx + 1}
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-100 text-sm leading-snug">{ex.name}</div>
                    {ex.description && (
                      <div className="text-xs text-slate-500 mt-0.5 line-clamp-1">{ex.description}</div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {ex.boothNumber ? (
                      <span className="badge badge-indigo font-mono text-xs">{ex.boothNumber}</span>
                    ) : (
                      <span className="text-slate-600 text-xs">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-400 text-xs whitespace-nowrap">
                    {ex.boothSize || <span className="text-slate-600">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    {ex.category ? (
                      <span className="badge badge-slate text-[11px]">{ex.category}</span>
                    ) : (
                      <span className="text-slate-600 text-xs">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {ex.website ? (
                      <a
                        href={ex.website}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-indigo-400 hover:text-indigo-300 text-xs flex items-center gap-1
                                   transition-colors max-w-[180px] truncate"
                      >
                        {new URL(ex.website).hostname.replace('www.', '')}
                        <ExternalLink size={10} className="shrink-0" />
                      </a>
                    ) : (
                      <span className="text-slate-600 text-xs">—</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="px-4 py-3 border-t border-slate-800 flex items-center justify-between">
          <p className="text-xs text-slate-500">
            Page {page} of {totalPages}
          </p>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage(1)}
              disabled={page === 1}
              className="btn-secondary px-2 py-1.5 text-xs disabled:opacity-30"
            >
              «
            </button>
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
              className="btn-secondary px-2 py-1.5 disabled:opacity-30"
            >
              <ChevronLeft size={14} />
            </button>

            {/* Page numbers */}
            {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
              let pageNum;
              if (totalPages <= 5) {
                pageNum = i + 1;
              } else if (page <= 3) {
                pageNum = i + 1;
              } else if (page >= totalPages - 2) {
                pageNum = totalPages - 4 + i;
              } else {
                pageNum = page - 2 + i;
              }
              return (
                <button
                  key={pageNum}
                  onClick={() => setPage(pageNum)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    page === pageNum
                      ? 'bg-indigo-600 text-white'
                      : 'btn-secondary'
                  }`}
                >
                  {pageNum}
                </button>
              );
            })}

            <button
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="btn-secondary px-2 py-1.5 disabled:opacity-30"
            >
              <ChevronRight size={14} />
            </button>
            <button
              onClick={() => setPage(totalPages)}
              disabled={page === totalPages}
              className="btn-secondary px-2 py-1.5 text-xs disabled:opacity-30"
            >
              »
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
