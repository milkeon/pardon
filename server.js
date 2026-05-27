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

// OpenAI Chat Completion API를 호출하여 지능형 문맥 및 영한 혼용 3가지 가능성을 빌드하는 헬퍼
async function callOpenAIGPT(transcript, hint) {
  const apiKey = process.env.OPENAI_API_KEY || '';
  if (!apiKey) throw new Error('서버에 OpenAI API Key 설정이 필요합니다. (.env 확인)');

  const systemContent = `화자는 한국어와 영어를 수시로 혼용하여 사용하는 IT 엔지니어/개발자입니다.
브라우저 머신러닝의 한계로 인해, 영어를 강제로 억지 한글 발음으로 받아썼거나(예: "에이피아이", "커밋해줘", "도커") 발음이 심하게 꼬여 오인식되었을 확률이 매우 높습니다.

${hint ? `[중요] 현재 발화의 구체적인 주제 및 용어 힌트는 다음과 같습니다: "${hint}"
이 힌트에 직결된 기술 전문 영어 용어(예: SQLD, Docker, API, Git, DB 등) 및 맥락을 적극 수렴하여 발음을 유연하게 복원하고 분석을 특정하십시오.` : ''}

해당 발음이 본래 무엇을 의미하려 한 것인지 유연하게 유추하여, 영어와 한글이 올바르게 혼용된 고도로 자연스러운 실무 개발자 문장 3가지 가능성을 엄격한 JSON 형태로 추정 반환하십시오.

- p1 (가능성 1: 가장 유력): 원래의 문장 형태나 어순을 훼손하지 않는 한도 내에서, 화자의 힌트와 영한 혼용 단어들을 90% 이상 가장 정직하게 복원해 낸 문장
- p2 (가능성 2: 유사 발음 교정): 꼬여서 들어온 억지 한글 발음을 힌트 주제의 단어 소리(음성학적 유사성)에 극단적으로 포커스를 맞춰 영어 믹스형으로 교정한 문장
- p3 (가능성 3: 구어 정돈 보정): 횡설수설하거나 구어로 꼬인 표현을 힌트의 주제에 입각하여 한층 일목요연하고 매끄러운 완성도 높은 실무 개발 구어로 요약 정돈한 문장

키는 p1, p2, p3만 사용하고, 설명은 절대로 덧붙이지 마세요.`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: systemContent
        },
        {
          role: 'user',
          content: JSON.stringify({ transcript })
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

  // 로컬 폴백 텍스트 (API 오류 등으로 대처가 필요할 시 사용)
  const cleanFallback = String(transcript ?? '').trim();

  return [
    { id: 'p1', label: '가능성 1 (가장 유력)', text: parsed?.p1 || cleanFallback },
    { id: 'p2', label: '가능성 2 (유사 발음 교정)', text: parsed?.p2 || cleanFallback },
    { id: 'p3', label: '가능성 3 (구어 정돈 보정)', text: parsed?.p3 || cleanFallback }
  ];
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
          const variants = await callOpenAIGPT(transcript, hint);
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
