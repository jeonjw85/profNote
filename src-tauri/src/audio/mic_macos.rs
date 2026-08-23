use std::ffi::c_void;
use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use dispatch2::DispatchQueue;
use objc2::runtime::Bool;
use objc2::{class, msg_send};

use crate::error::AppError;

pub const MICROPHONE_DENIED: &str = "microphone_denied_macos";

#[link(name = "AVFoundation", kind = "framework")]
unsafe extern "C" {
    static AVMediaTypeAudio: *const c_void;
}

fn authorization_status() -> isize {
    unsafe {
        let cls = class!(AVCaptureDevice);
        let media = AVMediaTypeAudio;
        msg_send![cls, authorizationStatusForMediaType: media]
    }
}

pub fn ensure_access() -> Result<(), AppError> {
    match authorization_status() {
        3 => Ok(()),
        1 | 2 => Err(AppError::AudioDevice(MICROPHONE_DENIED.into())),
        _ => request_access(),
    }
}

fn request_access() -> Result<(), AppError> {
    let (tx, rx) = mpsc::channel();
    DispatchQueue::main().exec_async(move || {
        let handler = RcBlock::new(move |granted: Bool| {
            let _ = tx.send(bool::from(granted));
        });
        unsafe {
            let cls = class!(AVCaptureDevice);
            let media = AVMediaTypeAudio;
            let _: () = msg_send![
                cls,
                requestAccessForMediaType: media,
                completionHandler: &*handler
            ];
        }
    });
    match rx.recv_timeout(Duration::from_secs(180)) {
        Ok(true) => Ok(()),
        Ok(false) => Err(AppError::AudioDevice(MICROPHONE_DENIED.into())),
        Err(_) => Err(AppError::AudioDevice(MICROPHONE_DENIED.into())),
    }
}
