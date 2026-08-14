import { Channel, invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import { toMessage } from "./errors";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o";
const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 1000;
const MAX_TRANSCRIPT_CHARS = 360_000;
const CHUNK_CHARS = 30_000;

const OUTPUT_FORMAT =
  "출력 형식: '## 핵심 요약' (3~5문장), '## 주요 내용' (계층 불릿), '## 핵심 용어' (용어/정의 표), 필요 시 '## 과제 및 참고 사항'.";

const SYSTEM_PROMPT = [
  "당신은 강의 녹음 전사록을 정리하는 어시스턴트입니다.",
  "입력된 전사록을 읽고 한국어 Markdown 강의 노트로 요약하세요.",
  OUTPUT_FORMAT,
  "전사록에 없는 내용은 지어내지 마세요. Markdown 본문만 출력하세요.",
].join(" ");

const CHUNK_SYSTEM_PROMPT = [
  "당신은 강의 녹음 전사록을 정리하는 어시스턴트입니다.",
  "입력된 전사록 일부를 읽고 한국어 Markdown으로 상세히 요약하세요.",
  "핵심 내용, 용어와 정의, 과제 및 공지 사항을 빠짐없이 담으세요.",
  "전사록에 없는 내용은 지어내지 마세요. Markdown 본문만 출력하세요.",
].join(" ");

const COMBINE_SYSTEM_PROMPT = [
  "당신은 강의 녹음 전사록을 정리하는 어시스턴트입니다.",
  "입력된 부분 요약들을 강의 순서대로 합쳐 하나의 한국어 Markdown 강의 노트로 정리하세요.",
  OUTPUT_FORMAT,
  "입력에 없는 내용은 지어내지 마세요. 중복을 제거하고 Markdown 본문만 출력하세요.",
].join(" ");

export class ApiError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "ApiError";
    this.retryable = retryable;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface LlmEndpoint {
  baseUrl: string;
  model: string;
}

function buildEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  const base = trimmed.length > 0 ? trimmed : DEFAULT_BASE_URL;
  if (base.endsWith("/chat/completions")) {
    return base;
  }
  return `${base}/chat/completions`;
}

function splitTranscript(transcript: string): string[] {
  const chunks: string[] = [];
  let remaining = transcript;
  while (remaining.length > CHUNK_CHARS) {
    let cut = remaining.lastIndexOf("\n", CHUNK_CHARS);
    if (cut <= 0) {
      cut = CHUNK_CHARS;
    }
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining.trim().length > 0) {
    chunks.push(remaining);
  }
  return chunks;
}

async function withRetry<T>(request: () => Promise<T>): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      const backoff =
        BASE_DELAY_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 300);
      await delay(backoff);
    }
    try {
      return await request();
    } catch (error) {
      lastError = error;
      if (error instanceof ApiError && !error.retryable) {
        throw error;
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new ApiError("요약 생성에 실패했습니다", false);
}

export async function summarizeTranscript(
  apiKey: string,
  endpoint: LlmEndpoint,
  transcript: string,
  onProgress?: (receivedChars: number) => void
): Promise<string> {
  const trimmed =
    transcript.length > MAX_TRANSCRIPT_CHARS
      ? `${transcript.slice(0, MAX_TRANSCRIPT_CHARS)}\n[이하 생략]`
      : transcript;
  const url = buildEndpoint(endpoint.baseUrl);
  const model = endpoint.model.trim() || DEFAULT_MODEL;
  const chunks = splitTranscript(trimmed);
  if (chunks.length <= 1) {
    return withRetry(() =>
      requestChat(apiKey, url, model, SYSTEM_PROMPT, trimmed, onProgress)
    );
  }
  let received = 0;
  const parts: string[] = [];
  for (const [index, chunk] of chunks.entries()) {
    const part = await withRetry(() =>
      requestChat(
        apiKey,
        url,
        model,
        CHUNK_SYSTEM_PROMPT,
        `전사록 일부 ${index + 1}/${chunks.length}:\n\n${chunk}`,
        (chars) => onProgress?.(received + chars)
      )
    );
    received += part.length;
    parts.push(part);
    onProgress?.(received);
  }
  const combinedInput = parts
    .map((part, index) => `## 부분 요약 ${index + 1}\n\n${part}`)
    .join("\n\n");
  return withRetry(() =>
    requestChat(
      apiKey,
      url,
      model,
      COMBINE_SYSTEM_PROMPT,
      combinedInput,
      (chars) => onProgress?.(received + chars)
    )
  );
}

async function requestChat(
  apiKey: string,
  url: string,
  model: string,
  systemPrompt: string,
  userContent: string,
  onProgress?: (receivedChars: number) => void
): Promise<string> {
  let content = "";
  const channel = new Channel<unknown>();
  channel.onmessage = (message) => {
    content += z.string().parse(message);
    onProgress?.(content.length);
  };
  try {
    await invoke("stream_llm_chat", {
      url,
      apiKey,
      model,
      systemPrompt,
      userContent,
      onDelta: channel,
    });
  } catch (error) {
    throw toApiError(toMessage(error));
  }
  if (content.trim().length === 0) {
    throw new ApiError("요약 응답이 비어 있습니다", true);
  }
  return content;
}

function toApiError(raw: string): ApiError {
  const match = /HTTP (\d{3})/.exec(raw);
  if (!match) {
    if (/timeout/i.test(raw)) {
      return new ApiError("요약 응답이 지연되어 시간이 초과되었습니다", true);
    }
    return new ApiError(`네트워크 오류: ${raw}`, true);
  }
  const status = Number(match[1]);
  const detail = raw
    .slice(match.index + match[0].length)
    .replace(/^:\s*/, "")
    .trim();
  const suffix = detail.length > 0 ? ` (${detail})` : "";
  if (status === 401 || status === 403) {
    return new ApiError(
      `API 키 인증에 실패했습니다 (HTTP ${status})${suffix} — 설정에서 키를 확인하세요`,
      false
    );
  }
  if (status === 429) {
    return new ApiError(`요약 요청 한도 초과 (HTTP 429)${suffix}`, true);
  }
  if (status >= 500) {
    return new ApiError(`요약 서버 오류 (HTTP ${status})${suffix}`, true);
  }
  return new ApiError(`요약 API 오류 (HTTP ${status})${suffix}`, false);
}
