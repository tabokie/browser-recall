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
        ? `Last check: no usable desktop connection (${summary}).`
        : 'Last check: no usable desktop connection.';
    }
    case 'manual_reconnect_exhausted': {
      const seconds = diagnostic.elapsedMs
        ? `${Math.round(diagnostic.elapsedMs / 1000)}s`
        : 'the retry window';
      const summary = formatPortFailures(diagnostic.failures);
      const reason = summary
        ? ` Last port failures: ${summary}.`
        : diagnostic.lastDiagnostic
          ? ` Last diagnostic: ${diagnostic.lastDiagnostic}.`
          : '';
      return `Last check: desktop connection did not succeed in ${seconds}.${reason}`;
    }
    case 'manual_status_failed':
      return diagnostic.message
        ? `Last check: status refresh failed (${diagnostic.message}).`
        : 'Last check: status refresh failed.';
    case 'socket_closed':
      return diagnostic.state
        ? `Last check: socket closed (${diagnostic.state}).`
        : 'Last check: socket closed.';
    case 'auth_fail':
      return 'Last check: desktop rejected the saved token.';
    case 'pair_denied':
      return 'Last check: desktop approval was denied.';
    case 'status_after_auth_failed':
      return diagnostic.message
        ? `Last check: authenticated, but status failed (${diagnostic.message}).`
        : 'Last check: authenticated, but status failed.';
    default:
      if (diagnostic.message) return `Last check: ${diagnostic.message}`;
      return `Last check: ${diagnostic.code.replaceAll('_', ' ')}.`;
  }
}

function appendConnectorDiagnostic(meta, connector) {
  if (!connector?.lastDiagnostic) return meta;
  const detail = formatConnectorDiagnostic(connector.lastDiagnostic);
  return detail ? `${meta} ${detail}` : meta;
}

const STATE_FORMATS = {
  connected: {
    status: 'Desktop Connected',
    meta: (connector) =>
      connector.deviceId
        ? `Device ${connector.deviceId}`
        : 'Desktop connection active.',
    tone: '',
  },
  paused: {
    status: 'Desktop Paused',
    meta: (connector) =>
      appendConnectorDiagnostic(
        'Resume capture from desktop settings.',
        connector,
      ),
    tone: 'error',
  },
  pair_pending: {
    status: 'Approval Pending',
    meta: (connector) =>
      appendConnectorDiagnostic(
        'Approve this browser in the desktop app.',
        connector,
      ),
    tone: '',
  },
  pair_denied: {
    status: 'Approval Denied',
    meta: (connector) =>
      appendConnectorDiagnostic('Check again to request approval.', connector),
    tone: 'error',
  },
  auth_failed: {
    status: 'Token Rejected',
    meta: (connector) =>
      appendConnectorDiagnostic('Check again to request approval.', connector),
    tone: 'error',
  },
  starting: {
    status: 'Desktop Offline',
    meta: (connector) =>
      appendConnectorDiagnostic(
        'Start Browser Recall Desktop to resume live capture.',
        connector,
      ),
    tone: '',
  },
  connecting: {
    status: 'Desktop Offline',
    meta: (connector) =>
      appendConnectorDiagnostic(
        connector.hasToken
          ? 'Desktop approved, but connection failed.'
          : 'Start Browser Recall Desktop to resume live capture.',
        connector,
      ),
    tone: '',
  },
};

export function formatDesktopConnectorState(connector = {}) {
  const state = connector.state || 'offline';
  const format = STATE_FORMATS[state];
  if (format) {
    return {
      status: format.status,
      meta: format.meta(connector),
      tone: format.tone,
    };
  }
  if (connector.refuseMode) {
    return {
      status: 'Desktop Queue Full',
      meta: 'Open desktop to flush capture.',
      tone: 'error',
    };
  }
  return {
    status: 'Desktop Offline',
    meta: connector.hasToken
      ? appendConnectorDiagnostic(
          'Desktop approved, but connection failed.',
          connector,
        )
      : appendConnectorDiagnostic(
          'Start Browser Recall Desktop to resume live capture.',
          connector,
        ),
    tone: 'error',
  };
}
