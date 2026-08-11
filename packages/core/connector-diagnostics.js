import { tr } from './i18n.js';

export function formatPortFailures(failures) {
  if (!Array.isArray(failures) || failures.length === 0) return '';
  return failures
    .slice(0, 5)
    .map((failure) => `${failure.port}: ${failure.code}`)
    .join(', ');
}

export function formatConnectorDiagnostic(diagnostic) {
  if (!diagnostic?.code) return '';
  switch (diagnostic.code) {
    case 'no_ports_reachable': {
      const summary = formatPortFailures(diagnostic.failures);
      return summary
        ? tr(
            'extensionLastCheckNoConnectionDetail',
            `Last check: no usable desktop connection (${summary}).`,
            [summary],
          )
        : tr(
            'extensionLastCheckNoConnection',
            'Last check: no usable desktop connection.',
            undefined,
          );
    }
    case 'manual_reconnect_exhausted': {
      const seconds = diagnostic.elapsedMs
        ? `${Math.round(diagnostic.elapsedMs / 1000)}s`
        : tr('extensionRetryWindow', 'the retry window', undefined);
      const reason = formatReconnectFailureReason(diagnostic);
      return `${tr('extensionLastCheckReconnectFailed', `Last check: desktop connection did not succeed in ${seconds}.`, [seconds])}${reason}`;
    }
    case 'manual_status_failed':
      return diagnostic.message
        ? tr(
            'extensionLastCheckStatusRefreshFailedDetail',
            `Last check: status refresh failed (${diagnostic.message}).`,
            [diagnostic.message],
          )
        : tr(
            'extensionLastCheckStatusRefreshFailed',
            'Last check: status refresh failed.',
            undefined,
          );
    case 'socket_closed':
      return diagnostic.state
        ? tr(
            'extensionLastCheckSocketClosedDetail',
            `Last check: socket closed (${diagnostic.state}).`,
            [diagnostic.state],
          )
        : tr(
            'extensionLastCheckSocketClosed',
            'Last check: socket closed.',
            undefined,
          );
    case 'auth_fail':
      return tr(
        'extensionLastCheckTokenRejected',
        'Last check: desktop rejected the saved token.',
        undefined,
      );
    case 'pair_denied':
      return tr(
        'extensionLastCheckApprovalDenied',
        'Last check: desktop approval was denied.',
        undefined,
      );
    case 'status_after_auth_failed':
      return diagnostic.message
        ? tr(
            'extensionLastCheckAuthenticatedStatusFailedDetail',
            `Last check: authenticated, but status failed (${diagnostic.message}).`,
            [diagnostic.message],
          )
        : tr(
            'extensionLastCheckAuthenticatedStatusFailed',
            'Last check: authenticated, but status failed.',
            undefined,
          );
    default:
      if (diagnostic.message) {
        return tr(
          'extensionLastCheckMessage',
          `Last check: ${diagnostic.message}`,
          [diagnostic.message],
        );
      }
      return tr(
        'extensionLastCheckCode',
        `Last check: ${diagnostic.code.replaceAll('_', ' ')}.`,
        [diagnostic.code.replaceAll('_', ' ')],
      );
  }
}

function formatReconnectFailureReason(diagnostic) {
  const summary = formatPortFailures(diagnostic.failures);
  if (summary) {
    return tr('extensionLastPortFailures', ` Last port failures: ${summary}.`, [
      summary,
    ]);
  }
  if (diagnostic.lastDiagnostic) {
    return tr(
      'extensionLastDiagnostic',
      ` Last diagnostic: ${diagnostic.lastDiagnostic}.`,
      [diagnostic.lastDiagnostic],
    );
  }
  return '';
}

function appendConnectorDiagnostic(meta, connector) {
  if (!connector?.lastDiagnostic) return meta;
  const detail = formatConnectorDiagnostic(connector.lastDiagnostic);
  return detail ? `${meta} ${detail}` : meta;
}

