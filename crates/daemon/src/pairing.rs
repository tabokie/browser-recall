use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairingRequest {
    pub request_id: String,
    pub browser_id: String,
    pub browser_name: String,
    pub extension_id: String,
    pub browser_profile: Option<String>,
    pub origin: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairingDecision {
    Approve,
    Deny,
}

pub type ApprovalFuture = Pin<Box<dyn Future<Output = PairingDecision> + Send + 'static>>;
pub type PairingApprover = Arc<dyn Fn(PairingRequest) -> ApprovalFuture + Send + Sync + 'static>;

pub fn static_approver(decision: PairingDecision) -> PairingApprover {
    Arc::new(move |_request| Box::pin(async move { decision }))
}

pub async fn with_timeout(
    approver: &PairingApprover,
    request: PairingRequest,
    timeout: Duration,
) -> PairingDecision {
    match tokio::time::timeout(timeout, approver(request)).await {
        Ok(decision) => decision,
        Err(_) => PairingDecision::Deny,
    }
}
