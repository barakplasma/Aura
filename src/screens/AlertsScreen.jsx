import { useEffect, useState } from 'react';
import { Download, EllipsisVertical, Trash2 } from 'lucide-react';
import { useMediaQuery } from '../hooks/useMediaQuery.js';
import { Button } from '../ui/button.jsx';
import { Card } from '../ui/card.jsx';
import { Chip } from '../ui/chip.jsx';
import { MenuContent, MenuItem, MenuRoot, MenuTrigger } from '../ui/menu.jsx';
import { Sheet } from '../ui/sheet.jsx';
import EntryRow from '../alerts/EntryRow.jsx';
import FramePreview from '../alerts/FramePreview.jsx';

// Alerts as a timeline. Every alert keeps the exact frame it fired on, so the
// operator can eyeball it and, if it was wrong, mark it a false positive — that
// writes a "don't fire on this" training example. A few recent non-alert frames
// sit in a second lane so a genuine miss can be marked ("should have fired").
// Either kind can also be sent to the Lab, pre-filled, to be edited first.
export default function AlertsScreen({
  alerts, missed, markedIds, onMarkExample, onClearHistory, onSendToLab, focusId, onFocusHandled,
}) {
  const wide = useMediaQuery('(min-width: 1100px)');
  const marked = markedIds || {};
  const missedFrames = missed || [];
  const [selectedId, setSelectedId] = useState(() => focusId ?? alerts[0]?.id ?? null);
  const [sheet, setSheet] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const hasHistory = alerts.length > 0 || missedFrames.length > 0;

  // A recent-scan dot on Watch points at an entry: select it and bring it into view.
  useEffect(() => {
    if (focusId == null) return;
    setSelectedId(focusId);
    document.getElementById(`entry-${focusId}`)?.scrollIntoView({ block: 'center' });
    onFocusHandled?.();
  }, [focusId, onFocusHandled]);

  const selected = alerts.find((a) => a.id === selectedId) || missedFrames.find((m) => m.id === selectedId) || null;
  const selectedIsAlert = alerts.some((a) => a.id === selectedId);

  function select(entry) {
    setSelectedId(entry.id);
    if (!wide) setSheet(true);
  }

  // Frames are only ~30-60KB each but they dominate the file size, so leaving
  // them out is the default.
  function handleExport(includeFrames) {
    const strip = (list) => list.map(({ image, ...rest }) => (includeFrames ? { ...rest, image } : rest));
    const payload = { exportedAt: new Date().toISOString(), alerts: strip(alerts), missed: strip(missedFrames) };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `aura-history-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  const rowProps = { onSelect: select, onMark: onMarkExample, onSendToLab };
  const previewProps = { entry: selected, isAlert: selectedIsAlert, marked: selected ? Boolean(marked[selected.id]) : false, onMark: onMarkExample, onSendToLab };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-bg-0 p-3">
      <div className="mx-auto grid max-w-6xl gap-3 xl:grid-cols-[minmax(0,1fr)_480px] xl:items-start">
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex items-center gap-3 px-1">
            <h1 className="text-3xl font-semibold">Alerts</h1>
            <Chip>{alerts.length} event{alerts.length !== 1 ? 's' : ''}</Chip>
            {hasHistory && (
              <div className="ml-auto">
                <MenuRoot>
                  <MenuTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label="History options">
                      <EllipsisVertical className="size-5" aria-hidden />
                    </Button>
                  </MenuTrigger>
                  <MenuContent>
                    <MenuItem onSelect={() => handleExport(false)}><Download className="size-4" aria-hidden />Export JSON</MenuItem>
                    <MenuItem onSelect={() => handleExport(true)}><Download className="size-4" aria-hidden />Export with frames</MenuItem>
                    <MenuItem onSelect={() => setConfirmClear(true)}><Trash2 className="size-4" aria-hidden />Clear history…</MenuItem>
                  </MenuContent>
                </MenuRoot>
              </div>
            )}
          </div>

          {alerts.length === 0 ? (
            <Card className="text-sm text-text-dim" id="alert-log-empty">
              No events yet. When a scan alerts, it appears here with the frame that fired it.
            </Card>
          ) : (
            <ul id="alert-log" aria-live="polite" className="flex flex-col">
              {alerts.map((a) => (
                <EntryRow key={a.id} entry={a} isAlert selected={a.id === selectedId} marked={Boolean(marked[a.id])} {...rowProps} />
              ))}
            </ul>
          )}

          {missedFrames.length > 0 && (
            <section className="flex flex-col gap-3" aria-label="Recent frames with no alert">
              <div className="px-1">
                <h2 className="text-xl font-semibold">Recent frames</h2>
                <p className="text-xs text-text-dim">No alert fired on these — mark a miss.</p>
              </div>
              <ul className="flex flex-col">
                {missedFrames.map((m) => (
                  <EntryRow key={m.id} entry={m} isAlert={false} selected={m.id === selectedId} marked={Boolean(marked[m.id])} {...rowProps} />
                ))}
              </ul>
            </section>
          )}
        </div>

        {wide && <aside className="sticky top-0" aria-label="Selected frame"><FramePreview {...previewProps} /></aside>}
      </div>

      {!wide && (
        <Sheet open={sheet && Boolean(selected)} onOpenChange={setSheet} title={selectedIsAlert ? 'Alert' : 'Recent frame'}>
          <FramePreview {...previewProps} />
        </Sheet>
      )}

      <Sheet open={confirmClear} onOpenChange={setConfirmClear} title="Clear all alert history?" description="This removes every alert and recent frame from this device. It cannot be undone.">
        <div className="flex gap-2">
          <Button variant="danger" onClick={() => { onClearHistory(); setConfirmClear(false); setSelectedId(null); }}>Clear history</Button>
          <Button variant="ghost" onClick={() => setConfirmClear(false)}>Cancel</Button>
        </div>
      </Sheet>
    </div>
  );
}
