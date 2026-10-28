import { useState } from 'react';
import { Button } from '@ui/Button';
import { productTelemetryEnabled, setProductTelemetryEnabled } from '~/lib/telemetry.client';

export function TelemetryPreference() {
  // Rendered only in the browser (ClientTelemetryPreference), where the stored choice can be read at once.
  const [enabled, setEnabled] = useState(productTelemetryEnabled);

  const updatePreference = (next: boolean) => {
    setProductTelemetryEnabled(next);
    setEnabled(productTelemetryEnabled());
  };

  return (
    <div className="app-card mt-4 p-4" aria-live="polite">
      <p className="mt-0 font-medium text-content-primary">
        Product telemetry is {enabled ? 'enabled' : 'disabled'} on this browser.
      </p>
      <p>
        This choice is stored on this device. Global Privacy Control and Do Not Track keep telemetry disabled even if
        you opt in.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" disabled={enabled} onClick={() => updatePreference(true)}>
          Allow telemetry
        </Button>
        <Button size="sm" variant="neutral" disabled={!enabled} onClick={() => updatePreference(false)}>
          Disable telemetry
        </Button>
      </div>
    </div>
  );
}
