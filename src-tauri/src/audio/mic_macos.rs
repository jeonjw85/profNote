use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use dispatch2::DispatchQueue;
use objc2::runtime::Bool;
use objc2::{class, msg_send};
use objc2_foundation::NSString;

use crate::error::AppError;

pub const MICROPHONE_DENIED: &str = "microphone_denied_macos";

const AV_MEDIA_TYPE_AUDIO: &str = "soun";
const AV_AUTHORIZATION_NOT_DETERMINED: isize = 0;
const AV_AUTHORIZATION_RESTRICTED: isize = 1;
const AV_AUTHORIZATION_DENIED: isize = 2;
const AV_AUTHORIZATION_AUTHORIZED: isize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MicAuthorization {
    NotDetermined,
    Restricted,
    Denied,
    Authorized,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AccessAction {
    Allow,
    Request,
    Deny,
}

impl MicAuthorization {
    const fn from_status(status: isize) -> Option<Self> {
        match status {
            AV_AUTHORIZATION_NOT_DETERMINED => Some(Self::NotDetermined),
            AV_AUTHORIZATION_RESTRICTED => Some(Self::Restricted),
            AV_AUTHORIZATION_DENIED => Some(Self::Denied),
            AV_AUTHORIZATION_AUTHORIZED => Some(Self::Authorized),
            _ => None,
        }
    }

    const fn is_denied(self) -> bool {
        matches!(self, Self::Restricted | Self::Denied)
    }
}

const fn access_action(status: Option<MicAuthorization>) -> AccessAction {
    match status {
        Some(MicAuthorization::Authorized) => AccessAction::Allow,
        Some(MicAuthorization::Denied | MicAuthorization::Restricted) => AccessAction::Deny,
        Some(MicAuthorization::NotDetermined) | None => AccessAction::Request,
    }
}

fn authorization_status() -> isize {
    let media = NSString::from_str(AV_MEDIA_TYPE_AUDIO);
    // SAFETY: [Category 8 — FFI boundary]
    // AVCaptureDevice.authorizationStatusForMediaType: is a class method that
    // takes AVMediaType (`soun` = audio) and returns AVAuthorizationStatus as NSInteger.
    unsafe {
        let cls = class!(AVCaptureDevice);
        msg_send![cls, authorizationStatusForMediaType: &*media]
    }
}

pub fn is_denied() -> bool {
    MicAuthorization::from_status(authorization_status()).is_some_and(MicAuthorization::is_denied)
}

pub fn denied_or(fallback: AppError) -> AppError {
    if is_denied() {
        AppError::AudioDevice(MICROPHONE_DENIED.into())
    } else {
        fallback
    }
}

fn denied() -> AppError {
    AppError::AudioDevice(MICROPHONE_DENIED.into())
}

pub fn ensure_access() -> Result<(), AppError> {
    match access_action(MicAuthorization::from_status(authorization_status())) {
        AccessAction::Allow => Ok(()),
        AccessAction::Deny => Err(denied()),
        AccessAction::Request => request_access(),
    }
}

fn request_access() -> Result<(), AppError> {
    let (tx, rx) = mpsc::channel();
    DispatchQueue::main().exec_async(move || {
        let media = NSString::from_str(AV_MEDIA_TYPE_AUDIO);
        let handler = RcBlock::new(move |granted: Bool| {
            let _ = tx.send(granted.as_bool());
        });
        // SAFETY: [Category 8 — FFI boundary]
        // requestAccessForMediaType:completionHandler: is invoked on the main
        // queue with AVMediaType audio and a 'vB' block that only sends on `tx`.
        unsafe {
            let cls = class!(AVCaptureDevice);
            let _: () = msg_send![
                cls,
                requestAccessForMediaType: &*media,
                completionHandler: &*handler
            ];
        }
    });
    match rx.recv_timeout(Duration::from_secs(180)) {
        Ok(true) => Ok(()),
        Ok(false) => Err(denied()),
        Err(_) if is_denied() => Err(denied()),
        Err(_) => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::{access_action, AccessAction, MicAuthorization};

    #[test]
    fn maps_avfoundation_authorization_status_values() {
        assert_eq!(
            MicAuthorization::from_status(0),
            Some(MicAuthorization::NotDetermined)
        );
        assert_eq!(
            MicAuthorization::from_status(1),
            Some(MicAuthorization::Restricted)
        );
        assert_eq!(
            MicAuthorization::from_status(2),
            Some(MicAuthorization::Denied)
        );
        assert_eq!(
            MicAuthorization::from_status(3),
            Some(MicAuthorization::Authorized)
        );
        assert_eq!(MicAuthorization::from_status(4), None);
        assert_eq!(MicAuthorization::from_status(-1), None);
    }

    #[test]
    fn denies_only_restricted_and_denied_status() {
        assert!(MicAuthorization::Restricted.is_denied());
        assert!(MicAuthorization::Denied.is_denied());
        assert!(!MicAuthorization::Authorized.is_denied());
        assert!(!MicAuthorization::NotDetermined.is_denied());
    }

    #[test]
    fn requests_prompt_when_undetermined_or_unknown() {
        assert_eq!(
            access_action(Some(MicAuthorization::Authorized)),
            AccessAction::Allow
        );
        assert_eq!(
            access_action(Some(MicAuthorization::NotDetermined)),
            AccessAction::Request
        );
        assert_eq!(
            access_action(Some(MicAuthorization::Denied)),
            AccessAction::Deny
        );
        assert_eq!(
            access_action(Some(MicAuthorization::Restricted)),
            AccessAction::Deny
        );
        assert_eq!(access_action(None), AccessAction::Request);
    }
}
