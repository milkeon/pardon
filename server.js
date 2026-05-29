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

function hasOpenAIKey() {
  return Boolean(String(process.env.OPENAI_API_KEY || '').trim());
}

function cleanBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function hasLocalLlmConfig() {
  return Boolean(cleanBaseUrl(process.env.LOCAL_LLM_BASE_URL || process.env.OPENAI_BASE_URL));
}

function shouldPreferLocalLlm() {
  const value = String(process.env.PREFER_LOCAL_LLM || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || hasLocalLlmConfig();
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
  if (shouldPreferLocalLlm()) {
    const localProvider = await discoverLocalChatProvider();
    if (localProvider) {
      return {
        kind: 'local',
        baseUrl: localProvider.baseUrl,
        apiKey: '',
        model: localProvider.model
      };
    }
  }

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
  const systemContent = `당신은 한국어 STT 후처리 전문가가 아니라, 한국어 음성 기록의 문맥 복원(Context Restoration) 전문가입니다.
화자는 한국어와 영어를 섞어 말할 수 있고, 기술 용어/고유명사/숫자/명령어가 포함될 수 있습니다.
임무는 baseTranscript를 사람이 실제로 말했을 법한 문장으로 최소 수정 복원하는 것입니다.

핵심 규칙:
1. baseTranscript를 기준 원문으로 사용하십시오.
2. evidenceTranscript는 교차검증 증거로만 사용하십시오.${evidenceBlock}
3. 발화자의 의도, 정보, 순서를 유지하십시오.
4. 문맥상 말이 안 되는 단어는 가장 가능성 높은 단어로만 교체하십시오. 예: 힘 단위→팀 단위, 메론가요→뭔가요.
5. 수정된 부분은 최소화하십시오. 문장을 새로 쓰지 말고 원문을 복원하십시오.
6. 확신이 낮으면 base를 유지하십시오.
7. 원문에 없는 새 의미, 새 주장, 새 예시를 추가하지 마십시오.
8. 숫자, 시간, 날짜, 파일명, 명령어, 고유명사, 영문 기술 용어는 더 확실한 쪽을 우선하되 확신이 낮으면 base를 유지하십시오.
9. 맞춤법, 띄어쓰기, 조사, 어색한 반복은 고치되, 요약하거나 설명으로 바꾸지 마십시오.
10. 특히 기술/협업 문맥에서는 의미적으로 자연한 표현을 우선하십시오. 예: 팀 단위, 세션 기반, POST 라우터.${hintBlock}
11. 긍정/부정, 원인/결과, 주어/대상 관계를 바꾸지 마십시오. 예: 외롭지 않다를 외로워진다로 바꾸지 마십시오.

출력 규칙:
- 단 하나의 복원 결과만 만드십시오.
- 반환 형식은 오직 엄격한 JSON 객체 {"restored":"..."} 입니다.
- JSON 바깥의 설명, 코드블록, 머리말은 절대 출력하지 마십시오.`;
  try {
    const content = await callChatCompletions({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: provider.model,
      temperature: 0.05,
      responseFormat: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemContent },
        { role: 'user', content: JSON.stringify({ baseTranscript: cleanBase, evidenceTranscript: cleanEvidence, hint }) }
      ]
    });

    const parsed = JSON.parse(content);
    const fallbackVariants = buildRewriteVariants(cleanFallback);
    const restoredCandidate = normalizeWhitespace(
      parsed?.restored || parsed?.answer || parsed?.text || parsed?.content || parsed?.v2 || parsed?.v1 || parsed?.v3 || ''
    );
    const restored = guardRewriteVariant(cleanFallback, restoredCandidate, fallbackVariants[1]?.text || cleanFallback, 'balanced');
    const polishedFallback = buildRewriteVariants(restored);
    return [
      {
        id: 'possibility-1',
        label: '제안 1 · 보수적 교정',
        text: guardRewriteVariant(cleanFallback, restoredCandidate, fallbackVariants[0]?.text || cleanFallback, 'strict')
      },
      {
        id: 'possibility-2',
        label: '제안 2 · 문맥 복원',
        text: restored
      },
      {
        id: 'possibility-3',
        label: '제안 3 · 자연형 정리',
        text: guardRewriteVariant(restored, polishedFallback[2]?.text || restored, restored, 'balanced')
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
    // 1. GPT 문맥 해석 API 엔드포인트
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

    // 2. 기존 정적 에셋 서빙
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
