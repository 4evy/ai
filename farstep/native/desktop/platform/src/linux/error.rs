use derive_more::{Deref, DerefMut, From, Into};
use farstep_protocol as protocol;

// Keep native error conversions beside the Linux APIs that produce them
#[derive(Clone, Debug, Deref, DerefMut, From, Into)]
pub struct Failure(protocol::Failure);
pub type Result<T> = std::result::Result<T, Failure>;

impl Failure {
    pub fn new(code: &'static str, message: impl ToString) -> Self {
        Self(protocol::Failure::new(code, message))
    }
}

impl From<ashpd::Error> for Failure {
    fn from(value: ashpd::Error) -> Self {
        let code = match &value {
            ashpd::Error::Response(ashpd::desktop::ResponseError::Cancelled) => "cancelled",
            ashpd::Error::Response(_) => "denied",
            ashpd::Error::Portal(ashpd::PortalError::Cancelled(_)) => "cancelled",
            ashpd::Error::Portal(ashpd::PortalError::NotAllowed(_)) => "denied",
            ashpd::Error::PortalNotFound(_) | ashpd::Error::RequiresVersion(..) => {
                "missing-protocol"
            }
            _ => "backend-error",
        };
        Self::new(code, value)
    }
}