function formatOfflineMeta(connector) {
  const message = connector.hasToken
    ? tr(
        'extensionDesktopApprovedConnectionFailed',
        'Desktop approved, but connection failed.',
        undefined,
      )
    : tr(
        'extensionStartDesktopCapture',
        'Start Browser Recall Desktop to resume live capture.',
        undefined,
      );
  return appendConnectorDiagnostic(message, connector);
}

const STATE_FORMATS = {
  connected: {
    status: () =>
      tr('extensionDesktopConnected', 'Desktop Connected', undefined),
    meta: (connector) =>
      connector.deviceId
        ? tr('extensionDeviceId', `Device ${connector.deviceId}`, [
            connector.deviceId,
          ])
        : tr(
            'extensionDesktopConnectionActive',
            'Desktop connection active.',
            undefined,
          ),
    tone: '',
  },
  paused: {
    status: () => tr('extensionDesktopPaused', 'Desktop Paused', undefined),
    meta: (connector) =>
      appendConnectorDiagnostic(
        tr(
          'extensionResumeCaptureDesktop',
          'Resume capture from desktop settings.',
          undefined,
        ),
        connector,
      ),
    tone: 'error',
  },
  pair_pending: {
    status: () => tr('extensionApprovalPending', 'Approval Pending', undefined),
    meta: (connector) =>
      appendConnectorDiagnostic(
        tr(
          'extensionApproveBrowserDesktop',
          'Approve this browser in the desktop app.',
          undefined,
        ),
        connector,
      ),
    tone: '',
  },
  pair_denied: {
    status: () => tr('extensionApprovalDenied', 'Approval Denied', undefined),
    meta: (connector) =>
      appendConnectorDiagnostic(
        tr(
          'extensionCheckAgainApproval',
          'Check again to request approval.',
          undefined,
        ),
        connector,
      ),
    tone: 'error',
  },
  auth_failed: {
    status: () => tr('extensionTokenRejected', 'Token Rejected', undefined),
    meta: (connector) =>
      appendConnectorDiagnostic(
        tr(
          'extensionCheckAgainApproval',
          'Check again to request approval.',
          undefined,
        ),
        connector,
      ),
    tone: 'error',
  },
  starting: {
    status: () =>
      tr(
        'extensionLookingForDesktop',
        'Looking for Browser Recall Desktop',
        undefined,
      ),
    meta: (connector) =>
      appendConnectorDiagnostic(
        tr(
          'extensionStartDesktopCapture',
          'Start Browser Recall Desktop to resume live capture.',
          undefined,
        ),
        connector,
      ),
    tone: '',
  },
  connecting: {
    status: () => tr('extensionDesktopOffline', 'Desktop Offline', undefined),
    meta: formatOfflineMeta,
    tone: '',
  },
  incompatible: {
    status: () =>
      tr(
        'extensionDesktopVersionIncompatible',
        'Desktop Version Incompatible',
        undefined,
      ),
    meta: (connector) =>
      appendConnectorDiagnostic(
        tr(
          'extensionUpdateDesktopAndExtension',
          'Update Browser Recall Desktop and the extension to matching versions.',
          undefined,
        ),
        connector,
      ),
    tone: 'error',
  },
};

export function formatDesktopConnectorState(connector) {
  if (!connector || typeof connector !== 'object' || Array.isArray(connector)) {
    throw new Error('Connector status must be an object');
  }
  const state = connector.state;
  if (typeof state !== 'string' || !state) {
    throw new Error('Connector status is missing state');
  }
  const format = STATE_FORMATS[state];
  if (format) {
    return {
      status: format.status(),
      meta: format.meta(connector),
      tone: format.tone,
    };
  }
  if (state !== 'offline') {
    throw new Error(`Unknown connector state: ${state}`);
  }
  if (connector.refuseMode) {
    return {
      status: tr('extensionDesktopQueueFull', 'Desktop Queue Full', undefined),
      meta: tr(
        'extensionOpenDesktopFlush',
        'Open desktop to flush capture.',
        undefined,
      ),
      tone: 'error',
    };
  }
  return {
    status: tr('extensionDesktopOffline', 'Desktop Offline', undefined),
    meta: formatOfflineMeta(connector),
    tone: 'error',
  };
}
