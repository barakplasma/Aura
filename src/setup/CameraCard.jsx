import { useState } from 'react';
import { Button } from '../ui/button.jsx';
import { Card } from '../ui/card.jsx';
import { Field } from '../ui/field.jsx';
import { Select } from '../ui/input.jsx';
import { Segmented } from '../ui/segmented.jsx';
import { Status } from '../ui/status.jsx';

const FACING = [
  { id: 'environment', label: 'Back' },
  { id: 'user', label: 'Front' },
];

// Where frames come from: a camera (which one) or a shared screen.
export default function CameraCard({ s, set }) {
  const [cameras, setCameras] = useState([]);
  const [note, setNote] = useState(null);

  // Device labels are blank until camera permission is granted — request a
  // throwaway stream first, stop it, then enumerate the video inputs.
  async function handleDetect() {
    setNote({ tone: 'neutral', text: 'Requesting camera permission…' });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      stream.getTracks().forEach((t) => t.stop());
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cams = devices.filter((d) => d.kind === 'videoinput');
      setCameras(cams);
      setNote({ tone: 'ok', text: `Found ${cams.length} camera${cams.length === 1 ? '' : 's'}.` });
    } catch (err) {
      setNote({ tone: 'danger', text: `Camera detection failed: ${err.message}` });
    }
  }

  return (
    <Card className="flex flex-col gap-4" data-setup-card="camera">
      <h2 className="text-xl font-semibold">Camera &amp; device</h2>
      <Field
        label="Source"
        htmlFor="video-source"
        hint={s.videoSource === 'screen'
          ? 'Screen share needs a fresh browser prompt each time you arm, and is effectively desktop-only. Monitoring stops when you stop sharing.'
          : undefined}
      >
        <Select id="video-source" value={s.videoSource} onChange={(e) => set.videoSource(e.target.value)}>
          <option value="camera">Camera</option>
          <option value="screen">Screen share</option>
        </Select>
      </Field>

      {s.videoSource !== 'screen' && (
        <>
          <Field label="Facing" hint="Used when Device is Auto. Picking a specific device below overrides it.">
            <Segmented
              label="Camera facing"
              value={s.cameraFacing}
              onChange={(id) => { set.cameraFacing(id); set.cameraDeviceId(''); }}
              options={FACING}
            />
          </Field>
          <Field label="Device" htmlFor="camera-device">
            <div className="flex gap-2">
              <Select id="camera-device" value={s.cameraDeviceId} onChange={(e) => set.cameraDeviceId(e.target.value)}>
                <option value="">Auto (by facing)</option>
                {/* Keep a previously saved device selectable before detection runs. */}
                {s.cameraDeviceId && !cameras.some((c) => c.deviceId === s.cameraDeviceId) && (
                  <option value={s.cameraDeviceId}>Saved device</option>
                )}
                {cameras.map((c, i) => (
                  <option key={c.deviceId} value={c.deviceId}>{c.label || `Camera ${i + 1}`}</option>
                ))}
              </Select>
              <Button id="detect-cameras-btn" variant="outline" onClick={handleDetect}>Detect cameras</Button>
            </div>
            <Status id="camera-status" tone={note?.tone}>{note?.text}</Status>
          </Field>
        </>
      )}
    </Card>
  );
}
