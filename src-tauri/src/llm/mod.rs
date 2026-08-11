use std::io::Read;
use std::time::Duration;

use tauri::ipc::Channel;

use crate::error::AppError;

const IDLE_TIMEOUT: Duration = Duration::from_secs(120);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(1800);
const ERROR_BODY_LIMIT: u64 = 4096;
const READ_CHUNK_BYTES: usize = 8 * 1024;

pub fn stream_chat(
    url: &str,
    api_key: &str,
    model: &str,
    system_prompt: &str,
    user_content: &str,
    on_delta: &Channel<String>,
) -> Result<(), AppError> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(AppError::InvalidInput(format!(
            "llm url must start with http:// or https://: {url}"
        )));
    }

    let body = serde_json::json!({
        "model": model,
        "temperature": 0.3,
        "stream": true,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_content }
        ]
    });

    let request = ureq::post(url)
        .config()
        .http_status_as_error(false)
        .timeout_recv_response(Some(IDLE_TIMEOUT))
        .timeout_recv_body(Some(IDLE_TIMEOUT))
        .timeout_global(Some(TOTAL_TIMEOUT))
        .build();
    let request = if api_key.is_empty() {
        request
    } else {
        request.header("Authorization", format!("Bearer {api_key}"))
    };
    let response = request
        .send_json(body)
        .map_err(|e| AppError::Llm(e.to_string()))?;

    let status = response.status();
    if !status.is_success() {
        let detail = read_error_detail(response.into_body());
        return Err(AppError::Llm(format!(
            "HTTP {}: {detail}",
            status.as_u16()
        )));
    }

    stream_sse_deltas(response.into_body().into_reader(), on_delta)
}

fn read_error_detail(body: ureq::Body) -> String {
    let mut raw = Vec::new();
    let _ = body
        .into_reader()
        .take(ERROR_BODY_LIMIT)
        .read_to_end(&mut raw);
    let text = String::from_utf8_lossy(&raw);
    extract_api_message(&text).unwrap_or_else(|| text.trim().to_string())
}

fn extract_api_message(raw: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let message = value.pointer("/error/message")?.as_str()?;
    if message.is_empty() {
        None
    } else {
        Some(message.to_string())
    }
}

fn stream_sse_deltas<R: Read>(mut reader: R, on_delta: &Channel<String>) -> Result<(), AppError> {
    let mut pending: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; READ_CHUNK_BYTES];
    loop {
        let read = reader
            .read(&mut chunk)
            .map_err(|e| AppError::Llm(e.to_string()))?;
        if read == 0 {
            break;
        }
        pending.extend_from_slice(&chunk[..read]);
        while let Some(pos) = pending.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = pending.drain(..=pos).collect();
            if let Some(delta) = extract_delta(String::from_utf8_lossy(&line).trim()) {
                let _ = on_delta.send(delta);
            }
        }
    }
    Ok(())
}

fn extract_delta(line: &str) -> Option<String> {
    let payload = line.strip_prefix("data:")?.trim();
    if payload == "[DONE]" {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(payload).ok()?;
    let content = value.pointer("/choices/0/delta/content")?.as_str()?;
    if content.is_empty() {
        None
    } else {
        Some(content.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::extract_delta;

    #[test]
    fn delta_from_data_line() {
        let line = r#"data: {"choices":[{"delta":{"content":"안녕"}}]}"#;
        assert_eq!(extract_delta(line), Some("안녕".to_string()));
    }

    #[test]
    fn done_marker_yields_none() {
        assert_eq!(extract_delta("data: [DONE]"), None);
    }

    #[test]
    fn non_data_line_yields_none() {
        assert_eq!(extract_delta(": keep-alive"), None);
    }

    #[test]
    fn role_only_chunk_yields_none() {
        let line = r#"data: {"choices":[{"delta":{"role":"assistant"}}]}"#;
        assert_eq!(extract_delta(line), None);
    }
}
