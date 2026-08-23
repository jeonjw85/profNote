import type { SummaryLanguage } from "../types";

const KO_OUTPUT_FORMAT =
  "출력 형식: '## 핵심 요약' (3~5문장), '## 주요 내용' (계층 불릿), '## 핵심 용어' (용어/정의 표), 필요 시 '## 과제 및 참고 사항'.";

const EN_OUTPUT_FORMAT =
  "Output format: '## Summary' (3–5 sentences), '## Key Points' (hierarchical bullets), '## Key Terms' (term/definition table), and '## Assignments & References' when needed.";

const AUTO_OUTPUT_FORMAT =
  "Use section headers in the same language as the transcript. Korean: '## 핵심 요약' (3–5 sentences), '## 주요 내용' (hierarchical bullets), '## 핵심 용어' (term/definition table), optional '## 과제 및 참고 사항'. English: '## Summary' (3–5 sentences), '## Key Points' (hierarchical bullets), '## Key Terms' (term/definition table), optional '## Assignments & References'.";

function assertNever(value: never): never {
  throw new Error(`unexpected value: ${JSON.stringify(value)}`);
}

export function systemPrompt(language: SummaryLanguage): string {
  switch (language) {
    case "ko":
      return [
        "당신은 강의 녹음 전사록을 정리하는 어시스턴트입니다.",
        "입력된 전사록을 읽고 한국어 Markdown 강의 노트로 요약하세요.",
        KO_OUTPUT_FORMAT,
        "전사록에 없는 내용은 지어내지 마세요. Markdown 본문만 출력하세요.",
      ].join(" ");
    case "en":
      return [
        "You are an assistant that organizes lecture transcripts.",
        "Summarize the transcript into an English Markdown lecture note.",
        EN_OUTPUT_FORMAT,
        "Do not fabricate content that is not in the transcript. Output Markdown body only.",
      ].join(" ");
    case "auto":
      return [
        "You are an assistant that organizes lecture transcripts.",
        "Write the Markdown lecture note in the SAME language as the transcript text itself.",
        "Section headers must also be in that language.",
        AUTO_OUTPUT_FORMAT,
        "Do not fabricate content that is not in the transcript. Output Markdown body only.",
      ].join(" ");
    default:
      return assertNever(language);
  }
}

export function chunkSystemPrompt(language: SummaryLanguage): string {
  switch (language) {
    case "ko":
      return [
        "당신은 강의 녹음 전사록을 정리하는 어시스턴트입니다.",
        "입력된 전사록 일부를 읽고 한국어 Markdown으로 상세히 요약하세요.",
        "핵심 내용, 용어와 정의, 과제 및 공지 사항을 빠짐없이 담으세요.",
        "전사록에 없는 내용은 지어내지 마세요. Markdown 본문만 출력하세요.",
      ].join(" ");
    case "en":
      return [
        "You are an assistant that organizes lecture transcripts.",
        "Read this transcript excerpt and summarize it in detail as English Markdown.",
        "Include every key point, term and definition, and any assignments or announcements.",
        "Do not fabricate content that is not in the transcript. Output Markdown body only.",
      ].join(" ");
    case "auto":
      return [
        "You are an assistant that organizes lecture transcripts.",
        "Read this transcript excerpt and summarize it in detail as Markdown in the SAME language as the transcript text itself.",
        "Include every key point, term and definition, and any assignments or announcements.",
        "Do not fabricate content that is not in the transcript. Output Markdown body only.",
      ].join(" ");
    default:
      return assertNever(language);
  }
}

export function combineSystemPrompt(language: SummaryLanguage): string {
  switch (language) {
    case "ko":
      return [
        "당신은 강의 녹음 전사록을 정리하는 어시스턴트입니다.",
        "입력된 부분 요약들을 강의 순서대로 합쳐 하나의 한국어 Markdown 강의 노트로 정리하세요.",
        KO_OUTPUT_FORMAT,
        "입력에 없는 내용은 지어내지 마세요. 중복을 제거하고 Markdown 본문만 출력하세요.",
      ].join(" ");
    case "en":
      return [
        "You are an assistant that organizes lecture transcripts.",
        "Merge the partial summaries in lecture order into a single English Markdown lecture note.",
        EN_OUTPUT_FORMAT,
        "Do not fabricate content that is not in the input. Remove duplicates and output Markdown body only.",
      ].join(" ");
    case "auto":
      return [
        "You are an assistant that organizes lecture transcripts.",
        "Merge the partial summaries in lecture order into a single Markdown lecture note written in the SAME language as the transcript.",
        AUTO_OUTPUT_FORMAT,
        "Do not fabricate content that is not in the input. Remove duplicates and output Markdown body only.",
      ].join(" ");
    default:
      return assertNever(language);
  }
}

export function truncationMarker(language: SummaryLanguage): string {
  switch (language) {
    case "ko":
      return "[이하 생략]";
    case "en":
    case "auto":
      return "[truncated]";
    default:
      return assertNever(language);
  }
}

export function chunkUserContent(
  language: SummaryLanguage,
  index: number,
  total: number,
  chunk: string
): string {
  switch (language) {
    case "ko":
      return `전사록 일부 ${index}/${total}:\n\n${chunk}`;
    case "en":
    case "auto":
      return `Transcript part ${index}/${total}:\n\n${chunk}`;
    default:
      return assertNever(language);
  }
}

export function combinePartHeading(language: SummaryLanguage, index: number): string {
  switch (language) {
    case "ko":
      return `## 부분 요약 ${index}`;
    case "en":
    case "auto":
      return `## Partial summary ${index}`;
    default:
      return assertNever(language);
  }
}
