import { useRef } from 'react';
import { Camera, Upload, X } from 'lucide-react';
import { cn } from '../ui/cn.js';
import { Button } from '../ui/button.jsx';
import { Card } from '../ui/card.jsx';

// What "should this image trigger?" a sample is labelled with. Cycled by tap:
// unlabeled → should trigger → should stay clear.
export function ExpectedBadge({ expected }) {
  const [text, cls] = expected === true
    ? ['Expect trigger', 'bg-warn/15 text-warn']
    : expected === false
      ? ['Expect clear', 'bg-ok/15 text-ok']
      : ['Unlabeled', 'bg-bg-2 text-text-dim'];
  return <span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', cls)}>{text}</span>;
}

export default function SampleImages({ images, onFiles, onCapture, onCycleExpected, onRemove, monitorRunning }) {
  const fileInput = useRef(null);
  return (
    <Card className="flex flex-col gap-3">
      <h2 className="text-xl font-semibold">Sample images ({images.length})</h2>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => fileInput.current?.click()}><Upload className="size-4" aria-hidden />Upload</Button>
        <Button variant="outline" onClick={onCapture} title={monitorRunning ? '' : 'Arm the monitor to capture from the camera'}>
          <Camera className="size-4" aria-hidden />Capture frame
        </Button>
        <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={onFiles} />
      </div>
      {images.length === 0 ? (
        <p className="text-sm text-text-dim">No sample images yet. Upload photos or capture frames of the scenes you want to test.</p>
      ) : (
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
          {images.map((img) => (
            <div key={img.id} className="relative overflow-hidden rounded-md border border-border bg-bg-0">
              <img className="aspect-4/3 w-full object-cover" src={img.dataUrl} alt={`sample ${img.source}`} />
              <button
                type="button"
                className="flex min-h-11 w-full items-center justify-center"
                onClick={() => onCycleExpected(img)}
                title="Cycle expected outcome: unlabeled → trigger → clear"
              >
                <ExpectedBadge expected={img.expected} />
              </button>
              <Button variant="ghost" size="icon" className="absolute top-1 right-1 size-9 bg-bg-0/70" aria-label="Remove image" onClick={() => onRemove(img.id)}>
                <X className="size-4" aria-hidden />
              </Button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
