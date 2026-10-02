import { Button } from '../ui/button.jsx';
import { Card } from '../ui/card.jsx';
import ArmBar from '../components/ArmBar.jsx';
import MissionCard from '../components/MissionCard.jsx';
import VerdictCard from '../components/VerdictCard.jsx';

// The daily screen. The camera stage is App's always-mounted sibling, so this
// is only the panel beside/below it: verdict, mission, and the arm bar pinned
// to the bottom outside the scroll area.
export default function WatchScreen({
  verdict, recent, running, progress, telemetry, engine, modelLabel, providerReady, demoMode,
  onToggle, onDemo, onInstall, onOpenSetup, onOpenLab, onOpenEntry, mission, ...missionProps
}) {
  // Only while the object gate is actually running: without it there is
  // nothing here the verdict doesn't already say.
  const gateActive = running && telemetry?.gate && telemetry.gate !== '—';
  const setupNeeded = !providerReady && !demoMode && !running;
  return (
    <section className="flex min-h-0 flex-col bg-bg-0">
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {setupNeeded && (
          <Card data-setup-needed="">
            <p className="font-semibold">Finish setup to monitor</p>
            <p className="mt-1 text-text-dim">
              {engine === 'browser'
                ? 'Download a browser model in Setup.'
                : engine === 'decision'
                  ? 'Choose a decision model in Setup (and your self-hosted server URL, if you use one), or try the demo.'
                  : 'Choose a provider and vision model in Setup, or try the demo.'}
            </p>
            <div className="mt-3">
              <Button variant="outline" onClick={onOpenSetup}>Open setup</Button>
            </div>
          </Card>
        )}
        {onInstall && !running && (
          <Card data-install-prompt="">
            <p className="font-semibold">Install Aura</p>
            <p className="mt-1 text-text-dim">Runs full screen, starts offline, and keeps a long watch steadier than a browser tab.</p>
            <div className="mt-3">
              <Button variant="outline" onClick={onInstall}>Install app</Button>
            </div>
          </Card>
        )}
        <VerdictCard
          verdict={verdict}
          running={running}
          progress={progress}
          recent={recent}
          modelLabel={modelLabel}
          onDemo={onDemo}
          onFix={onOpenSetup}
          onOpenEntry={onOpenEntry}
        />
        {gateActive && (
          <Card className="text-sm" data-gate-notice="">
            <strong>Object gate</strong>
            <p>Sees: {telemetry.objects || 'nothing yet'}</p>
            <p>Last check: {telemetry.gate} · {telemetry.gateSkipped} skipped · detector {telemetry.detect}</p>
          </Card>
        )}
        <MissionCard running={running} engine={engine} mission={mission} onOpenLab={onOpenLab} {...missionProps} />
      </div>
      <ArmBar running={running} onToggle={onToggle} />
    </section>
  );
}
