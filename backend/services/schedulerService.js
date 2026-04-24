/**
 * schedulerService.js  —  Automatic extraction scheduler
 *
 * Checks every 60 seconds whether any schedule is due, fires the
 * extraction pipeline, and saves results to the SQLite history DB.
 *
 * Location: backend/services/schedulerService.js
 */

import { getSchedulesDue, updateScheduleAfterRun, saveExtraction } from '../database.js';
import { runScraper } from '../scrapers/smartScraper.js';
import { detectUrlType } from '../utils/urlDetector.js';

const CHECK_INTERVAL_MS = 60_000; // check every minute
let _timer = null;

// Broadcast function — set by server.js so scheduler can push SSE events
let _broadcast = null;
export function setBroadcast(fn) { _broadcast = fn; }

function notify(msg) {
  console.log(`  [Scheduler] ${msg}`);
  if (_broadcast) _broadcast({ type: 'scheduler', message: msg });
}

async function runDueSchedules() {
  let due;
  try {
    due = getSchedulesDue();
  } catch {
    return; // DB not ready yet
  }

  for (const schedule of due) {
    notify(`Running scheduled extraction: "${schedule.event_name}" → ${schedule.source_url}`);

    try {
      const urlType    = detectUrlType(schedule.source_url);
      const exhibitors = await runScraper(schedule.source_url, urlType, (msg, pct) => {
        notify(`  (${pct}%) ${msg}`);
      });

      if (exhibitors.length > 0) {
        saveExtraction({
          eventName:  schedule.event_name,
          sourceUrl:  schedule.source_url,
          platform:   urlType,
          exhibitors,
        });
        notify(`Done: saved ${exhibitors.length} exhibitors for "${schedule.event_name}"`);
      } else {
        notify(`Warning: 0 exhibitors returned for "${schedule.event_name}"`);
      }
    } catch (err) {
      notify(`Error extracting "${schedule.event_name}": ${err.message}`);
    }

    // Update next_run regardless of success/failure
    try {
      updateScheduleAfterRun(
        schedule.id,
        schedule.freq_type,
        schedule.freq_day,
        schedule.freq_hour,
        schedule.freq_minute,
        schedule.freq_every_n
      );
    } catch (e) {
      console.error('  [Scheduler] Failed to update next_run:', e.message);
    }
  }
}

export function startScheduler() {
  if (_timer) return;
  notify('Scheduler started — checking every 60 seconds');
  // Run immediately on start to catch any overdue schedules
  runDueSchedules();
  _timer = setInterval(runDueSchedules, CHECK_INTERVAL_MS);
}

export function stopScheduler() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}
