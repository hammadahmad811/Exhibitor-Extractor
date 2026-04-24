import * as XLSX from 'xlsx';
import { Download, FileSpreadsheet, FileText } from 'lucide-react';

export default function ExportButtons({ exhibitors, eventName, urls }) {
  function buildWorkbook() {
    const wb = XLSX.utils.book_new();

    // Sheet name: sanitize event name
    const sheetName = (eventName || 'Exhibitors')
      .replace(/[\\/*?:[\]]/g, '')
      .substring(0, 31);

    // Metadata rows
    const metaRows = [
      ['Event Name', eventName || ''],
      ['Source URL(s)', Array.isArray(urls) ? urls.join(', ') : (urls || '')],
      ['Extracted At', new Date().toLocaleString()],
      ['Total Exhibitors', exhibitors.length],
      [], // blank separator
      ['#', 'Exhibitor Name', 'Booth Number', 'Booth Size', 'Category', 'Website', 'Description'],
    ];

    // Data rows
    const dataRows = exhibitors.map((e, i) => [
      i + 1,
      e.name,
      e.boothNumber,
      e.boothSize,
      e.category,
      e.website,
      e.description,
    ]);

    const allRows = [...metaRows, ...dataRows];
    const ws = XLSX.utils.aoa_to_sheet(allRows);

    // Column widths
    ws['!cols'] = [
      { wch: 5 },   // #
      { wch: 40 },  // Name
      { wch: 14 },  // Booth #
      { wch: 12 },  // Size
      { wch: 20 },  // Category
      { wch: 35 },  // Website
      { wch: 50 },  // Description
    ];

    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    return wb;
  }

  function downloadExcel() {
    const wb = buildWorkbook();
    const filename = `${(eventName || 'exhibitors').replace(/\s+/g, '-').toLowerCase()}-${Date.now()}.xlsx`;
    XLSX.writeFile(wb, filename);
  }

  function downloadCsv() {
    const headers = ['#', 'Exhibitor Name', 'Booth Number', 'Booth Size', 'Category', 'Website', 'Description'];
    const rows = exhibitors.map((e, i) => [
      i + 1,
      `"${(e.name || '').replace(/"/g, '""')}"`,
      `"${(e.boothNumber || '').replace(/"/g, '""')}"`,
      `"${(e.boothSize || '').replace(/"/g, '""')}"`,
      `"${(e.category || '').replace(/"/g, '""')}"`,
      `"${(e.website || '').replace(/"/g, '""')}"`,
      `"${(e.description || '').replace(/"/g, '""')}"`,
    ]);

    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(eventName || 'exhibitors').replace(/\s+/g, '-').toLowerCase()}-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!exhibitors || exhibitors.length === 0) return null;

  return (
    <div className="flex items-center gap-2">
      <button onClick={downloadExcel} className="btn-secondary text-xs py-2">
        <FileSpreadsheet size={14} className="text-emerald-400" />
        Excel
      </button>
      <button onClick={downloadCsv} className="btn-secondary text-xs py-2">
        <FileText size={14} className="text-sky-400" />
        CSV
      </button>
    </div>
  );
}
