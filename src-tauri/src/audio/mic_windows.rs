use windows::core::Result as WinResult;
use windows::Devices::Enumeration::{DeviceAccessInformation, DeviceAccessStatus, DeviceClass};
use windows::Media::Capture::{
    MediaCapture, MediaCaptureInitializationSettings, StreamingCaptureMode,
};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

use crate::error::AppError;

const DENIED: &str = "microphone_denied_windows";

pub fn ensure_access() -> Result<(), AppError> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let result = ensure_access_inner();
    unsafe {
        CoUninitialize();
    }
    result
}

fn ensure_access_inner() -> Result<(), AppError> {
    match current_status() {
        Ok(DeviceAccessStatus::Allowed) => return Ok(()),
        Ok(DeviceAccessStatus::DeniedByUser | DeviceAccessStatus::DeniedBySystem) => {
            return Err(AppError::AudioDevice(DENIED.into()));
        }
        _ => {}
    }
    request_access()
}

fn current_status() -> WinResult<DeviceAccessStatus> {
    let info = DeviceAccessInformation::CreateFromDeviceClass(DeviceClass::AudioCapture)?;
    info.CurrentStatus()
}

fn request_access() -> Result<(), AppError> {
    let settings = MediaCaptureInitializationSettings::new()
        .map_err(|error| AppError::AudioDevice(error.to_string()))?;
    settings
        .SetStreamingCaptureMode(StreamingCaptureMode::Audio)
        .map_err(|error| AppError::AudioDevice(error.to_string()))?;
    let capture =
        MediaCapture::new().map_err(|error| AppError::AudioDevice(error.to_string()))?;
    let operation = capture
        .InitializeWithSettingsAsync(&settings)
        .map_err(|error| AppError::AudioDevice(error.to_string()))?;
    operation
        .get()
        .map_err(|_| AppError::AudioDevice(DENIED.into()))?;
    drop(capture);
    match current_status() {
        Ok(DeviceAccessStatus::DeniedByUser | DeviceAccessStatus::DeniedBySystem) => {
            Err(AppError::AudioDevice(DENIED.into()))
        }
        _ => Ok(()),
    }
}
