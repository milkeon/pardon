import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

// OpenAI Chat Completion API를 호출하여 지능형 문맥 및 영한 혼용 3가지 제안을 빌드하는 헬퍼
async function callOpenAIRewriteVariants(transcript, hint) {
  const apiKey = process.env.OPENAI_API_KEY || '';
  if (!apiKey) throw new Error('서버에 OpenAI API Key 설정이 필요합니다. (.env 확인)');

  const systemContent = `화자는 한국어와 영어를 수시로 혼용하는 IT 엔지니어/개발자입니다.
브라우저 무료 STT의 한계로 인해, 전문 기술 영단어들이 무차별적으로 억지스러운 한국어 발음이나 띄어쓰기 오류로 깨져서 오인식되었을 수 있습니다.

[분석 핵심 임무]
입력된 원문에서 오인식된 단어와 군더더기를 정리하되, 원문 의미를 바꾸지 말고 자연스러운 문장으로 복원하십시오.

${hint ? `[중요 주제/용어 힌트 적용]: "${hint}"
위 힌트 주제와 부합하는 기술 용어와 문맥을 살려 복원하십시오.` : ''}

반환 양식은 아래의 3가지 대안을 지닌 엄격한 JSON 형태입니다. (키: v1, v2, v3)

- v1: 원래 문장 구조를 최대한 유지하면서 발음 오류와 오타만 최소 수정한 원문 보정
- v2: 문맥을 살려 더 자연스럽고 읽기 편하게 다시 쓴 문장
- v3: 핵심 의미까지 정리한 가장 깔끔한 최종본

설명은 절대로 덧붙이지 말고 오직 JSON(v1, v2, v3)만 리턴하십시오.`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.35,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemContent },
        { role: 'user', content: JSON.stringify({ transcript }) }
      ]
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GPT API Error: ${text}`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  const parsed = JSON.parse(content);
  const cleanFallback = String(transcript ?? '').trim();

  return [
    { id: 'possibility-1', label: '제안 1 · 원문 보정', text: parsed?.v1 || cleanFallback },
    { id: 'possibility-2', label: '제안 2 · 자연스러운 문장', text: parsed?.v2 || cleanFallback },
    { id: 'possibility-3', label: '제안 3 · 정리된 문장', text: parsed?.v3 || cleanFallback }
  ];
}

async function callOpenAISummary(transcript, selectedText, hint) {
  const apiKey = process.env.OPENAI_API_KEY || '';
  if (!apiKey) throw new Error('서버에 OpenAI API Key 설정이 필요합니다. (.env 확인)');

  const systemContent = `입력된 문장을 아래쪽에 표시할 1~2문장 요약으로 압축하십시오.
원문을 그대로 반복하지 말고, 확정된 문장의 핵심을 짧고 자연스럽게 정리하십시오.
반환 양식은 엄격한 JSON 형태입니다. (키: title, summary)
설명은 절대로 덧붙이지 말고 오직 JSON만 리턴하십시오.`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      response_format: { type: 'json_object' },
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
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GPT API Error: ${text}`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  const parsed = JSON.parse(content);

  return {
    title: parsed?.title || '확정 요약',
    summary: parsed?.summary || String(selectedText ?? '').trim()
  };
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
