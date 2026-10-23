// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app. Shared by index.js and the tests, so the
// tests run the exact wiring of the container.
// -----------------------------------------------------------------------------

import { ACTIONS } from './constants.js';

export function registerHandlers(gladys, app, logger) {
  // Discovery: the shades are published at each report; Scan sends them again.
  gladys.onScanRequest(() => app.scan());
  gladys.onDeviceCreated((device) => app.deviceCreated(device));
  gladys.onDeviceUpdated((device) => app.deviceCreated(device));
  gladys.onDeviceDeleted((device) => app.deviceDeleted(device));

  // Commands.
  gladys.onSetValue((device, feature, value) => app.setValue(device, feature, value));

  // Configuration screen buttons.
  gladys.onAction(ACTIONS.TEST, () => app.testConnection());
  // Pins exactly the changed certificate the status shows, at the second
  // press within 60 s.
  gladys.onAction(ACTIONS.TRUST_CERTIFICATE, () => app.trustCertificate());

  // Configuration saved by the user.
  gladys.onConfigUpdated((config) => app.configUpdated(config));

  // Connection lifecycle (also after every reconnection to Gladys): a
  // reconnection keeps the pauses and the stops, connects to nothing, and
  // publishes the status, the Discovery and the badges again.
  gladys.on('connected', async () => {
    try {
      await app.connected(await gladys.getConfig());
    } catch (err) {
      logger?.error('Start failed', err);
    }
  });
}
