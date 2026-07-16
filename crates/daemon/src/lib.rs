#![cfg_attr(
    not(test),
    deny(
        clippy::expect_used,
        clippy::panic,
        clippy::unreachable,
        clippy::unwrap_used
    )
)]

pub mod capture_policy;
pub mod command_authority;
pub mod commands;
pub mod config;
pub mod connectors;
pub mod mutations;
pub mod pairing;
pub mod protocol;
pub mod read_projections;
pub mod rules;
pub mod runtime;
pub mod search;
pub mod settings;
pub mod storage;
pub mod sync;
pub mod ws_server;

pub use config::{
    current_hostname, ApprovedConnector, ConfigStore, DaemonConfig, SyncDeviceRecord, Token,
};
pub use pairing::{
    ApprovalFuture, PairingApprover, PairingDecision, PairingRequest, PairingTimeout,
};
pub use ws_server::{
    ConnectedConnector, ServerHandle, ServerSnapshot, ServerStartOptions, ServiceStatus,
    WsServerError,
};
