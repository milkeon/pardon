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
async function callOpenAIRewriteVariants(transcript, hint) {
  const cleanFallback = normalizeWhitespace(transcript);
  const provider = await getPreferredChatProvider();
  if (!provider) {
    return buildRewriteVariants(cleanFallback);
  }

  const hintBlock = hint
    ? `
[중요 주제/용어 힌트 적용]: "${hint}"
위 힌트 주제와 부합하는 기술 용어와 문맥을 살려 복원하십시오.`
    : '';
  const systemContent = `화자는 한국어와 영어를 수시로 혼용하는 IT 엔지니어/개발자입니다.
브라우저 무료 STT의 한계로 인해, 전문 기술 영단어들이 무차별적으로 억지스러운 한국어 발음이나 띄어쓰기 오류로 깨져서 오인식되었을 수 있습니다.

1단계는 STT 오인식 단어를 문맥에 맞는 실제 의도어로 교정하는 것입니다.
불확실한 단어는 추측하지 말고 원문을 유지하십시오. 문맥 밖 명사나 과한 설명을 새로 만들지 마십시오.
예를 들어 "리사이젝트"처럼 발음이 깨진 단어는 "리다이렉트" 같은 실제 용어로 복원할 수 있지만, 확실하지 않으면 그대로 두십시오.
2단계에서만 문장을 더 자연스럽게 정리하십시오. 의미를 새로 만들거나 요약하지 말고, 원문의 뜻과 순서를 최대한 유지하십시오.

중요:
- v1은 가장 원문에 가까운 오인식 보정본이어야 합니다.
- v2는 문맥을 살리되 원문 의미를 유지한 균형본이어야 합니다.
- v3는 읽기 편하게 정리할 수 있지만, 원문과 무관한 내용을 만들면 안 됩니다.
- 세 결과는 서로 거의 같은 문장 3개가 아니라, 보정 깊이가 다른 3개여야 합니다.${hintBlock}

반환 양식은 아래의 3가지 대안을 지닌 엄격한 JSON 형태입니다. (키: v1, v2, v3)

- v1: 오인식된 단어를 먼저 교정한 보정본
- v2: 문맥을 살려 더 자연스럽고 읽기 편하게 다시 쓴 문장
- v3: 핵심 의미까지 정리한 가장 매끄러운 최종본

설명은 절대로 덧붙이지 말고 오직 JSON(v1, v2, v3)만 리턴하십시오.`;
  try {
    const content = await callChatCompletions({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: provider.model,
      temperature: 0.15,
      responseFormat: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemContent },
        { role: 'user', content: JSON.stringify({ transcript }) }
      ]
    });

    const parsed = JSON.parse(content);
    const fallbackVariants = buildRewriteVariants(cleanFallback);
    return [
      {
        id: 'possibility-1',
        label: '제안 1 · 오인식 보정',
        text: guardRewriteVariant(cleanFallback, parsed?.v1, fallbackVariants[0]?.text || cleanFallback, 'strict')
      },
      {
        id: 'possibility-2',
        label: '제안 2 · 문맥 교정',
        text: guardRewriteVariant(cleanFallback, parsed?.v2, fallbackVariants[1]?.text || cleanFallback, 'balanced')
      },
      {
        id: 'possibility-3',
        label: '제안 3 · 매끄러운 문장',
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

  const systemContent = `입력된 문장을 아래쪽에 표시할 1~2문장 요약으로 압축하십시오.
원문을 그대로 반복하지 말고, 확정된 문장의 핵심을 짧고 자연스럽게 정리하십시오.
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
          const { transcript, hint } = JSON.parse(body);
          const variants = await callOpenAIRewriteVariants(transcript, hint);
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
