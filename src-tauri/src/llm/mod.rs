use std::io::Read;
use std::sync::LazyLock;
use std::time::Duration;

use tauri::ipc::Channel;

use crate::error::AppError;

const HEADER_TIMEOUT: Duration = Duration::from_secs(120);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(1800);
const ERROR_BODY_LIMIT: u64 = 4096;
const READ_CHUNK_BYTES: usize = 8 * 1024;
const SSE_LINE_LIMIT: usize = 1024 * 1024;
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
    let mut stopped = false;
    loop {
        let read = reader
            .read(&mut chunk)
            .map_err(|e| AppError::Llm(e.to_string()))?;
        if read == 0 {
            break;
        }
        pending.extend_from_slice(&chunk[..read]);
        while let Some(pos) = pending.iter().position(|byte| *byte == b'\n') {
            if pos >= SSE_LINE_LIMIT {
                return Err(AppError::Llm("SSE line exceeds size limit".to_string()));
            }
            let line: Vec<u8> = pending.drain(..=pos).collect();
            if process_sse_line(&line, &mut on_delta, &mut stopped)? {
                return Ok(());
            }
        }
        if pending.len() > SSE_LINE_LIMIT {
            return Err(AppError::Llm("SSE line exceeds size limit".to_string()));
        }
    }
    if process_sse_line(&pending, &mut on_delta, &mut stopped)? || stopped {
        Ok(())
    } else {
        Err(AppError::Llm(
            "stream ended before [DONE] or finish_reason stop".to_string(),
        ))
    }
}

