use std::io::Read;
use std::sync::LazyLock;
use std::time::Duration;

use tauri::ipc::Channel;

use crate::error::AppError;

const HEADER_TIMEOUT: Duration = Duration::from_secs(120);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(1800);
const ERROR_BODY_LIMIT: u64 = 4096;
const READ_CHUNK_BYTES: usize = 8 * 1024;
static HTTP_AGENT: LazyLock<ureq::Agent> =
    LazyLock::new(|| build_http_agent(HEADER_TIMEOUT, TOTAL_TIMEOUT));

fn build_http_agent(response_timeout: Duration, total_timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_recv_response(Some(response_timeout))
        .timeout_recv_body(Some(total_timeout))
        .timeout_global(Some(total_timeout))
        .build()
        .into()
}

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

    let request = HTTP_AGENT.post(url);
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
        return Err(AppError::Llm(format!("HTTP {}: {detail}", status.as_u16())));
    }

    stream_sse_deltas(response.into_body().into_reader(), |delta| {
        let _ = on_delta.send(delta);
    })
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

fn stream_sse_deltas<R: Read>(
    mut reader: R,
    mut on_delta: impl FnMut(String),
) -> Result<(), AppError> {
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
            let line = String::from_utf8_lossy(&line);
            let line = line.trim();
            if line
                .strip_prefix("data:")
                .is_some_and(|payload| payload.trim() == "[DONE]")
            {
                return Ok(());
            }
            if let Some(delta) = extract_delta(line) {
                on_delta(delta);
            }
        }
    }
    if let Some(delta) = extract_delta(String::from_utf8_lossy(&pending).trim()) {
        on_delta(delta);
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
    use std::io::{self, BufRead, BufReader, Cursor, Read, Write};
    use std::net::{SocketAddr, TcpListener};
    use std::thread;
    use std::time::Duration;

    use super::{build_http_agent, extract_delta, stream_sse_deltas};

    struct FragmentedReader {
        bytes: Cursor<Vec<u8>>,
        fragment_size: usize,
        fail_at_end: bool,
    }

    impl Read for FragmentedReader {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            if self.fail_at_end && self.bytes.position() as usize == self.bytes.get_ref().len() {
                return Err(io::Error::other("stream should have stopped at done"));
            }
            let read_size = self.fragment_size.min(buffer.len());
            self.bytes.read(&mut buffer[..read_size])
        }
    }

    struct DelayedBodyServer {
        address: SocketAddr,
        task: thread::JoinHandle<io::Result<()>>,
    }

    fn delayed_body_server(delay: Duration) -> io::Result<DelayedBodyServer> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        let address = listener.local_addr()?;
        let task = thread::spawn(move || -> io::Result<()> {
            let (mut stream, _) = listener.accept()?;
            {
                let mut request = BufReader::new(&mut stream);
                let mut line = String::new();
                loop {
                    line.clear();
                    if request.read_line(&mut line)? == 0 || line == "\r\n" {
                        break;
                    }
                }
            }
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\na")?;
            thread::sleep(delay);
            stream.write_all(b"b")?;
            Ok(())
        });
        Ok(DelayedBodyServer { address, task })
    }

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

    #[test]
    fn fragmented_utf8_deltas_remain_in_order() -> Result<(), crate::error::AppError> {
        let reader = FragmentedReader {
            bytes: Cursor::new(
                concat!(
                    "data: {\"choices\":[{\"delta\":{\"content\":\"안녕\"}}]}\r\n\r\n",
                    "data: {\"choices\":[{\"delta\":{\"content\":\" 세계\"}}]}\n\n",
                    "data: [DONE]\n\n"
                )
                .as_bytes()
                .to_vec(),
            ),
            fragment_size: 1,
            fail_at_end: false,
        };
        let mut deltas = Vec::new();
        stream_sse_deltas(reader, |delta| deltas.push(delta))?;
        assert_eq!(deltas, vec!["안녕".to_string(), " 세계".to_string()]);
        Ok(())
    }

    #[test]
    fn done_marker_finishes_without_waiting_for_connection_close()
    -> Result<(), crate::error::AppError> {
        let reader = FragmentedReader {
            bytes: Cursor::new(b"data: [DONE]\n\n".to_vec()),
            fragment_size: 2,
            fail_at_end: true,
        };
        let mut deltas = Vec::new();
        stream_sse_deltas(reader, |delta| deltas.push(delta))?;
        assert!(deltas.is_empty());
        Ok(())
    }

    #[test]
    fn final_delta_without_newline_is_preserved() -> Result<(), crate::error::AppError> {
        let reader = Cursor::new(br#"data: {"choices":[{"delta":{"content":"last"}}]}"#);
        let mut deltas = Vec::new();
        stream_sse_deltas(reader, |delta| deltas.push(delta))?;
        assert_eq!(deltas, vec!["last".to_string()]);
        Ok(())
    }

    #[test]
    fn header_timeout_does_not_interrupt_an_active_stream() -> Result<(), crate::error::AppError> {
        let server = delayed_body_server(Duration::from_millis(350))?;
        let agent = build_http_agent(Duration::from_millis(150), Duration::from_secs(3));
        let response = agent.get(format!("http://{}/", server.address)).call();
        let body = response.and_then(|response| {
            let mut body = String::new();
            response
                .into_body()
                .into_reader()
                .read_to_string(&mut body)?;
            Ok(body)
        });
        server
            .task
            .join()
            .map_err(|_| crate::error::AppError::Llm("test server thread failed".to_string()))??;
        let body = body.map_err(|error| crate::error::AppError::Llm(error.to_string()))?;
        assert_eq!(body, "ab");
        Ok(())
    }

    #[test]
    fn total_timeout_still_limits_a_slow_stream() -> Result<(), crate::error::AppError> {
        let server = delayed_body_server(Duration::from_millis(350))?;
        let agent = build_http_agent(Duration::from_secs(1), Duration::from_millis(150));
        let mut response = agent
            .get(format!("http://{}/", server.address))
            .call()
            .map_err(|error| crate::error::AppError::Llm(error.to_string()))?;
        let mut body = String::new();
        let result = response.body_mut().as_reader().read_to_string(&mut body);
        server
            .task
            .join()
            .map_err(|_| crate::error::AppError::Llm("test server thread failed".to_string()))??;
        let error = result.err().ok_or_else(|| {
            crate::error::AppError::Llm("stream should have timed out".to_string())
        })?;
        assert!(error.to_string().contains("timeout"));
        assert_eq!(body, "a");
        Ok(())
    }
}
