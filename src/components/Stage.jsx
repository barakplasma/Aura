import { Eye, EllipsisVertical, SwitchCamera, VideoOff } from 'lucide-react';
import { cn } from '../ui/cn.js';
import { Button } from '../ui/button.jsx';
import { MenuContent, MenuItem, MenuRoot, MenuTrigger } from '../ui/menu.jsx';

// The camera stage — always mounted at app level, first child of <main>, so
// the <video> keeps its stream (and scanning keeps running) across tabs. Its
// `mode` picks the presentation:
//   full       Watch, camera shown
//   collapsed  Watch, camera hidden (a slim strip; the video is display:none)
//   pip        another tab while armed — floating thumbnail, tap to return
//   parked     another tab, idle — hidden
export default function Stage({
  videoRef, canvasRef, mode, flashActive, running, demoMode, videoSource,
  wakeLockHeld, onToggleCollapse, onFlipCamera, onDemo, onReturn,
}) {
  const pip = mode === 'pip';
  const collapsed = mode === 'collapsed';
  const showFlip = running && !pip && !collapsed && videoSource !== 'screen';
  return (
    <div
     
      data-stage={mode}
      onClick={pip ? onReturn : undefined}
      role={pip ? 'button' : undefined}
      aria-label={pip ? 'Return to Watch' : undefined}
      className={cn(
        'relative overflow-hidden rounded-lg bg-bg-2',
        mode === 'full' && 'm-3 md:h-[calc(100%-1.5rem)] xl:max-h-[calc(100dvh-160px)]',
        collapsed && 'm-3 flex items-center justify-between px-4',
        pip && 'fixed right-4 bottom-20 z-20 w-33 shadow-[0_10px_32px_#0009] xl:bottom-4',
        mode === 'parked' && 'hidden',
      )}
    >
      <video
        ref={videoRef}
        id="video"
        className={cn(
          'block w-full bg-bg-0 object-cover',
          'aspect-4/3 max-h-[40dvh] md:aspect-auto md:h-full md:max-h-none',
          pip && 'aspect-4/3 max-h-none md:aspect-4/3 md:h-auto',
          collapsed && 'hidden',
        )}
        playsInline
        muted
        autoPlay
      />
      <canvas ref={canvasRef} id="canvas" width="640" height="480" hidden />
      {!pip && (
        <div
          className={cn('pointer-events-none absolute inset-0 bg-text/40 opacity-0 transition-opacity', flashActive && 'opacity-100')}
        />
      )}
      {collapsed && (
        <>
          <span className="py-3 text-sm text-text-dim">Camera hidden — still scanning</span>
          <Button variant="ghost" onClick={onToggleCollapse}><Eye className="size-4" aria-hidden />Show</Button>
        </>
      )}
      {mode === 'full' && (
        <div className="absolute top-2 right-2 flex items-center gap-2">
          {wakeLockHeld && (
            <span className="rounded-full bg-bg-0/70 px-2 py-1 text-xs" title="Screen wake lock held — this device won't sleep">☾</span>
          )}
          <MenuRoot>
            <MenuTrigger asChild>
              <Button variant="ghost" size="icon" className="bg-bg-0/70" aria-label="Camera options">
                <EllipsisVertical className="size-5" aria-hidden />
              </Button>
            </MenuTrigger>
            <MenuContent>
              {showFlip && (
                <MenuItem onSelect={onFlipCamera}><SwitchCamera className="size-4" aria-hidden />Flip camera</MenuItem>
              )}
              <MenuItem onSelect={onToggleCollapse}><VideoOff className="size-4" aria-hidden />Hide camera</MenuItem>
              {!running && !demoMode && <MenuItem onSelect={onDemo}>Try demo</MenuItem>}
            </MenuContent>
          </MenuRoot>
        </div>
      )}
    </div>
  );
}