fn process_sse_line(
    line: &[u8],
    on_delta: &mut impl FnMut(String),
    stopped: &mut bool,
) -> Result<bool, AppError> {
    let line = std::str::from_utf8(line)
        .map_err(|error| AppError::Llm(format!("invalid SSE UTF-8: {error}")))?
        .trim();
    let Some(payload) = line.strip_prefix("data:").map(str::trim) else {
        return Ok(false);
    };
    if payload == "[DONE]" {
        return Ok(true);
    }
    let value: serde_json::Value = serde_json::from_str(payload)
        .map_err(|error| AppError::Llm(format!("invalid SSE JSON: {error}")))?;
    if let Some(error) = value.get("error").filter(|error| !error.is_null()) {
        return Err(AppError::Llm(format!("stream error: {error}")));
    }
    let choices = value
        .get("choices")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| AppError::Llm("invalid SSE payload: expected choices array".to_string()))?;
    let Some(choice) = choices.first() else {
        return Ok(false);
    };
    match choice.get("finish_reason") {
        None | Some(serde_json::Value::Null) => {}
        Some(serde_json::Value::String(reason)) if reason == "stop" => *stopped = true,
        Some(serde_json::Value::String(reason)) => {
            return Err(AppError::Llm(format!(
                "stream ended with finish_reason {reason}"
            )));
        }
        Some(_) => {
            return Err(AppError::Llm(
                "invalid SSE payload: expected string finish_reason".to_string(),
            ));
        }
    }
    let delta = choice
        .get("delta")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| AppError::Llm("invalid SSE payload: expected delta object".to_string()))?;
    match delta.get("content") {
        None | Some(serde_json::Value::Null) => {}
        Some(serde_json::Value::String(content)) => {
            if !content.is_empty() {
                on_delta(content.to_string());
            }
        }
        Some(_) => {
            return Err(AppError::Llm(
                "invalid SSE payload: expected string content".to_string(),
            ));
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use std::io::{self, BufRead, BufReader, Cursor, Read, Write};
    use std::net::{SocketAddr, TcpListener};
    use std::thread;
    use std::time::Duration;

    use super::{build_http_agent, process_sse_line, stream_sse_deltas};

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
    fn delta_from_data_line() -> Result<(), crate::error::AppError> {
        let line = r#"data: {"choices":[{"delta":{"content":"안녕"}}]}"#;
        let mut deltas = Vec::new();
        assert!(!process_sse_line(
            line.as_bytes(),
            &mut |delta| deltas.push(delta),
            &mut false
        )?);
        assert_eq!(deltas, vec!["안녕".to_string()]);
        Ok(())
    }

    #[test]
    fn done_marker_yields_none() -> Result<(), crate::error::AppError> {
        let mut deltas = Vec::new();
        assert!(process_sse_line(
            b"data: [DONE]",
            &mut |delta| deltas.push(delta),
            &mut false
        )?);
        assert!(deltas.is_empty());
        Ok(())
    }

    #[test]
    fn non_data_line_yields_none() -> Result<(), crate::error::AppError> {
        let mut deltas = Vec::new();
        assert!(!process_sse_line(
            b": keep-alive",
            &mut |delta| deltas.push(delta),
            &mut false
        )?);
        assert!(deltas.is_empty());
        Ok(())
    }

    #[test]
    fn role_only_chunk_yields_none() -> Result<(), crate::error::AppError> {
        let line = r#"data: {"choices":[{"delta":{"role":"assistant"}}]}"#;
        let mut deltas = Vec::new();
        assert!(!process_sse_line(
            line.as_bytes(),
            &mut |delta| deltas.push(delta),
            &mut false
        )?);
        assert!(deltas.is_empty());
        Ok(())
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
        let reader = Cursor::new(
            br#"data: {"choices":[{"delta":{"content":"last"},"finish_reason":"stop"}]}"#,
        );
        let mut deltas = Vec::new();
        stream_sse_deltas(reader, |delta| deltas.push(delta))?;
        assert_eq!(deltas, vec!["last".to_string()]);
        Ok(())
    }

    #[test]
    fn premature_eof_is_rejected() {
        for stream in [
            "",
            "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}",
        ] {
            let result = stream_sse_deltas(Cursor::new(stream), |_| {});
            assert!(matches!(result, Err(crate::error::AppError::Llm(_))));
        }
    }

    #[test]
    fn final_done_marker_without_newline_preserves_deltas() -> Result<(), crate::error::AppError> {
        let reader = FragmentedReader {
            bytes: Cursor::new(
                b"data: {\"choices\":[{\"delta\":{\"content\":\"last\"}}]}\n\ndata: [DONE]"
                    .to_vec(),
            ),
            fragment_size: 1,
            fail_at_end: false,
        };
        let mut deltas = Vec::new();
        stream_sse_deltas(reader, |delta| deltas.push(delta))?;
        assert_eq!(deltas, vec!["last".to_string()]);
        Ok(())
    }

    #[test]
    fn streaming_api_errors_preserve_server_details() {
        for payload in [
            r#"{"error":{"message":"quota exhausted","code":"insufficient_quota"}}"#,
            r#"{"error":"quota exhausted"}"#,
        ] {
            let stream = format!(
                "data: {{\"choices\":[{{\"delta\":{{\"content\":\"partial\"}}}}]}}\n\nevent: error\ndata: {payload}\n\ndata: [DONE]\n\n"
            );
            let mut deltas = Vec::new();
            let result = stream_sse_deltas(Cursor::new(stream), |delta| deltas.push(delta));
            assert!(
                matches!(result, Err(crate::error::AppError::Llm(ref detail)) if detail.contains("quota exhausted"))
            );
            assert_eq!(deltas, vec!["partial".to_string()]);
        }
    }

    #[test]
    fn malformed_stream_data_is_rejected_even_before_done() {
        for payload in [
            "{",
            "not json",
            "null",
            "{}",
            r#"{"choices":"invalid"}"#,
            r#"{"choices":[{"delta":{"content":42}}]}"#,
            r#"{"choices":[{"delta":{},"finish_reason":42}]}"#,
        ] {
            let stream = format!("data: {payload}\n\ndata: [DONE]\n\n");
            let result = stream_sse_deltas(Cursor::new(stream), |_| {});
            assert!(
                matches!(result, Err(crate::error::AppError::Llm(_))),
                "accepted malformed payload: {payload}"
            );
        }
    }

    #[test]
    fn malformed_final_data_without_newline_is_rejected() {
        let stream = concat!(
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
            "data: {"
        );
        let result = stream_sse_deltas(Cursor::new(stream), |_| {});
        assert!(matches!(result, Err(crate::error::AppError::Llm(_))));
    }

    #[test]
    fn unsuccessful_finish_reasons_are_rejected_before_emitting_content() {
        for reason in ["length", "content_filter", "tool_calls"] {
            let stream = format!(
                "data: {{\"choices\":[{{\"delta\":{{\"content\":\"partial\"}},\"finish_reason\":\"{reason}\"}}]}}\n\ndata: [DONE]\n\n"
            );
            let mut deltas = Vec::new();
            let result = stream_sse_deltas(Cursor::new(stream), |delta| deltas.push(delta));
            assert!(
                matches!(result, Err(crate::error::AppError::Llm(ref detail)) if detail.contains(reason))
            );
            assert!(deltas.is_empty());
        }
    }

    #[test]
    fn stop_allows_usage_events_before_eof() -> Result<(), crate::error::AppError> {
        let stream = concat!(
            ": keep-alive\n\n",
            "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":null}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"last\"},\"finish_reason\":\"stop\"}]}\n\n",
            "data: {\"choices\":[],\"usage\":{\"completion_tokens\":1}}\n\n"
        );
        let mut deltas = Vec::new();
        stream_sse_deltas(Cursor::new(stream), |delta| deltas.push(delta))?;
        assert_eq!(deltas, vec!["last".to_string()]);
        Ok(())
    }

    #[test]
    fn errors_after_stop_are_not_ignored() {
        let stream = concat!(
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
            "data: {\"error\":{\"message\":\"upstream failed\"}}\n\n",
            "data: [DONE]\n\n"
        );
        let result = stream_sse_deltas(Cursor::new(stream), |_| {});
        assert!(
            matches!(result, Err(crate::error::AppError::Llm(ref detail)) if detail.contains("upstream failed"))
        );
    }

    #[test]
    fn invalid_utf8_stream_data_is_rejected() {
        let stream =
            b"data: {\"choices\":[{\"delta\":{\"content\":\"\xff\"}}]}\n\ndata: [DONE]\n\n";
        let result = stream_sse_deltas(Cursor::new(stream), |_| {});
        assert!(matches!(result, Err(crate::error::AppError::Llm(_))));
    }

    #[test]
    fn oversized_sse_lines_are_rejected() {
        let stream = format!(
            "data: {{\"choices\":[{{\"delta\":{{\"content\":\"{}\"}}}}]}}\n\ndata: [DONE]\n\n",
            "x".repeat(1024 * 1024)
        );
        let result = stream_sse_deltas(Cursor::new(stream), |_| {});
        assert!(matches!(result, Err(crate::error::AppError::Llm(_))));
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
