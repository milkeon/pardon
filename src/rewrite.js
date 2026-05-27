// 억지 한글화되어 들어온 STT 발음들을 개발자 실무 영어 단어로 변환해주는 스마트 치환 매핑 사전
const EN_KO_MAP = [
  [/에이피아이/gi, 'API'],
  [/깃\s*커밋/gi, 'Git commit'],
  [/커밋/gi, 'commit'],
  [/기세\s*커밋/gi, 'Git에 commit'],
  [/깃/gi, 'Git'],
  [/서버/gi, 'Server'],
  [/포트/gi, 'Port'],
  [/빌드/gi, 'Build'],
  [/머신\s*러닝/gi, 'Machine Learning'],
  [/머신러닝/gi, 'Machine Learning'],
  [/디비/gi, 'DB'],
  [/데이터\s*베이스/gi, 'Database'],
  [/데이터베이스/gi, 'Database'],
  [/코드/gi, 'Code'],
  [/테스트/gi, 'Test'],
  [/프로세스/gi, 'Process'],
  [/에러/gi, 'Error'],
  [/로그/gi, 'Log'],
  [/오디오/gi, 'Audio'],
  [/마이크/gi, 'Mic'],
  [/도커/gi, 'Docker'],
  [/컨테이너/gi, 'Container'],
  [/브랜치/gi, 'Branch'],
  [/머지/gi, 'Merge'],
  [/풀\s*리퀘/gi, 'PR (Pull Request)'],
  [/풀리퀘/gi, 'PR (Pull Request)']
];

const TRANSFORMERS = [
  {
    id: 'p1',
    label: '가능성 1 (가장 유력)',
    build: ({ text }) => {
      // 1. 말더듬 제거 + 한영 보정이 완료된 가장 깔끔한 표준 복원
      return applyEnglishCorrection(simplifyText(text));
    }
  },
  {
    id: 'p2',
    label: '가능성 2 (유사 발음 교정)',
    build: ({ text }) => {
      // 2. 혹시 일반적인 단어로 혼동되었을 가능성까지 감안한 대체어 및 발음 정돈 대안
      return phoneticAlternative(simplifyText(text));
    }
  },
  {
    id: 'p3',
    label: '가능성 3 (구어 정돈 보정)',
    build: ({ text }) => {
      // 3. 구어체 발음을 격식 있는 실무 대화체/구문체 문맥으로 자연스럽게 풀어 쓴 자연어 해석
      return professionalPolishing(applyEnglishCorrection(simplifyText(text)));
    }
  }
];

export function normalizeWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function applyEnglishCorrection(text) {
  let base = String(text ?? '');
  // 사전을 순회하며 오역된 한글 발음들을 영문 알파벳/혼용 단어로 세련되게 치환
  for (const [regex, replacement] of EN_KO_MAP) {
    base = base.replace(regex, replacement);
  }
  return base;
}

export function buildRewriteVariants(text) {
  const cleanedText = text ? text.trim() : '';

  if (!cleanedText) {
    return TRANSFORMERS.map((variant) => ({
      id: variant.id,
      label: variant.label,
      text: '텍스트가 들어오면 세 가지 해석 가능성 대안이 표시됩니다.'
    }));
  }

  return TRANSFORMERS.map((variant) => ({
    id: variant.id,
    label: variant.label,
    text: finalizeVariantText(
      variant.build({ text: cleanedText })
    )
  }));
}

function simplifyText(text) {
  // 음성 인식 중 흔한 불필요한 아, 음, 어 등 말더듬성 추임새 일괄 제거
  const withoutFillers = String(text ?? '')
    .replace(/\b(아|음|어|그|저|습|읍|엄|actually|basically)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return withoutFillers || String(text ?? '').trim();
}

function phoneticAlternative(text) {
  const corrected = applyEnglishCorrection(text);
  // 발음 상 다르게 해석되었을 여지(예: 깃 -> 깃허브 확장 표기 등)를 제공
  return corrected
    .replace(/\bGit\b/g, 'GitHub')
    .replace(/\bAPI\b/g, 'API endpoint')
    .replace(/\bServer\b/g, 'Back-end server');
}

function professionalPolishing(text) {
  let base = String(text ?? '');
  // 격식 있게 정돈된 형태의 어조 보완
  if (!base.endsWith('.') && !base.endsWith('?') && !base.endsWith('!')) {
    base = `${base}.`;
  }
  return base;
}

function finalizeVariantText(value) {
  return String(value ?? '')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}
