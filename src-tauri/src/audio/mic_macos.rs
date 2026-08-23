use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use dispatch2::DispatchQueue;
use objc2::runtime::Bool;
use objc2::{class, msg_send};
use objc2_foundation::NSString;

use crate::error::AppError;

pub const MICROPHONE_DENIED: &str = "microphone_denied_macos";

fn authorization_status() -> isize {
    let media = NSString::from_str("soun");
    unsafe {
        let cls = class!(AVCaptureDevice);
        msg_send![cls, authorizationStatusForMediaType: &*media]
    }
}

pub fn is_denied() -> bool {
    matches!(authorization_status(), 1 | 2)
}

pub fn denied_or(fallback: AppError) -> AppError {
    if is_denied() {
        AppError::AudioDevice(MICROPHONE_DENIED.into())
    } else {
        fallback
    }
}

pub fn ensure_access() -> Result<(), AppError> {
    if authorization_status() != 0 {
        return Ok(());
    }
    match request_access() {
        Ok(()) => Ok(()),
        Err(error) if error.to_string().contains(MICROPHONE_DENIED) => Err(error),
        Err(_) => Ok(()),
    }
}

fn request_access() -> Result<(), AppError> {
    let (tx, rx) = mpsc::channel();
    DispatchQueue::main().exec_async(move || {
        let media = NSString::from_str("soun");
        let handler = RcBlock::new(move |granted: Bool| {
            let _ = tx.send(granted.as_bool());
        });
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
        Ok(false) => Err(AppError::AudioDevice(MICROPHONE_DENIED.into())),
        Err(_) => Ok(()),
    }
}
