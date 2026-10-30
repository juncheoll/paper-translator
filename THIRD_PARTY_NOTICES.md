# 구성 요소와 모델 이용 조건

Paper Translator는 [MouseTooltipTranslator](https://github.com/ttop32/MouseTooltipTranslator)의 PDF 확장 로직을 이관한 별도 제품입니다. 원본의 MIT License와 Copyright (c) 2020 sang won kim 고지를 LICENSE에 보존합니다. 일반 웹 번역·자막·음성·OCR 기능은 포함하지 않습니다.

## 소프트웨어

- PDF.js: Apache-2.0, public/pdfjs/LICENSE 및 배포본 pdfjs/LICENSE. 원본 헤더를 보존합니다. 이 프로젝트는 viewer.html의 제목·연결 스크립트를 수정하며, 이관한 viewer.mjs에는 파일 URL 검증 호출을 생략한 기존 수정이 있습니다. PDF 렌더러 자체를 새로 작성하지 않습니다.
- wllama 3.8.1 및 llama.cpp: MIT. 정적 워커 빌드 변환은 config/wllama-static-loader.js에 있습니다. 아래 전체 고지를 함께 배포합니다.
- ky: MIT, webextension-polyfill: MPL-2.0. 런타임 패키지 고지를 licenses/에 동봉합니다.
- Docling: MIT. 별도 Python 서비스로 설치하며 Python·PyTorch와 각 하위 의존성의 이용 조건을 따릅니다. 설치 요구사항은 tools/requirements-docling.txt에 고정합니다.
- 설치기 uv: MIT 또는 Apache-2.0. 공식 바이너리를 고정 SHA-256으로 확인합니다. 다운로드하는 Python 배포와 하위 패키지는 각자의 조건을 따릅니다.
- 안내 HTML 생성기 markdown-it: MIT, 개발 시에만 사용합니다.

전체 의존성과 버전은 package-lock.json 및 Python 요구사항에서 확인합니다. 번들에서 생성된 LICENSE.txt와 pdfjs 내부 라이선스를 제거하지 않습니다.

## 모델

모델 가중치는 배포 ZIP에 넣지 않습니다. 별도 다운로드·서버 제공에 대해서도 각 모델 이용 조건을 따라야 합니다.

| 모델 | 조건과 출처 |
|---|---|
| Hy-MT2 1.8B GGUF Q8 | [Tencent 모델 카드](https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF), Apache-2.0 |
| EmbeddingGemma 300M 및 GGUF 변환본 | [Gemma Terms of Use](https://ai.google.dev/gemma/terms), [금지된 사용 정책](https://ai.google.dev/gemma/prohibited_use_policy), [GGUF](https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF) |
| Docling Layout Heron | [모델 카드](https://huggingface.co/docling-project/docling-layout-heron), Apache-2.0 |

EmbeddingGemma의 호스팅 API 제공도 Gemma 약관 적용 대상입니다. 연구실 운영자는 사용·제공·재배포 조건을 확인하고 사용자에게 안내해야 합니다.

> Gemma is provided under and subject to the Gemma Terms of Use found at ai.google.dev/gemma/terms

고정 모델 리비전과 주소는 src/browser_ai/models.js 및 tools/docling_service.py에서 확인합니다. 서버의 모델 이름만으로 같은 가중치라고 가정하지 않습니다.

## 브라우저 추론 런타임의 전체 MIT 고지

브라우저 모델 런타임과 함께 배포할 고지입니다. npm 패키지와 자동 생성된 번들 라이선스 목록에서 이 고지가 빠질 수 있어 여기에 보존합니다. llama.cpp 리비전은 wllama `3.8.1` 태그의 서브모듈 참조를 기준으로 했습니다. 런타임을 업데이트하면 함께 확인하세요.

### wllama 3.8.1

출처: [고정 버전의 라이선스](https://github.com/ngxson/wllama/blob/3.8.1/LICENCE)

```text
MIT License

Copyright (c) 2024 Xuan Son NGUYEN

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### llama.cpp (wllama 3.8.1에 포함된 리비전)

출처: [고정 버전의 라이선스](https://github.com/ggml-org/llama.cpp/blob/46ca246de9bb1c35269722a6240d37d9dfd79cad/LICENSE)

```text
MIT License

Copyright (c) 2023-2026 The ggml authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
