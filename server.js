import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConfirmationSummary, buildRewriteVariants, guardRewriteVariant, normalizeWhitespace } from './src/rewrite.js';

// 외부 의존성 없이 로컬 .env 파일의 환경변수를 process.env에 주입하는 초경량 수동 로더
try {
  const envText = readFileSync('.env', 'utf8');
  for (const line of envText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [key, ...val] = trimmed.split('=');
    if (key && val.length) {
      process.env[key.trim()] = val.join('=').trim();
    }
  }
} catch {
  // .env 파일이 없으면 시스템 환경변수(Windows OS)를 그대로 활용
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = __dirname;
const port = Number(process.env.PORT || 3000);

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon']
]);

function contentTypeFor(filePath) {
  return mimeTypes.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream';
}

function resolvePath(urlPath) {
  const cleanPath = decodeURIComponent(urlPath.split('?')[0] || '/');
  const safeRelative = path
    .normalize(cleanPath)
    .replace(/^([.]{2}[\/\\])+/, '')
    .replace(/^[\/\\]+/, '');
  const resolved = path.resolve(root, safeRelative || 'index.html');
  return resolved.toLowerCase().startsWith(root.toLowerCase()) ? resolved : null;
}

async function pickAsset(urlPath) {
  const resolved = resolvePath(urlPath);
  if (!resolved) return null;

  try {
    const fileStat = await stat(resolved);
    if (fileStat.isDirectory()) {
      return path.join(resolved, 'index.html');
    }
    return resolved;
  } catch {
    if (path.extname(resolved)) {
      return null;
    }
    return path.join(root, 'index.html');
  }
}

// 순수 Node.js만으로 WebM 바이너리 파일을 FormData 규격에 맞게 빌드해 OpenAI Whisper API로 쏘는 헬퍼
async function callOpenAIWhisper(audioBuffer) {
  const apiKey = process.env.OPENAI_API_KEY || '';
  if (!apiKey) throw new Error('서버에 OpenAI API Key 설정이 필요합니다. (.env 확인)');

  const boundary = '----WebKitFormBoundaryPardonSTT' + Math.random().toString(36).substring(2);
  
  const header = 
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="recording.webm"\r\n` +
    `Content-Type: audio/webm\r\n\r\n`;
  const modelPart = 
    `\r\n--${boundary}\r\n` +
    `Content-Disposition: form-data; name="model"\r\n\r\nwhisper-1`;
  const languagePart = 
    `\r\n--${boundary}\r\n` +
    `Content-Disposition: form-data; name="language"\r\n\r\nko`;
  const promptPart = 
    `\r\n--${boundary}\r\n` +
    `Content-Disposition: form-data; name="prompt"\r\n\r\nSQLD, ADsP, 블로그, API, Git, commit, Docker, Database, 포트, 서버, 깃 커밋`;
  const footer = `\r\n--${boundary}--\r\n`;

  const multipartBody = Buffer.concat([
    Buffer.from(header),
    audioBuffer,
    Buffer.from(modelPart),
    Buffer.from(languagePart),
    Buffer.from(promptPart),
    Buffer.from(footer)
  ]);

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`
    },
    body: multipartBody
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Whisper API Error: ${text}`);
  }

  const data = await response.json();
  return data.text || '';
}

function hasOpenAIKey() {
  return Boolean(String(process.env.OPENAI_API_KEY || '').trim());
}

function cleanBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function hasLocalLlmConfig() {
  return Boolean(cleanBaseUrl(process.env.LOCAL_LLM_BASE_URL || process.env.OPENAI_BASE_URL));
}

async function requestJson(url, options = {}, timeoutMs = 4000) {
  const controller = new AbortController();
  const scheduleTimeout = globalThis.setTimeout.bind(globalThis);
  const cancelTimeout = globalThis.clearTimeout.bind(globalThis);
  const timeout = scheduleTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    cancelTimeout(timeout);
  }
}

async function discoverLocalChatProvider() {
  const explicitBaseUrl = cleanBaseUrl(process.env.LOCAL_LLM_BASE_URL || process.env.OPENAI_BASE_URL);
  const explicitModel = normalizeWhitespace(process.env.LOCAL_LLM_MODEL || process.env.OPENAI_MODEL || '');
  const candidates = explicitBaseUrl
    ? [{ baseUrl: explicitBaseUrl, model: explicitModel, label: 'explicit' }]
    : [
        { baseUrl: 'http://127.0.0.1:11434/v1', model: explicitModel, label: 'ollama' },
        { baseUrl: 'http://127.0.0.1:1234/v1', model: explicitModel, label: 'lmstudio' }
      ];

  for (const candidate of candidates) {
    const model = candidate.model || await detectLocalModel(candidate.baseUrl, candidate.label);
    if (model) return { ...candidate, model };
  }

  return null;
}

async function detectLocalModel(baseUrl, label) {
  const normalized = cleanBaseUrl(baseUrl);
  const modelList = await requestJson(`${normalized}/models`);
  const firstModel = modelList?.data?.[0]?.id || modelList?.data?.[0]?.name || modelList?.models?.[0]?.id || modelList?.models?.[0]?.name;
  if (firstModel) return String(firstModel);

  if (label === 'ollama' || normalized.includes('11434')) {
    const ollamaModels = await requestJson(`${normalized.replace(/\/v1$/, '')}/api/tags`);
    const firstOllamaModel = ollamaModels?.models?.[0]?.name;
    if (firstOllamaModel) return String(firstOllamaModel);
  }

  return '';
}

async function callChatCompletions({ baseUrl, apiKey = '', model, messages, temperature, responseFormat }) {
  const headers = {
    'Content-Type': 'application/json'
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(`${cleanBaseUrl(baseUrl)}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      temperature,
      response_format: responseFormat,
      messages
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Chat completion error: ${text}`);
  }

  const payload = await response.json();
  return payload?.choices?.[0]?.message?.content || '';
}

async function getPreferredChatProvider() {
  if (hasOpenAIKey()) {
    return {
      kind: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: process.env.OPENAI_API_KEY || '',
      model: 'gpt-4o-mini'
    };
  }

  const localProvider = await discoverLocalChatProvider();
  if (localProvider) {
    return {
      kind: 'local',
      baseUrl: localProvider.baseUrl,
      apiKey: '',
      model: localProvider.model
    };
  }

  return null;
}

// OpenAI 호환 Chat Completion API 또는 로컬 LLM 서버를 호출해 3가지 제안을 빌드하는 헬퍼
async function callOpenAIRewriteVariants(baseTranscript, evidenceTranscript, hint) {
  const cleanBase = normalizeWhitespace(baseTranscript);
  const cleanEvidence = normalizeWhitespace(evidenceTranscript);
  const cleanFallback = cleanBase || cleanEvidence;
  const provider = await getPreferredChatProvider();
  if (!provider) {
    return buildRewriteVariants(cleanFallback);
  }

  const hintBlock = hint
    ? `
