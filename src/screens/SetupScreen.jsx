import { Button } from '../ui/button.jsx';
import AdvancedCard from '../setup/AdvancedCard.jsx';
import CadenceCard from '../setup/CadenceCard.jsx';
import CameraCard from '../setup/CameraCard.jsx';
import DeliveryCard from '../setup/DeliveryCard.jsx';
import EngineCard from '../setup/EngineCard.jsx';

// Setup, once: pick and prove an engine, then the cards beside it. `s` is the
// current settings and `set` their setters (App owns the storage). Lab has no
// phone tab, so a row here reaches it below the desktop rail's width.
export default function SetupScreen({
  s, set, captureFrame, onOpenLab,
  pricing, pricingOverride, onSetPricingOverride, onResetPricingOverride,
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-bg-0 p-3">
      <div className="mx-auto flex max-w-2xl flex-col gap-3">
        <h1 className="px-1 text-3xl font-semibold">Setup</h1>
        <EngineCard s={s} set={set} captureFrame={captureFrame} />
        <CadenceCard s={s} set={set} />
        <DeliveryCard s={s} set={set} />
        <CameraCard s={s} set={set} />
        <AdvancedCard
          s={s}
          set={set}
          pricing={pricing}
          pricingOverride={pricingOverride}
          onSetPricingOverride={onSetPricingOverride}
          onResetPricingOverride={onResetPricingOverride}
        />
        <div className="xl:hidden">
          <Button variant="outline" className="w-full" onClick={onOpenLab}>Lab — examples &amp; evaluation</Button>
        </div>
      </div>
    </div>
  );
}
