# Pardon

Pardon은 브라우저에서 오디오를 녹음하고, STT 원문을 쭉 보여준 뒤, 정지 후 3개의 가능성을 선택할 수 있게 해주는 정적 웹앱입니다.

## 주요 기능

- `MediaRecorder`를 이용한 브라우저 오디오 녹음
- 지원 브라우저에서 `SpeechRecognition` / `webkitSpeechRecognition`으로 실시간 음성 인식
- 원문(STT) 표시 및 수동 수정 가능
- 원문을 보수 복원본, 균형 복원본, 정리 복원본으로 나눠서 제공
- 핵심 데모는 백엔드 없이 동작
- Node 내장 테스트 러너로 가벼운 순수 로직 테스트 제공

## 프로젝트 구성

- `index.html` — 앱 셸
- `styles.css` — 화면 스타일
- `src/app.js` — 브라우저 UI, live STT, 정지 후 3종 가능성 렌더링
- `src/ml.js` — 가능성 분류를 돕는 로컬 Naive Bayes 머신러닝 모델
- `src/rewrite.js` — 보수 복원본/균형 복원본/정리 복원본을 만드는 순수 재작성 로직
- `tests/rewrite.test.js` — 순수 로직 및 ML 보정 테스트
- `tests/markup.test.js` — 정적 마크업 스모크 테스트
- `server.js` — 로컬 미리보기용 정적 서버

## 요구 사항

- Node.js 20 이상 권장
- `MediaRecorder`를 지원하는 브라우저
- 실시간 STT를 쓰려면 `SpeechRecognition` 지원 브라우저 필요
- 지원이 없으면 원문을 직접 입력해도 동작

## 실행 방법

```bash
cd /Users/milkeon/workspace/pardon
npm test
npm start
```

그다음 터미널에 표시되는 로컬 주소를 여시면 됩니다. 보통 `http://localhost:4173`입니다.

## 사용 방법

1. **녹음 시작**을 누릅니다.
2. 마이크로 말을 합니다.
3. **원문 STT** 영역에서 원문을 확인합니다.
4. 정지하면 원문을 바탕으로 3가지 가능성이 생성됩니다.
5. 3개의 가능성 카드 중 하나를 눌러 선택합니다.
6. **선택한 문장 복사**로 선택한 문장을 클립보드에 복사합니다.

브라우저가 실시간 음성 인식을 지원하지 않으면, 텍스트 영역에 원문을 직접 붙여넣어도 됩니다. 가능성 카드는 그대로 동작합니다.

## 로컬 검증

순수 로직 테스트 실행:

```bash
npm test
```

정적 서버 실행:

```bash
npm start
```

## GitHub Pages 배포

이 프로젝트는 순수 정적 HTML/CSS/JS라서 GitHub Pages가 저장소 루트에서 바로 서비스할 수 있습니다.

1. `pardon` 이름의 GitHub 저장소를 만듭니다.
2. 이 프로젝트를 `main` 브랜치로 푸시합니다.
3. GitHub에서 **Settings → Pages**로 들어갑니다.
4. **Build and deployment**를 다음처럼 설정합니다.
   - Source: `Deploy from a branch`
   - Branch: `main`
   - Folder: `/ (root)`
5. 설정을 저장하고 Pages URL이 만들어질 때까지 기다립니다.

앱이 상대 경로 자산을 쓰기 때문에, 번들러 없이 저장소 루트에서 바로 동작합니다.

## 비고

- 재작성 로직은 데모가 API 키 없이도 동작하도록 의도적으로 결정적 방식과 로컬 ML 보정으로 구현했습니다.
- 3종 결과는 각각 보수 복원본, 균형 복원본, 정리 복원본입니다.