[중요 주제/용어 힌트 적용]: "${hint}"
위 힌트 주제와 부합하는 기술 용어와 문맥을 살려 복원하십시오.`
    : '';
  const evidenceBlock = cleanEvidence
    ? `
보조 증거 STT(evidence)는 동일 발화의 재전사 결과입니다. evidence가 base보다 명백히 정확할 때만 반영하십시오.`
    : '';
  const systemContent = `당신은 한국어 STT 교정 보조기입니다.
화자는 한국어와 영어를 섞어 말할 수 있고, 기술 용어/고유명사/숫자/명령어가 포함될 수 있습니다.

핵심 규칙:
1. baseTranscript를 기준 원문으로 사용하십시오.
2. evidenceTranscript는 교차검증 증거로만 사용하십시오.${evidenceBlock}
3. evidenceTranscript가 더 명확한 경우에만 base를 수정하십시오.
4. 확신이 낮으면 base를 유지하십시오.
5. 원문에 없는 새 의미를 추가하지 마십시오.
6. 요약, 과도한 의역, 설명 추가를 하지 마십시오.
7. 숫자, 시간, 날짜, 파일명, 명령어, 고유명사, 영문 기술 용어는 더 확실한 쪽을 우선하되 확신이 낮으면 base를 유지하십시오.

출력 규칙:
- v1: 가장 보수적인 교정본. 원문을 최대한 유지하고 명백한 STT 오류만 바로잡으십시오.
- v2: 균형형 교정본. 원문 의미와 순서를 유지하면서 evidence가 강하게 뒷받침하는 수정만 반영하십시오.
- v3: 자연형 교정본. 의미는 유지하되 읽기만 조금 더 자연스럽게 정리하십시오.
- 세 결과는 서로 거의 같은 문장 3개가 아니라, 보정 깊이가 다른 3개여야 합니다.${hintBlock}

