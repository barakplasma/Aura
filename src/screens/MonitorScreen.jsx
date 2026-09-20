import {
  IonButton, IonCard, IonCardContent, IonContent, IonItem, IonLabel,
  IonList, IonNote, IonProgressBar,
} from '@ionic/react';
import { progressLabel } from '../components/ProgressBar.jsx';

function fmtMs(ms) {
  if (ms === Infinity) return 'Off';
  if (!Number.isFinite(ms)) return '—';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function Metric({ value, label }) {
  return <IonCard className="metric-card"><IonCardContent>
    <strong>{value}</strong><IonNote>{label}</IonNote>
  </IonCardContent></IonCard>;
}

function DataRow({ label, value, detail }) {
  return <IonItem detail={detail}><IonLabel>{label}</IonLabel><IonNote slot="end">{value}</IonNote></IonItem>;
}

export default function MonitorScreen({
  running, telemetry, progress, stats, onToggle, providerReady, engine,
  demoMode, onStartDemo, onOpenSettings,
}) {
  const showProgress = running && progress?.phase !== 'idle';
  return <IonContent className="aura-page monitor-content">
    <section className="metrics" aria-label="Current scan metrics">
      <Metric value={`${telemetry.confidence}%`} label="Confidence" />
      <Metric value={`${telemetry.latency}ms`} label="Latency" />
      <Metric value={`$${telemetry.cost}`} label="Cost" />
    </section>

    {showProgress && <section className="scan-status ion-padding-horizontal" aria-live="polite">
      <IonNote>{progressLabel(progress)}</IonNote>
      <IonProgressBar type={Number.isFinite(progress.pct) ? undefined : 'indeterminate'} value={Number.isFinite(progress.pct) ? progress.pct / 100 : undefined} />
    </section>}

    <IonList inset aria-label="Scan details">
      <DataRow label="Engine" value={telemetry.mode || '—'} />
      <DataRow label="Frame" value={telemetry.frameDetails || '—'} />
      <DataRow label="Last frame tokens" value={telemetry.frameTokens ?? '—'} />
      <DataRow label="Session tokens" value={telemetry.tokens ?? '—'} />
      <DataRow label="Scans per hour" value={telemetry.scansPerHr ?? '—'} />
      <DataRow label="Estimated cost / hour" value={`$${telemetry.costPerHr ?? '0.0000'}`} />
      {telemetry.skipped > 0 && <DataRow label="Skipped frames" value={telemetry.skipped} />}
    </IonList>

    <IonList inset aria-label="Frame timing">
      <IonItem><IonLabel><h2>Frame timing</h2></IonLabel></IonItem>
      <DataRow label="Median" value={fmtMs(stats.p50)} />
      <DataRow label="P90" value={fmtMs(stats.p90)} />
      <DataRow label="Adaptive timeout" value={fmtMs(stats.timeoutMs)} />
      <DataRow label="Samples" value={stats.count} />
    </IonList>

    {!providerReady && !demoMode && !running && <IonCard className="notice"><IonCardContent>
      <strong>Finish setup to monitor</strong>
      <p>{engine === 'browser'
        ? 'Download a browser model in Settings.'
        : 'Choose a provider and vision model in Settings, or try the demo.'}</p>
      <IonButton fill="outline" onClick={onOpenSettings}>Open settings</IonButton>
      <IonButton fill="clear" onClick={onStartDemo}>Try demo</IonButton>
    </IonCardContent></IonCard>}

    <div className="wide-action">
      <IonButton id="toggle" expand="block" size="large" color={running ? 'danger' : 'primary'} onClick={onToggle} aria-pressed={running}>
        {running ? 'Disarm monitoring' : 'Arm monitoring'}
      </IonButton>
    </div>
  </IonContent>;
}