반환 형식은 오직 엄격한 JSON 객체 {"v1":"...","v2":"...","v3":"..."} 입니다.`;
  try {
    const content = await callChatCompletions({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: provider.model,
      temperature: 0.15,
      responseFormat: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemContent },
        { role: 'user', content: JSON.stringify({ baseTranscript: cleanBase, evidenceTranscript: cleanEvidence, hint }) }
      ]
    });

    const parsed = JSON.parse(content);
    const fallbackVariants = buildRewriteVariants(cleanFallback);
    return [
      {
        id: 'possibility-1',
        label: '제안 1 · 보수적 교정',
        text: guardRewriteVariant(cleanFallback, parsed?.v1, fallbackVariants[0]?.text || cleanFallback, 'strict')
      },
      {
        id: 'possibility-2',
        label: '제안 2 · 균형형 교정',
        text: guardRewriteVariant(cleanFallback, parsed?.v2, fallbackVariants[1]?.text || cleanFallback, 'balanced')
      },
      {
        id: 'possibility-3',
        label: '제안 3 · 자연형 교정',
        text: guardRewriteVariant(cleanFallback, parsed?.v3, fallbackVariants[2]?.text || cleanFallback, 'relaxed')
      }
    ];
  } catch (error) {
    console.error('LLM 제안 생성 실패, 로컬 결정적 폴백 사용:', error);
    return buildRewriteVariants(cleanFallback);
  }
}

async function callOpenAISummary(transcript, selectedText, hint) {
  const cleanSelected = normalizeWhitespace(selectedText || transcript);
  const provider = await getPreferredChatProvider();
  if (!provider) {
    return {
      title: '확정 요약',
      summary: buildConfirmationSummary(cleanSelected, transcript)
    };
  }

  const systemContent = `입력 JSON의 selectedText를 아래쪽에 표시할 1~2문장 요약으로 압축하십시오.
transcript는 의미 보존을 위한 참고 문맥일 뿐이며, 최종 요약은 selectedText보다 짧아야 합니다.
원문을 그대로 반복하지 말고, 확정된 문장의 핵심만 아주 짧고 자연스럽게 정리하십시오.
반환 양식은 엄격한 JSON 형태입니다. (키: title, summary)
설명은 절대로 덧붙이지 말고 오직 JSON만 리턴하십시오.`;

  try {
    const content = await callChatCompletions({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: provider.model,
      temperature: 0.2,
      responseFormat: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: systemContent
        },
        {
          role: 'user',
          content: JSON.stringify({ transcript, selectedText, hint })
        }
      ]
    });

    const parsed = JSON.parse(content);
    return {
      title: parsed?.title || '확정 요약',
      summary: parsed?.summary || cleanSelected
    };
  } catch (error) {
    console.error('LLM 요약 생성 실패, 로컬 결정적 폴백 사용:', error);
    return {
      title: '확정 요약',
      summary: buildConfirmationSummary(cleanSelected, transcript)
    };
  }
}

const server = http.createServer(async (req, res) => {
  try {
    // 1. Whisper STT 분석 API 엔드포인트
    if (req.url === '/api/transcribe' && req.method === 'POST') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', async () => {
        try {
          const audioBuffer = Buffer.concat(chunks);
          const whisperText = await callOpenAIWhisper(audioBuffer);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ text: whisperText }));
        } catch (err) {
          console.error('Whisper API 프록시 오류:', err);
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(err.message || 'Whisper Proxy Error');
        }
      });
      return;
    }

    // 2. GPT 문맥 해석 API 엔드포인트
    if (req.url === '/api/analyze' && req.method === 'POST') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', async () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          const { baseTranscript, evidenceTranscript, hint } = JSON.parse(body);
          const variants = await callOpenAIRewriteVariants(baseTranscript, evidenceTranscript, hint);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(variants));
        } catch (err) {
          console.error('GPT API 프록시 오류:', err);
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(err.message || 'GPT Proxy Error');
        }
      });
      return;
    }

    if (req.url === '/api/summary' && req.method === 'POST') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', async () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          const { transcript, selectedText, hint } = JSON.parse(body);
          const summary = await callOpenAISummary(transcript, selectedText, hint);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(summary));
        } catch (err) {
          console.error('GPT 요약 API 프록시 오류:', err);
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(err.message || 'GPT Summary Proxy Error');
        }
      });
      return;
    }

    // 3. 기존 정적 에셋 서빙
    const target = await pickAsset(req.url || '/');

    if (!target) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    const data = await readFile(target);
    res.writeHead(200, { 'Content-Type': contentTypeFor(target), 'Cache-Control': 'no-store' });
    res.end(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Server error: ${message}`);
  }
});

server.listen(port, () => {
  console.log(`Pardon is serving on http://localhost:${port}`);
});
